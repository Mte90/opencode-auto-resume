import { describe, test, expect } from "bun:test"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: a turn parked on a tool result that never arrives gets a nudge.
 *
 * ses_edf403f5 (2026-10-09): model hit max context, called `compress` at
 * 13:09:44, turn ended 2s later, idle ever since — the call stuck at status
 * "streaming" with no result. ses_ee14d727: same shape with a `write` left
 * streaming. In both cases the plugin read healthy-idle (pendingTools === 0,
 * no failure, no stall) and stayed silent.
 *
 * The event-counted pendingTools only sees what the plugin observed live, so
 * this reads the history instead: unfinished tool parts (anything but
 * completed/error) newer than the last user message and older than the stall
 * window mean the turn is parked, not done.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 17000

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

const toolPart = (id: string, name: string, status: string, at: number) => ({
	type: "tool",
	id,
	name,
	time: { created: at },
	state: { status, input: {} },
})

const assistantWith = (at: number, ...content: unknown[]) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text: "Working on it." }, ...content],
})

async function setup(history: unknown[], opts: { chunkTimeoutMs?: number } = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-stucktool-${process.pid}-${counter++}.log`)
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

async function goIdle(h: any) {
	for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
		h.streamRef.push(ev(e, SID))
		await wait(10)
	}
	await wait(300)
}

const stuckNudges = (h: any) => h.injected.filter((i: any) => /never returned a result/.test(i.text ?? ""))

describe("v2: turns parked on an unanswered tool call", () => {
	test("a streaming compress call earns a proceed-without-it nudge", async () => {
		const h = await setup([
			userMessage("do the sync job", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "compress", "streaming", OLD + 2000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"compress"')
	})

	test("a running write call earns one too", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "write", "running", OLD + 2000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"write"')
	})

	test("CONTROL: settled calls get nothing", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "write", "completed", OLD + 2000)),
			assistantWith(OLD + 3000, toolPart("call_2", "shell", "error", OLD + 4000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a fresh call has not had a chance to answer yet", async () => {
		// Production-scale window: a call seconds old is live, not stuck. (With
		// the 50ms test default every fixed timestamp ages past the cutoff
		// during goIdle, so this CONTROL needs its own window.)
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 1000),
				assistantWith(now - 500, toolPart("call_1", "shell", "running", now - 500)),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a user message after the call means the turn moved on", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "shell", "running", OLD + 2000)),
			userMessage("never mind, do this instead", OLD + 5000),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("the nudge names the tool and tells the model not to retry it", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "compress", "streaming", OLD + 2000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain("do not retry the same call")
	})
})
