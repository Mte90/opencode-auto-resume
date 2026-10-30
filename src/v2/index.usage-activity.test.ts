import { describe, test, expect, setDefaultTimeout } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "IndexUsageActivityTest"

/**
 * v2: token flow counts as activity.
 *
 * The watchdog measured silence purely from events, while token usage —
 * proof the model is generating — never touched the activity clock. A turn
 * pouring tokens for minutes straight still read as "no activity for 186s"
 * and drew a stall injection mid-generation (2026-10-13: three recoveries
 * into a 1.9M-token turn, each interrupting live work). Usage events with a
 * GROWING total now reset the clock; a flat total means nothing resumed and
 * does not.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sized for the parallel suite, not isolation (see busy-tools.test.ts). */
setDefaultTimeout(30_000)

const SID = "ses_usageactivity"
let counter = 71000

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

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: SID, ...data } })

const usage = (output: number) => ({
	input: 100,
	output,
	reasoning: 0,
	cache: { read: 0, write: 0 },
})

const BASE_OPTS = {
	chunkTimeoutMs: 100,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	maxRetries: 3,
	loopMaxContinues: 99,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	toolTextCheckDelayMs: 0,
	minActivityGapMs: 10,
	debug: false,
}

async function setup(history: unknown[], extraOpts: Record<string, unknown> = {}) {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...BASE_OPTS, registryScope: LOG_SALT, ...extraOpts },
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		tool: { transform: async () => {} },
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return {
		injected,
		cleanup,
		capture,
		push: async (type: string, data: Record<string, unknown> = {}) => {
			stream.push(ev(type, data))
			await wait(10)
		},
		teardown: () => {
			;(cleanup as (() => void) | undefined)?.()
			capture.stop()
		},
	}
}

const userTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - 60 * 60_000 },
	content: [{ type: "text", text: "keep going" }],
})

const assistantText = (text: string) => ({
	type: "assistant",
	id: "msg_a0",
	time: { created: Date.now() - 60_000 },
	content: [{ type: "text", text }],
})

describe("v2: token flow counts as activity", () => {
	test("growing usage holds the stall door shut", async () => {
		// Eight growing usage events across ~240ms: silence never exceeds ~30ms
		// against a 100ms chunk, so no stall may declare despite 4x the window
		// elapsing overall. Assistant text is present so the empty-idle nudge
		// stays out of it; the text is neutral so no pattern detector fires.
		const h = await setup([userTurn(), assistantText("Working on it.")])
		await h.push("session.execution.started")
		let total = 1000
		for (let i = 0; i < 8; i++) {
			total += 1000
			await h.push("session.usage.updated", { tokens: usage(total) })
			await wait(20)
		}
		h.capture.stop()
		await h.teardown()
		expect(h.injected).toEqual([])
	}, 20000)

	test("CONTROL: flat usage does not hold the door (nothing resumed)", async () => {
		// Same events, same cadence, total never moves: the clock goes stale
		// and the stall answers on schedule. This is what distinguishes the
		// gate from "any usage event resets".
		const h = await setup([userTurn(), assistantText("Working on it.")])
		await h.push("session.execution.started")
		for (let i = 0; i < 8; i++) {
			await h.push("session.usage.updated", { tokens: usage(1000) })
			await wait(20)
		}
		await wait(200)
		const count = h.injected.length
		h.capture.stop()
		await h.teardown()
		expect(count).toBeGreaterThanOrEqual(1)
	}, 20000)
})
