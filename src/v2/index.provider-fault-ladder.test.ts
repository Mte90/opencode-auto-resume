import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE — see index.attempt-reset.test.ts for why. */
const LOG_SALT = "IndexProviderFaultLadderTest"

/**
 * v2: a stall the provider is already retrying is not a model stall.
 *
 * ses_eae46bb9 (2026-10-19): three `provider.transport` ECONNRESETs, each
 * immediately followed by opencode's own `session.retry.scheduled` ("provider
 * retry #2"), drove the ladder 1/3 -> 2/3 -> restart -> 1/3. The plugin was
 * counting a transport fault as model unresponsiveness and climbing toward
 * gaveUp, which is terminal silence: the sweep is gated on `!gaveUp` and only a
 * genuine user message clears it. A scheduled retry means the provider is
 * already recovering the turn, so the rung must hold and the ladder must never
 * give up — the nudge still fires (a dead stream needs waking), it just does
 * not escalate.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

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
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: 600_000,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 100,
			maxBackoffMs: 200,
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
	h.capture.stop()
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

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

// The exact recorded failure shape: ECONNRESET while reading the stream, which
// opencode answers with its own provider retry.
const ECONNRESET = {
	error: {
		type: "provider.transport",
		message:
			"Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.",
	},
}

const retryScheduled = (h: any, attempt = 2) =>
	push(h, "session.retry.scheduled", SID, { ...ECONNRESET, attempt })

describe("v2: a provider-scheduled retry holds the ladder and never gives up", () => {
	test("consecutive provider-fault stalls stay on the same rung", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		retryScheduled(h)
		await wait(10)
		push(h, "session.step.failed", SID, ECONNRESET)
		await waitFor(() => h.injected.length >= 1)
		retryScheduled(h)
		await wait(10)
		push(h, "session.step.failed", SID, ECONNRESET)
		await waitFor(() => h.injected.length >= 2)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		await teardown(h)
		// Pre-fix this climbed to ["1","2"] and could then latch gaveUp.
		expect(attempts.slice(0, 2)).toEqual(["1", "1"])
		expect(h.capture.lines.join("\n")).toContain("provider-fault stall")
		expect(h.capture.lines.join("\n")).not.toContain("giving up after")
	})

	test("the nudge still fires — holding the rung is not silence", async () => {
		// The failure path that stops prodding is worse than a wrong number:
		// assert a real prompt reached the session on every provider-fault stall.
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		retryScheduled(h)
		await wait(10)
		push(h, "session.step.failed", SID, ECONNRESET)
		await waitFor(() => h.injected.length >= 1)
		const first = h.injected[0]?.text ?? ""
		await teardown(h)
		expect(first).toContain("continue")
	})
})
