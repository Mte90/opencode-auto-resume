import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. */
const LOG_SALT = "IndexLadderDeliveryGateTest"

/**
 * v2: a rung is only consumed by a prompt that actually lands.
 *
 * ses_eae46bb9 (2026-10-19): the session's first visible stall prod read
 * "attempt 2/3" with no "1/3" ever delivered. The inject at 18:43:54 was armed
 * as attempt 1 and then declined one second later ("still busy and live at
 * inject time" — the provider's own retry had revived the session), but
 * `recover()` had already incremented `resumeAttempts` at detection, and no
 * path ever decrements it. The next stall therefore climbed to 2/3. Counting
 * happens at detection, delivery happens in the timer: the two must agree.
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
			// Parked: no silence stall may interleave with the failure stalls
			// under test (every inject here is failure-driven by construction).
			chunkTimeoutMs: 600_000,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			// Wide enough that the armed inject can be declined before it fires.
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

const FAIL = { error: { type: "provider.invalid-request", message: "Error from the provider: 400 Bad Request" } }

describe("v2: a declined inject must not consume a ladder rung", () => {
	test("the rung survives a busy/live decline — the next delivery still reads 1/3", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		// Stall #1: armed as attempt 1/3, and the session goes live again before
		// the timer fires (the provider's own retry moving it, in the incident).
		push(h, "session.step.failed", SID, FAIL)
		await wait(50)
		push(h, "session.step.started", SID, { agent: "build" })
		await waitFor(() => h.capture.lines.join("\n").includes("still busy and live at inject time"), 2000)
		const afterDecline = h.injected.length
		// Stall #2: nothing else happened, so this must still be the FIRST rung.
		push(h, "session.step.failed", SID, FAIL)
		await waitFor(() => h.injected.length > afterDecline, 3000)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		const logs = h.capture.lines.join("\n")
		await teardown(h)
		expect(afterDecline).toBe(0) // the declined fire delivered nothing
		expect(attempts).toEqual(["1"]) // pre-fix this read ["2"]: the phantom rung
		expect(logs).toContain("rung not consumed")
	})

	test("a delivered failure stall still climbs the ladder", async () => {
		// Guard against over-correcting: delivery-gating must not flatten the
		// ladder for stalls that really do get prodded.
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		push(h, "session.step.failed", SID, FAIL)
		await waitFor(() => h.injected.length >= 1)
		push(h, "session.step.failed", SID, FAIL)
		await waitFor(() => h.injected.length >= 2)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		await teardown(h)
		expect(attempts.slice(0, 2)).toEqual(["1", "2"])
	})
})
