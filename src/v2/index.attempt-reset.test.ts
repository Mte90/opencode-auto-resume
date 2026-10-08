import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: model progress between stalls restarts the attempt ladder.
 *
 * ses_ee7dade1 (2026-10-07): "attempt 1/3" then model work, then
 * "attempt 2/3" — the ladder kept counting across a productive interval.
 * resumeAttempts reset only on busy-cycle transitions, so mid-turn progress
 * never restarted it. A stall after fresh model output is a NEW episode and
 * must read "attempt 1/3" again; only consecutive silent prods climb toward
 * gaveUp. (Rich texts embed the attempt number, so episode boundaries are
 * directly observable in the transcript.)
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 11000

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

async function setup(): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-attemptreset-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 50,
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
			debug: false,
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
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const attemptOf = (text: string | undefined): string | null => {
	const m = /attempt (\d)\/3/.exec(text ?? "")
	return m ? m[1] : null
}

describe("v2: model progress between stalls restarts the attempt ladder", () => {
	test("fresh assistant text restarts the ladder at 1/3", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		// Delta lands after attempt 1 but before the budget burns out,
		// so a later attempt can observe the progress.
		await wait(130)
		// Model produces text (progress, no completion), then goes quiet.
		push(h, "session.text.delta", SID, { assistantMessageID: "m1", delta: "new findings from the probe" })
		await wait(400)
		await teardown(h)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		expect(attempts.length).toBeGreaterThanOrEqual(2)
		// A second "1/3" means a new episode started after model progress.
		expect(attempts.filter((a: string | null) => a === "1").length).toBeGreaterThanOrEqual(2)
	})

	test("CONTROL: silence without progress keeps climbing", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		await wait(650)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		expect(attempts.length).toBeGreaterThanOrEqual(2)
		expect(attempts[attempts.length - 1]).not.toBe("1")
		await teardown(h)
	})
})
