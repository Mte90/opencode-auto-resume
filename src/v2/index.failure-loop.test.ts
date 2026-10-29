import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexFailureLoopTest"

/**
 * v2: consecutive failure recoveries with no model output stand down.
 *
 * ses_ede801ca (2026-10-09): backend down, every injected continue produced
 * the next failure — provider retries #2-11, step.failed, stall 1/3, retries,
 * step.failed, stall 2/3… The ladder cycled 1/3, 2/3, 3/3, gaveUp,
 * abort+resume, 1/3… forever, one user-visible prod per ~90s cycle, because
 * every injection manufactures the failure the next one answers. Past three
 * consecutive failure-driven recoveries with zero model output between them,
 * the session stands down until a genuine turn or fresh output — and neither
 * our own injections nor markBusy clear it, or the loop that set it would
 * clear it too.
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
const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const fail = { error: { type: "provider.internal", message: "upstream command exited prematurely" } }

async function setup(): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			// High chunk timeout: the silence path must not interleave here.
			// What this pins is failure stalls only; with a 50ms window every
			// driven failure is followed by a silence stall and the counts
			// mix two mechanisms.
			chunkTimeoutMs: 600_000,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 9,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,

			debug: true,
		},
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return {
		injected,
		cleanup,
		capture,
		streamRef: stream,
		logs: () => capture.lines.join("\n"),
	}
}

async function teardown(h: any, keepLog = false) {
	;(h.cleanup as (() => void) | undefined)?.()
	if (!keepLog) h.capture.stop()
}

async function driveFailure(h: any) {
	push(h, "session.step.failed", SID, fail)
	await wait(120)
}

describe("v2: failure loops stand down", () => {
	test("three consecutive failure recoveries, then silence with the latch logged", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		for (let i = 0; i < 6; i++) await driveFailure(h)
		const n = h.injected.length
		const log = h.logs()
		await teardown(h)
		// Three recoveries fire (bounded), then the latch stands down: three
		// more failures produce nothing further.
		expect(n).toBe(3)
		expect(log).toContain("standing down until a genuine turn")
	})

	test("CONTROL: model output between failures keeps recovery alive", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		await driveFailure(h)
		await driveFailure(h)
		// Model speaks: the consecutive count resets.
		push(h, "session.text.delta", SID, { assistantMessageID: "m1", delta: "back online, continuing" })
		await wait(50)
		await driveFailure(h)
		await driveFailure(h)
		await driveFailure(h)
		const n = h.injected.length
		const log = h.logs()
		await teardown(h)
		// 2 before the text + 3 after = 5; the latch never fires mid-sequence.
		expect(n).toBe(5)
		expect(log).not.toContain("standing down until a genuine turn")
	})

	test("CONTROL: a genuine turn clears a latched loop", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		for (let i = 0; i < 4; i++) await driveFailure(h)
		expect(h.logs()).toContain("standing down until a genuine turn")
		const before = h.injected.length
		// Fresh user turn (model changed / backend back): latch releases.
		// Two starts: the first spends our own selfRecovery flag, the second
		// reads as the genuine turn.
		push(h, "session.execution.started", SID)
		await wait(20)
		push(h, "session.execution.started", SID)
		await wait(20)
		await driveFailure(h)
		const n = h.injected.length
		await teardown(h)
		expect(n).toBeGreaterThan(before)
	})
})
