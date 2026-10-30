import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexBusyToolsTest"

/**
 * v2: the busy-stall path defers while tools are still running.
 *
 * A `write` or `compress` running several minutes emits no events, so
 * event-silence accrues past the chunk timeout and the injection below
 * interrupts the live call ("Tool execution interrupted: write" — observed
 * 2026-10-11, three times on one 9am run). The plugin could not tell "tool
 * running long" from "turn dead".
 *
 * Rule, in the watchdog's skip-chain next to the shell/subagent/user guards:
 * a tool younger than the stuck age gate defers; older than the gate is
 * wedged and the stall answers normally. Exempt names (default: compress)
 * are never interrupted while fresh — interrupting a compress risks
 * half-compacted state, the same reason compaction itself is never
 * interrupted — with the same stale-TTL escape when one wedges for real.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Budgets sized for the environment, not for isolation: `bun test` runs 79
 * files in parallel and these tests wait out real chunk timeouts, so a
 * condition that resolves in milliseconds alone can take seconds of wall
 * clock under contention.
 */
setDefaultTimeout(30_000)

const SID = "ses_busytools"

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

const BASE_OPTS = {
	chunkTimeoutMs: 50,
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
	debug: false,
}

async function setup(extraOpts: Record<string, unknown> = {}) {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...BASE_OPTS, registryScope: LOG_SALT, ...extraOpts },
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
		tool: { transform: async () => {} },
	}
	const cleanup = await (plugin as any).setup(ctx)
	return {
		injected,
		cleanup,
		push: async (type: string, data: Record<string, unknown> = {}) => {
			stream.push(ev(type, data))
			await wait(10)
		},
		capture,
		teardown: () => {
			;(cleanup as (() => void) | undefined)?.()
			capture.stop()
		},
	}
}

describe("v2: busy stall defers while tools run", () => {
	test("CONTROL: silent busy session with no tools still recovers", async () => {
		const h = await setup()
		await h.push("session.execution.started")
		await wait(300)
		await h.teardown()
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	}, 20000)

	test("a young write call defers the stall", async () => {
		// stuckToolAgeMs 5000: at 300ms the call is fresh, so every sweep in
		// the window must defer even though silence (300ms) is past the 50ms
		// chunk timeout several times over.
		const h = await setup({ stuckToolAgeMs: 5000 })
		await h.push("session.execution.started")
		await h.push("session.tool.called", { tool: "write", id: "call_1" })
		await wait(300)
		await h.teardown()
		expect(h.injected).toEqual([])
	}, 20000)

	test("a write call older than the age gate still recovers (wedged)", async () => {
		// stuckToolAgeMs 120: early sweeps defer (age < gate), then the call
		// ages past it and the stall answers. Both halves in one run.
		const h = await setup({ stuckToolAgeMs: 120 })
		await h.push("session.execution.started")
		await h.push("session.tool.called", { tool: "write", id: "call_1" })
		await wait(400)
		await h.teardown()
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	}, 20000)

	test("compress is exempt even when older than the age gate", async () => {
		// stuckToolAgeMs 120, call aged 400ms: a normal tool would have fired
		// (previous test). Compress must not — only the 30-minute stale TTL
		// releases it, which no test waits out.
		const h = await setup({ stuckToolAgeMs: 120 })
		await h.push("session.execution.started")
		await h.push("session.tool.called", { tool: "compress", id: "call_9" })
		await wait(400)
		await h.teardown()
		expect(h.injected).toEqual([])
	}, 20000)

	test("neverInterruptTools: [] puts compress back under the age gate", async () => {
		// Configurability pin: with the exemption emptied, an old compress
		// recovers like any other wedged tool.
		const h = await setup({ stuckToolAgeMs: 120, neverInterruptTools: [] })
		await h.push("session.execution.started")
		await h.push("session.tool.called", { tool: "compress", id: "call_9" })
		await wait(400)
		await h.teardown()
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	}, 20000)

	test("a finished tool stops deferring", async () => {
		// Call, then success well inside the gate: the map entry is removed
		// and the stall answers on schedule.
		const h = await setup({ stuckToolAgeMs: 5000 })
		await h.push("session.execution.started")
		await h.push("session.tool.called", { tool: "write", id: "call_1" })
		await h.push("session.tool.success", { id: "call_1" })
		await wait(300)
		await h.teardown()
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	}, 20000)
})
