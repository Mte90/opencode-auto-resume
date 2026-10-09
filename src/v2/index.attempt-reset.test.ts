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
			// Without this the test writes into the PRODUCTION log, where a run is
			// indistinguishable from a reload storm.
			logFile,
			debug: true,
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

/**
 * Wait for a condition instead of sleeping a guessed interval. This test
 * used fixed waits and passed 3/3 in isolation while failing under
 * full-suite load — exactly the flake that trains you to ignore a red suite.
 */
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

describe("v2: model progress between stalls restarts the attempt ladder", () => {
	test("fresh assistant text restarts the ladder at 1/3", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		// Wait for the first nudge, then land the delta while the ladder is still
		// climbing. Ordering is the thing under test, so wait on events rather
		// than on wall-clock guesses.
		await waitFor(() => h.injected.length >= 1)
		// Model produces text (progress, no completion), then goes quiet.
		push(h, "session.text.delta", SID, { assistantMessageID: "m1", delta: "new findings from the probe" })
		await waitFor(() => h.injected.length >= 2)
		await teardown(h)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		expect(attempts.length).toBeGreaterThanOrEqual(2)
		// A second "1/3" means a new episode started after model progress.
		expect(attempts.filter((a: string | null) => a === "1").length).toBeGreaterThanOrEqual(2)
	})

	test("tool completions alone do not restart the ladder", async () => {
		// ses_edf403f5, 2026-10-09: three dead-stream stalls 60s apart all read
		// 1/3 because a tool completion sat between each pair. A completion with
		// no model text is the stall loop wearing a hat, not a new episode —
		// counting it makes gaveUp unreachable. Only text growth restarts.
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		await waitFor(() => h.injected.length >= 1)
		push(h, "session.tool.success", SID, { tool: "shell", id: "call_9" })
		await waitFor(() => h.injected.length >= 2)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		await teardown(h)
		expect(attempts.slice(0, 2)).toEqual(["1", "2"])
	})

	test("CONTROL: silence without progress keeps climbing across injections", async () => {
		// The regression this pins: after a successful stall injection the session
		// is idle again when the next stall timer fires, so markBusy transitions it
		// to busy and zeroed resumeAttempts — every stall read 1/3 and the ladder
		// never climbed (ses_ee14d727, 2026-10-09: two occurrences, both 1/3).
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		await wait(650)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		await teardown(h)
		expect(attempts.length).toBeGreaterThanOrEqual(2)
		expect(attempts[attempts.length - 1]).not.toBe("1")
		// And it must have grown, not repeated: 1/3 then 2/3 (or deeper).
		expect(attempts.some((a: string | null) => a === "2")).toBe(true)
	})

	test("the stall message carries a timestamp and idle duration", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(250)
		const text = h.injected[0]?.text ?? ""
		await teardown(h)
		expect(text).toContain("idle ")
		expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
	})

	test("no-activity stalls state the silence once, not twice", async () => {
		// (no activity for 188s; ... idle 3m 9s) prints the same duration twice.
		// The reason already says it, so the idle field is dropped for exactly
		// this reason shape; anything else keeps both fields.
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(250)
		const text = h.injected[0]?.text ?? ""
		await teardown(h)
		expect(text).not.toMatch(/no activity for \d+s[^;]*;[^;]*idle/)
		expect(text).toContain("idle ")
	})

	test("failure stalls carry no idle field at all", async () => {
		// A failure just happened: "idle 2s" next to the reason is noise, not
		// news. Reason + attempt + timestamp only.
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.failed", SID, {
			error: { type: "provider.invalid-request", message: "Error from the provider: 400 Bad Request" },
		})
		await wait(400)
		const text = h.injected[0]?.text ?? ""
		await teardown(h)
		expect(text).toContain("session.step.failed")
		expect(text).not.toContain("idle ")
		expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
	})

})
