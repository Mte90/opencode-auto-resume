import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexDuplicateProdTest"

/**
 * v2: cross-instance duplicate check (shared log).
 *
 * Ported from f99ddd8 (todo branch): stacked watchdogs (reload churn) each
 * hold private counters, so the in-memory skip cannot see a sibling's prod —
 * the session log can. If our exact text is already the newest user message
 * within the recency window, stand down. Fail-open: fetch problems mean
 * "no info", never "duplicate".
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_dup"

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

type Harness = {
	injected: Array<{ kind: string; text?: string }>
	logs: string[]
}

/** A turn that starts and then goes silent: a stall candidate. */
const busyStallEvents = [ev("session.execution.started")]

const FAST = {
	chunkTimeoutMs: 50,
	gracePeriodMs: 0,
	checkIntervalMs: 20,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	loopMaxContinues: 99,
	injectIntervalMs: 0,
}

async function replay(
	events: any[],
	opts: Record<string, unknown> = {},
	waitMs = 600,
	recentMessages: unknown[] | undefined = undefined,
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: { ...FAST, ...opts, debug: true, registryScope: LOG_SALT },
		session: {
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ kind: "synthetic", text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ kind: "prompt", text: a?.text }), {}),
		},
		client: {
			session: {
				get: async () => ({ data: {} }),
				message: {
					list: async () => ({ data: recentMessages ?? [], cursor: null }),
				},
			},
		},
		storage: {
			get: async () => ({ todos: [], updatedAt: Date.now() }),
			set: async () => {},
			remove: async () => {},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	const started = Date.now()
	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	while (Date.now() - started < waitMs) await wait(10)
	await wait(50)
	capture.stop()
	;(cleanup as (() => void) | undefined)?.()
	return { injected, logs: capture.lines }
}

const userMsg = (text: string, at: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	time: { created: at },
})

describe("v2: cross-instance duplicate check (shared log)", () => {
	test("a sibling's identical prod in the log suppresses ours", async () => {
		// Two stacked watchdogs, one session: the first instance's prod is a
		// user message in the log, so the second instance must stand down even
		// though its private counters know nothing.
		const { injected, logs } = await replay(
			busyStallEvents,
			{ maxRetries: 5, continuePrompt: "go" },
			900,
			[userMsg("go", Date.now())],
		)
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("identical prod already in session log"))).toBe(true)
	})

	test("a newer user message is progress, not a duplicate", async () => {
		const { injected } = await replay(
			busyStallEvents,
			{ maxRetries: 1, continuePrompt: "go" },
			600,
			[userMsg("actually, also this", Date.now())],
		)
		expect(injected.length).toBeGreaterThan(0)
	})

	test("a stale identical prod does not suppress", async () => {
		const { injected } = await replay(
			busyStallEvents,
			{ maxRetries: 1, continuePrompt: "go" },
			600,
			[userMsg("go", Date.now() - 10 * 60_000)],
		)
		expect(injected.length).toBeGreaterThan(0)
	})
})
