import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. */
const LOG_SALT = "IndexOwnPromptReloadTest"

/**
 * v2: our own stall prompt must never read as a genuine user message.
 *
 * ses_ea0141a1bffeX189yxDLHl1QDU (2026-10-21): five consecutive stalls, every
 * one of them "attempt 1/3 (retry #1)". The plugin log showed why:
 *
 *   new user message — restarting the stall ladder
 *   text growth since last prod — restarting the stall ladder
 *   stall detected (no activity for 185s) — resume attempt 1/3
 *
 * The "new user message" line is the bug. The newest user message of that
 * session WAS our own stall prompt — the plugin injects it as a visible user
 * message, so it lands in the history as one. Two things made it unreadable
 * as ours:
 *
 *   1. The body was read from `m.content` only. The live projection stores
 *      these records as a plain `text` string, so the body came back
 *      undefined and the exact-text match never fired.
 *   2. The recency match (own prompt within 30s of our last inject) cannot
 *      fire either once the plugin instance is replaced: the in-memory
 *      record of our own injections (ownPromptTexts / lastInjectAt) starts
 *      empty, and our prompt is minutes old by then.
 *
 * With both signals blind, the plugin read its own prompt as the user taking
 * over — which resets BOTH the stall ladder and the visible progress counter,
 * so the counter never advanced past #1.
 *
 * The fix reads the body from either shape, recognises our own prompt by its
 * signature, and rebuilds the own-prompt record from the session log.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_own_prompt"


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

/** The shape the live projection actually stores: a plain `text` body, no
 *  `content` array. The old reader only looked at `content`. */
const ownStallRecord = (at: number, id: string) => ({
	id,
	role: "user",
	time: { created: at },
	text:
		"continue — stalled (attempt 1/3 (retry #1); idle 3m 8s; Oct 21, 3:31 PM EDT).\n" +
		"Only continue work already in progress. Do not start anything new, and do not take destructive or irreversible actions without explicit user approval.\n" +
		"No open todos recorded.",
})

async function setup(extraOpts: Record<string, unknown> = {}, messages: any[] = []): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			// Small enough that a silence stall lands within a test tick.
			chunkTimeoutMs: 50,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 99,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			// Without this the test writes into the PRODUCTION log, where a run is
			// indistinguishable from a reload storm.

			debug: true,
			...extraOpts,
		},
		session: {
			context: async () => messages,
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


async function waitFor(what: () => boolean, budgetMs = 4000): Promise<boolean> {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (what()) return true
		await wait(10)
	}
	return what()
}

const attemptOf = (text: string | undefined): string | null => {
	const m = /attempt (\d+)\/\d+/.exec(text ?? "")
	return m ? m[1] : null
}

const retryOf = (text: string | undefined): string | null => {
	const m = /retry #(\d+)/.exec(text ?? "")
	return m ? m[1] : null
}

describe("v2: our own unknown-tool prompt is not a genuine user message", () => {
	test("a stale unknown-tool prompt in the history does not re-arm the budgets", async () => {
		// User report 2026-10-30: after a reload the plugin's own unknown-tool
		// suggestion sits in the history as a user message, and the shape list
		// only knew the three "continue — stalled" bodies. The suggestion read
		// as new instructions and re-armed the budget it had just spent.
		const now = Date.now()
		const messages: any[] = [
			{ id: "u_real", role: "user", time: { created: now - 900_000 }, text: "fix the broken job" },
			{
				id: "u_own_unknown_tool",
				role: "user",
				time: { created: now - 600_000 },
				text:
					'You tried to use the tool "aft_read" 2 times, but it does not exist. ' +
					'The closest matching tool is "read". Please use "read" instead and adjust your arguments accordingly. ' +
					"Available tools include: bash, read, glob, grep, edit, write.",
			},
		]
		const h = await setup({}, messages)
		push(h, "session.execution.started", SID)
		await wait(120)
		const logs = h.capture.lines.join("\n")
		await teardown(h)
		expect(logs).toContain("newest user message is our own prompt")
		expect(logs).not.toContain("re-arming the unknown-tool budget")
	})
})

describe("v2: our own stall prompt is not a genuine user message", () => {
	test("a stale own prompt in the history does not re-arm the budgets", async () => {
		// Our prompt is the newest user message and it is MINUTES old: the
		// recency signal cannot fire, so only the body signature can identify
		// it. Pre-fix the plugin logged "new user message — restarting the
		// stall ladder" here and reset the counter.
		const now = Date.now()
		const messages: any[] = [
			{ id: "u_real", role: "user", time: { created: now - 900_000 }, text: "fix the broken job" },
			ownStallRecord(now - 600_000, "u_own"),
		]
		const h = await setup({}, messages)
		push(h, "session.execution.started", SID)
		await wait(120)
		const logs = h.capture.lines.join("\n")
		await teardown(h)
		expect(logs).toContain("newest user message is our own prompt")
		expect(logs).not.toContain("new user message — restarting the stall ladder")
	})

	test("the visible progress counter advances across stalls", async () => {
		// The end-to-end shape of the incident: each stall nudges, the nudge
		// lands in the history as a user message, and the next stall must
		// read "retry #2" — not "retry #1" again.
		const messages: any[] = []
		const h = await setup({}, messages)
		push(h, "session.execution.started", SID)
		await wait(20)
		await waitFor(() => h.injected.length >= 1)
		// Our prompt lands in the session history, minutes stale: the record
		// the plugin keeps of its own injections is gone (a plugin reload
		// starts it empty), and the body is in the plain-text shape.
		messages.push(ownStallRecord(Date.now() - 600_000, "u_own_1"))
		await waitFor(() => h.injected.length >= 2)
		const attempts = h.injected.map((i: any) => attemptOf(i.text))
		const retries = h.injected.map((i: any) => retryOf(i.text))
		const logs = h.capture.lines.join("\n")
		await teardown(h)
		expect(attempts.length).toBeGreaterThanOrEqual(2)
		// The model produced nothing between the stalls, so the ATTEMPTS climb
		// (they count unanswered nudges) ...
		expect(attempts[0]).toBe("1")
		expect(attempts[1]).toBe("2")
		// ... and the retry ordinal continues (2026-10-26 F2: rung-claim).
		// Pre-fix the second nudge read "attempt 1/3 (retry #1)" - the counter
		// was reset by our own prompt being read as a genuine user message;
		// that misreading still cannot happen (asserted below).
		expect(retries[0]).toBe("1")
		expect(retries[1]).toBe("2")
		expect(logs).not.toContain("new user message — restarting the stall ladder")
	})
})
