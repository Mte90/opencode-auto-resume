import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_premature"

/**
 * Premature-stop detection.
 *
 * This is the failure mode where the model ends its turn cleanly — no stall, no
 * error, no streaming failure — while the work is not actually finished. The
 * stall watchdog cannot see it: the session is idle, not wedged, so nothing is
 * ever "too silent". What catches it is reading the last assistant text and
 * asking whether it actually reports work.
 *
 * Two detectors:
 *   - endsWithCelebration:    the model's own "finished" signal, which must latch
 *                             rather than be nudged over.
 *   - containsWorkDescription: a done-claim with no work report in it, which gets
 *                             exactly one request for details.
 *
 * Every group carries a control. The failure mode that matters here is a test
 * that passes because the nudge never fired at all.
 */

type Harness = {
	injected: Array<{ kind: string; text?: string }>
	logs: string[]
}

let counter = 0

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

/** Old enough that activeUserWindowMs cannot mask a failure. */
const userTurn = (ageMs = 60 * 60_000) => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - ageMs },
	content: [{ type: "text", text: "do the thing" }],
})
const assistantTurn = (text: string) => ({
	type: "assistant",
	id: "msg_a1",
	time: { created: Date.now() - 60_000 },
	content: [{ type: "text", text }],
})

/** One turn that streams `text` and then goes idle. */
function turnEvents(text: string) {
	return [
		ev("session.execution.started"),
		ev("session.text.delta", { messageID: "msg_a1", delta: text }),
		ev("session.text.ended", { messageID: "msg_a1" }),
		ev("session.idle"),
	]
}

/** Idle again with no new turn — what a latched completion must survive. */
const idleAgain = [ev("session.idle")]

const OPTIONS = {
	// Long enough that the stall watchdog never fires: these tests are about the
	// idle path only, and a stall injection would mask which path produced a nudge.
	chunkTimeoutMs: 600_000,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	// Without this the second nudge in a two-turn test is debounced away as
	// "too soon after the last injection", and the re-arm test fails for the
	// wrong reason.
	injectIntervalMs: 0,
}

async function replay(
	events: any[],
	opts: Record<string, unknown> = {},
	harnessOpts: { userAgeMs?: number } = {},
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-premature-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...opts },
		session: {
			context: async () => [userTurn(harnessOpts.userAgeMs), assistantTurn(TEXT_FOR_HARNESS.value)],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => {
				injected.push({ kind: "synthetic", text: a?.text })
				return {}
			},
			prompt: async (a: any) => {
				injected.push({ kind: "prompt", text: a?.text })
				return {}
			},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	await wait(600)
	;(cleanup as (() => void) | undefined)?.()
	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, logs }
}

/**
 * The idle handler prefers the streamed delta buffer and only falls back to
 * `session.context()` when it is empty. Tests that stream text exercise the
 * buffer; this lets a case that must exercise the fallback set it explicitly.
 */
const TEXT_FOR_HARNESS = { value: "unrelated" }

/** Terse done-claim with no work report — the premature stop. */
const BARE_DONE = "Task done."

/** Long, but no actual work report. Length alone must not save it. */
const LONG_BUT_EMPTY = `Task done.\n\n${"I considered the situation carefully. ".repeat(30)}`

/** Short, but a real report. Length alone must not condemn it. */
const SHORT_BUT_REAL = "Done. Changed src/v2/index.ts"

describe("v2: premature stop — a done-claim with no work in it", () => {
	test("CONTROL: a bare 'Task done.' with nothing after it IS nudged", async () => {
		const { injected } = await replay(turnEvents(BARE_DONE))
		expect(injected.length).toBeGreaterThan(0)
		expect(injected[0].text).toContain("verify")
	})

	test("a long done-claim with no work report is still nudged", async () => {
		// The bug this replaces: a 400-character gate let this through.
		expect(LONG_BUT_EMPTY.length).toBeGreaterThan(400)
		const { injected } = await replay(turnEvents(LONG_BUT_EMPTY))
		expect(injected.length).toBeGreaterThan(0)
	})

	test("a short done-claim that names a changed file is NOT nudged", async () => {
		// The other half of the same bug: SHORT_BUT_REAL is under 400 characters.
		expect(SHORT_BUT_REAL.length).toBeLessThan(400)
		const { injected } = await replay(turnEvents(SHORT_BUT_REAL))
		expect(injected).toEqual([])
	})

	test("a done-claim reporting tests run is NOT nudged", async () => {
		const { injected } = await replay(
			turnEvents("Done.\n\nTests run: 639 pass, 0 fail\nResults: all green"),
		)
		expect(injected).toEqual([])
	})

	test("a done-claim reporting verification is NOT nudged", async () => {
		const { injected } = await replay(turnEvents("All done.\n\nVerification: tsc clean"))
		expect(injected).toEqual([])
	})

	test("the nudge is sent once per turn, not once per idle event", async () => {
		const { injected } = await replay([...turnEvents(BARE_DONE), ...idleAgain, ...idleAgain])
		expect(injected.length).toBe(1)
	})

	test("a new turn re-arms the budget", async () => {
		const { injected } = await replay([
			...turnEvents(BARE_DONE),
			...idleAgain,
			...turnEvents(BARE_DONE),
		])
		expect(injected.length).toBe(2)
	})

	test("maxRetries caps how many details prompts one busy cycle can spend", async () => {
		const { injected } = await replay(turnEvents(BARE_DONE), { maxRetries: 1 })
		expect(injected.length).toBe(1)
	})
})

describe("v2: celebration latches completion", () => {
	test("CONTROL: a bare done-claim without 🎉 is still nudged", async () => {
		const { injected } = await replay(turnEvents(BARE_DONE))
		expect(injected.length).toBeGreaterThan(0)
	})

	test("a trailing 🎉 latches completion instead of nudging", async () => {
		const { injected, logs } = await replay(turnEvents("All set.\n\nChanged the parser. 🎉"))
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("latching completion"))).toBe(true)
	})

	test("the latch survives a later idle with no new text", async () => {
		// debug:true so the second (silent) visit is observable at all — before
		// the log-sink fix these lines only reached a console nobody captures.
		const { injected, logs } = await replay(
			[...turnEvents("All set. 🎉"), ...idleAgain, ...idleAgain],
			{ debug: true },
		)
		expect(injected).toEqual([])
		expect(logs.filter((l) => l.includes("latching completion"))).toHaveLength(1)
		expect(logs.some((l) => l.includes("completion already latched"))).toBe(true)
	})

	test("a new turn clears the latch, so a later done-claim is judged on its own", async () => {
		const { injected, logs } = await replay([
			...turnEvents("All set. 🎉"),
			...idleAgain,
			// A fresh turn: budgets reset, latch resets, and this one is bare.
			...turnEvents(BARE_DONE),
		])
		expect(injected.length).toBeGreaterThan(0)
		expect(logs.filter((l) => l.includes("latching completion"))).toHaveLength(1)
	})

	test("punctuation after the emoji still counts as celebration", async () => {
		// v1 normalises trailing [.!?] before the check.
		const { injected } = await replay(turnEvents("Wrapped it up. 🎉."))
		expect(injected).toEqual([])
	})
})

describe("v2: premature-stop detection does not fight the other idle guards", () => {
	test("a turn that hands off to the user is never nudged", async () => {
		// A question is a legitimate stop, however terse.
		const { injected } = await replay(turnEvents("Task done.\n\nWhich file should I edit?"))
		expect(injected).toEqual([])
	})

	test("a recent user message stands the nudge down", async () => {
		// The user turn must be INSIDE the window for this to mean anything; the
		// default harness turn is an hour old and would not stand down at all.
		const { injected } = await replay(turnEvents(BARE_DONE), { activeUserWindowMs: 600_000 }, { userAgeMs: 30_000 })
		expect(injected).toEqual([])
	})

	test("an old user message does NOT stand the nudge down", async () => {
		// The control for the test above: same window, older turn, nudge fires.
		const { injected } = await replay(turnEvents(BARE_DONE), { activeUserWindowMs: 600_000 }, { userAgeMs: 3_600_000 })
		expect(injected.length).toBeGreaterThan(0)
	})

	test("the fallback to session.context() judges the same way", async () => {
		// No streamed text at all: the handler must read the authoritative history.
		TEXT_FOR_HARNESS.value = BARE_DONE
		try {
			const { injected } = await replay([ev("session.execution.started"), ev("session.idle")])
			expect(injected.length).toBeGreaterThan(0)
		} finally {
			TEXT_FOR_HARNESS.value = "unrelated"
		}
	})
})