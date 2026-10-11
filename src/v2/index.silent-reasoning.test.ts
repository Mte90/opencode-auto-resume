import { describe, test, expect } from "bun:test"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexSilentReasoningTest"

/**
 * v2: reasoning-only turns with no output get a nudge.
 *
 * ses_edd1eb519 / ses_edd1e39c3 (2026-10-09): a user question each, then one
 * assistant turn of pure reasoning (zero text, zero tool calls), then idle
 * 10+ minutes. No failure fires, the stall path needs a busy session, and the
 * targeted patterns need text — so every event-driven path reads healthy-idle
 * and stays silent. Only the total void counts: any text or any tool part
 * since the last user message means produced or delegated.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 21000

function makeEventStream() {
	const queue: any[] = []
	const waiters: ((ev: any) => void)[] = []
	let closed = false
	const stream = {
		push(ev: any) {
			if (waiters.length) waiters.shift()!(ev)
			else queue.push(ev)
		},
		close() {
			closed = true
			while (waiters.length) waiters.shift()!(null)
		},
		subscribe: () => stream,
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((resolve) => {
						if (queue.length) return resolve({ value: queue.shift(), done: false })
						if (closed) return resolve({ value: undefined, done: true })
						waiters.push((ev) =>
							resolve(ev === null ? { value: undefined, done: true } : { value: ev, done: false }),
						)
					}),
				return: () => {
					closed = true
					return Promise.resolve({ value: undefined, done: true })
				},
			}
		},
	}
	return stream
}

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: sid, ...data } })
const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const OLD = Date.now() - 3600_000
const TOOLS = [{ id: "read" }, { id: "write" }, { id: "shell" }, { id: "task_complete" }]

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const reasoningMessage = (at: number, ...extra: unknown[]) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "reasoning", text: "Let me think about the weather over Smiths Station for the coming week." }, ...extra],
})

const textPart = (text: string) => ({ type: "text", text })
const toolPart = (id: string, name: string, status: string) => ({
	type: "tool",
	id,
	name,
	time: { created: OLD },
	state: { status, input: {} },
})

async function setup(history: unknown[], opts: { chunkTimeoutMs?: number } = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-silreason-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 50,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			logFile,
			debug: true,
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => TOOLS,
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const nudges = (h: any) => h.injected.filter((i: any) => /no visible output/.test(i.text ?? ""))

describe("v2: reasoning-only turns with no output", () => {
	test("a reasoning void after a user question earns a continue nudge", async () => {
		const h = await setup([userMessage("find the weather", OLD), reasoningMessage(OLD + 1000)])
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(300)
		const said = nudges(h)
		await teardown(h)
		expect(said.length).toBeGreaterThanOrEqual(1)
		expect(said[0].text).toContain("Continue the task")
	})

	test("the watchdog sweep revisits an already-parked session", async () => {
		// No second idle event is ever pushed: the history is fresh at the only
		// idle transition (structural passes), then ages out with zero further
		// events. Any nudge must come from the sweep, not the event path.
		const now = Date.now()
		const h = await setup([userMessage("find the weather", now - 1000), reasoningMessage(now - 10)])
		push(h, "session.idle", SID)
		await wait(400)
		const said = nudges(h)
		await teardown(h)
		expect(said.length).toBeGreaterThanOrEqual(1)
	})

	test("CONTROL: a turn with text gets nothing", async () => {
		const h = await setup([
			userMessage("find the weather", OLD),
			{
				type: "assistant",
				id: "msg_a_t",
				time: { created: OLD + 1000 },
				content: [{ type: "reasoning", text: "Thinking." }, textPart("Sunny all week.")],
			},
		])
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(300)
		const said = nudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a turn with tool calls gets nothing", async () => {
		const h = await setup([
			userMessage("find the weather", OLD),
			{
				type: "assistant",
				id: "msg_a_t",
				time: { created: OLD + 1000 },
				content: [{ type: "reasoning", text: "Thinking." }, toolPart("call_1", "shell", "completed")],
			},
		])
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(300)
		const said = nudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a fresh reasoning turn is not judged parked yet", async () => {
		// Production-scale window: under it, a seconds-old turn is live.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("find the weather", now - 1000),
				reasoningMessage(now - 500),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(200)
		const said = nudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})
})
