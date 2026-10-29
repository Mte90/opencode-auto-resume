import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "IndexReplayEae46bb9Test"

/**
 * v2 replay of ses_eae46bb9effeYI09ys4UflpjxM (2026-10-19, log
 * ~/.local/state/opencode-v2/auto-resume.log). The recorded sequence the user
 * reported as "2/3 before resetting to 1/3, where was the 1/3?":
 *
 *   18:15:26  stall (no activity)          -> delivered "attempt 1/3"
 *   18:43:54  ECONNRESET + provider retry  -> armed "attempt 1/3", DECLINED
 *             ("still busy and live at inject time" — the provider's own retry
 *             had revived the session 31ms later). Nothing was delivered, but
 *             the rung had already been counted.
 *   18:44:29  ECONNRESET + provider retry  -> delivered "attempt 2/3"
 *   18:44:56  ECONNRESET + provider retry  -> text growth restarted the ladder
 *             -> delivered "attempt 1/3"
 *
 * So the first visible prod was 2/3 with no 1/3 before it, and the ladder
 * climbed a fault opencode was already retrying. This replay asserts the
 * fixed reading: every prod is 1/3, the declined cycle delivers nothing, and
 * the ladder never runs out on a transient provider fault.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_eae46bb9effeYI09ys4UflpjxM"

let counter = 23000

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

async function setup(extraOpts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			// Parked so only the recorded failure stalls can prod (the incident's
			// 186s silence stalls cannot be reproduced in a test budget; the state
			// they leave behind — our own prod as the newest user-side message —
			// is what the replay needs, and the pre-fire below establishes it).
			chunkTimeoutMs: 600_000,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 150,
			maxBackoffMs: 300,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			debug: true,
			...extraOpts,
		},
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
				message: { list: async () => [] },
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))
const readLog = (h: any) => h.capture.lines.join("\n")

async function waitFor(what: () => boolean, budgetMs = 3000): Promise<boolean> {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (what()) return true
		await wait(10)
	}
	return what()
}

const attemptOf = (text: string | undefined): string | null => {
	const m = /attempt (\d)\/3/.exec(text ?? "")
	return m ? m[1] : null
}

const FAIL = { error: { type: "provider.invalid-request", message: "Error from the provider: 400 Bad Request" } }

// Verbatim shape of the three recorded failures.
const ECONNRESET = {
	error: {
		type: "provider.transport",
		message:
			"Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.",
	},
}
const retryScheduled = (h: any) => push(h, "session.retry.scheduled", SID, { ...ECONNRESET, attempt: 2 })

describe("v2 replay: ses_eae46bb9 — ECONNRESET cycles must read 1/3 and 1/3", () => {
	test("the phantom 2/3 is gone and the ladder survives the provider fault", async () => {
		const h = await setup()
		// Pre-incident episode (18:15:26): one delivered prod.
		push(h, "session.execution.started", SID)
		await wait(20)
		push(h, "session.step.failed", SID, FAIL)
		await waitFor(() => h.injected.length >= 1)
		expect(attemptOf(h.injected[0]?.text)).toBe("1")

		// Cycle 1 (18:43:54): the armed prod is declined — the provider retry
		// moved the session 31ms after the failure.
		retryScheduled(h)
		push(h, "session.step.failed", SID, ECONNRESET)
		await wait(40)
		push(h, "session.step.started", SID, { agent: "build" })
		await waitFor(() => readLog(h).includes("still busy and live at inject time"), 2000)
		const afterCycle1 = h.injected.length

		// Cycle 2 (18:44:29).
		retryScheduled(h)
		push(h, "session.step.failed", SID, ECONNRESET)
		await waitFor(() => h.injected.length > afterCycle1, 3000)

		// Cycle 3 (18:44:56): the stream had emitted text before the socket died
		// — in the original this restarted the ladder, printing 1/3 straight
		// after 2/3.
		push(h, "session.text.delta", SID, { assistantMessageID: "m1", delta: "partial answer before the socket died" })
		await wait(20)
		retryScheduled(h)
		push(h, "session.step.failed", SID, ECONNRESET)
		await waitFor(() => h.injected.length > afterCycle1 + 1, 3000)

		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		const logs = readLog(h)
		await teardown(h)

		expect(afterCycle1).toBe(1) // the declined cycle delivered nothing
		expect(attempts).not.toContain("2") // no phantom rung
		expect(attempts).toEqual(["1", "1", "1"]) // and no escalating on a fault
		expect(logs).toContain("rung not consumed")
		expect(logs).toContain("provider-fault stall")
		expect(logs).not.toContain("giving up after")
	})
})
