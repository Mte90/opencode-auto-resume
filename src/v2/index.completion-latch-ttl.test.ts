/**
 * Regression: a SOFT completion latch must not outlive the work.
 *
 * ses_e72df2be9ffe (2026-10-30): a turn ended with a stop phrase while its todo
 * list read zero-open at that instant (a todo-set race, the work was not done).
 * The text heuristic latched completion and the only thing that could clear it
 * was a genuine user message — so the session sat silent for 20+ minutes while
 * the model kept working, and the "stand-down" needed a human to un-latch it.
 *
 * The split this pins:
 *   HARD latch  — task_complete tool, or a literal trailing `TASK COMPLETE`.
 *                 Never expires; a session that really finished stays quiet.
 *   SOFT latch  — stop phrase / done claim / celebration inferred from prose.
 *                 Re-opens ONCE after `completionLatchTtlMs` with no genuine
 *                 user message, so it gets a single self-check instead of
 *                 silence. `latchReopened` makes it one-shot: not a nag loop.
 */
import { describe, test, expect, setDefaultTimeout } from "bun:test"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
setDefaultTimeout(45_000)

const LOG_SALT = "IndexCompletionLatchTtlTest"
const SID = "ses_latch_ttl"
/** Short enough to observe in a test, long enough that latching still happens first. */
const TTL_MS = 300


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
	const ctx: any = {
		// Upstream's version guard: the v2 bundle aborts setup when the host does
		// not expose `app.version` (it assumes a v1 server).
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			// Small so a re-opened latch turns into a visible self-check: after
			// `completionLatchTtlMs` the stall gate must actually fire, not just
			// clear the flag and wait out a 10-minute silence window.
			chunkTimeoutMs: 500,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 1,
			loopMaxContinues: 1,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			completionLatchTtlMs: TTL_MS,
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
	return { injected, cleanup, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
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

describe("v2: completion latch TTL — soft re-opens once, hard never", () => {
	test("a soft latch (stop phrase) re-opens after the TTL and draws a self-check", async () => {
		const ack = "All set. Nothing to do."
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		// Latched: nothing yet, the TTL has not elapsed.
		expect(continues(h)).toHaveLength(0)
		await wait(TTL_MS + 600)
		const said = continues(h)
		await teardown(h)
		expect(said.length).toBeGreaterThan(0)
	})

	test("the re-open is one-shot — it does not keep nudging", async () => {
		const ack = "Nothing pending from me."
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		await wait(TTL_MS + 600)
		const afterFirst = continues(h).length
		expect(afterFirst).toBeGreaterThan(0)
		await wait(TTL_MS * 4)
		const afterSecond = continues(h).length
		await teardown(h)
		expect(afterSecond).toBe(afterFirst)
	})

	test("CONTROL: a hard latch (literal trailing TASK COMPLETE) never re-opens", async () => {
		const ack = ["Shipped it, verified the log line.", "", "TASK COMPLETE"].join("\n")
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		await wait(TTL_MS + 1200)
		const said = continues(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})
})
