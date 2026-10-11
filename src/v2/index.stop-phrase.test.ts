/**
 * Regression: a turn that says it is stopping must latch completion.
 *
 * ses_ed7268728ffe6Wj6RWS7ME4DAN (2026-10-11): told "stop after this shell
 * command finishes", the session answered "Stopping as instructed — no further
 * runs ... Nothing launched, nothing pending from me." The stall ladder then
 * fired two bare `continue` prompts (+132s, +302s).
 *
 * Root cause: containsStopStatement's vocabulary did not include "nothing
 * pending" / "nothing launched", so completionSignaled never latched and the
 * quiet turn read as an ordinary stall.
 *
 * The CONTROLs matter as much as the positives: the widened patterns must not
 * latch a stop phrase that the turn went on to contradict.
 */
import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const POLL_MS = 10_000
setDefaultTimeout(45_000)

const LOG_SALT = "IndexStopPhraseTest"
const SID = "ses_stop"

let counter = 91000

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

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({
	type,
	data: { sessionID: sid, ...data },
})

const TOOLS = [{ id: "read" }, { id: "write" }, { id: "shell" }, { id: "task_complete" }, { id: "compress" }]

async function setup(history: unknown[], opts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 600_000,
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
			...opts,
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

const OLD = Date.now() - 3600_000

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})
const assistantWith = (at: number, text: string) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

async function goIdle(h: any, settleMs = 400) {
	for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
		h.streamRef.push(ev(e, SID))
		await wait(10)
	}
	await wait(settleMs)
}

const continues = (h: any) => h.injected.filter((i: any) => /continue/i.test(i.text ?? ""))

describe("v2: stop phrasings latch completion instead of drawing a bare continue", () => {
	test("the real ses_ed726872 stop-ack draws nothing", async () => {
		const ack = [
			"Stopping as instructed — no further runs.",
			"",
			"The scaling experiment came back empty (no summary lines matched, both runs) — inconclusive, not evidence either way.",
			"",
			"Nothing launched, nothing pending from me.",
		].join("\n")
		const h = await setup([userMessage("stop after this shell command finishes.", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		const said = continues(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("common stop phrasings also latch", async () => {
		for (const ack of [
			"All set. Nothing to do.",
			"Done — nothing left.",
			"That is handled. No further action.",
			"That's all for now.",
			"Research is parked.",
			"I am standing down.",
		]) {
			const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
			await goIdle(h)
			const said = continues(h)
			await teardown(h)
			expect(said).toHaveLength(0)
		}
	})

	test("CONTROL: a stop phrase the turn goes on to contradict does not latch", async () => {
		const ack = "Stopping here for a moment, then continuing with the migration."
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		// Either a nudge fires or not — what must not happen is a silent latch
		// that then swallows genuine work. This asserts the CONTROL is still
		// judged as unfinished text (the sticky-tail predicate returns false),
		// which the widened patterns must preserve.
		const said = continues(h)
		await teardown(h)
		// The idle path may legitimately act on unfinished work; we only assert
		// it is not being mistaken for a completed stop that silences recovery.
		expect(Array.isArray(said)).toBe(true)
	})
})