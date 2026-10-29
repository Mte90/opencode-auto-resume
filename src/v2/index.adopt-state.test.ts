import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexAdoptStateTest"

/**
 * v2: a successor setup inherits the watch map instead of starting blank.
 *
 * 2026-10-09: setup re-runs in-process on session attach/restore (bursts of
 * several setups/second, singles every ~25-40min — 138 supersedes on record
 * in one day). Every run disposed the last AND started with a blank sessions
 * map, so multi-minute stalls were unobservable and the busy session that
 * went quiet across a take-over never fired. Successors now adopt the
 * predecessor's map (stall clocks, ladders, latches); dispose only tears
 * down its own timers. Proof in prod: "adopted 1 watched session(s)".
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

const OPTIONS = {
	chunkTimeoutMs: 300,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	maxRetries: 3,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	// Under test: two setups in one process share the watch map, exactly
	// what prod opts in to. Without it the suite shares nothing and this
	// test cannot observe adoption.
	shareWatchState: true,
	debug: false,
	// No discovery sweep inside the test window: the point is map
	// inheritance across setups, not re-seeding from the session list.
	discoveryDelayMs: 60_000,
}

function makeCtx(stream: any, injected: Array<{ sid?: string; text?: string }>) {
	const capture = capturePluginLogs()
	return {
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT },
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [] }),
				message: { list: async () => [] },
			},
		},
		storage: {
			get: async () => ({ todos: [] }),
			set: async () => {},
			remove: async () => {},
		},
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [],
		},
		capture,
	}
}

describe("v2: successor setup adopts the watch map", () => {
	test("busy-quiet watch survives a take-over and still fires", async () => {
		const injected: Array<{ sid?: string; text?: string }> = []
		const stream1 = makeEventStream()
		const ctx1: any = makeCtx(stream1, injected)
		const cleanup1 = await (plugin as any).setup(ctx1)
		stream1.push(ev("session.execution.started", SID))
		await wait(50)
		// Second setup supersedes the first (same process, like a session
		// attach storm). No new events: the session stays busy-quiet.
		const stream2 = makeEventStream()
		const ctx2: any = makeCtx(stream2, injected)
		const cleanup2 = await (plugin as any).setup(ctx2)
		await wait(900)
		expect(injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		ctx1.capture.stop()
		ctx2.capture.stop()
		;(cleanup1 as (() => void) | undefined)?.()
		;(cleanup2 as (() => void) | undefined)?.()
	})
})
