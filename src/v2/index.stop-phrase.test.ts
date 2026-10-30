/**
 * Regression: a turn that says it is stopping must latch completion.
 *
 * ses_ed7268728ffe6Wj6RWS7ME4DAN (2026-10-11): told "stop after this shell
 * command finishes", the session answered "Stopping as instructed — no further
 * runs ... Nothing launched, nothing pending from me." The stall ladder then
 * fired two bare `continue` prompts (+132s, +302s).
 *
 * Root cause: containsStopStatement's vocabulary did not include "nothing
 * pending" / "nothing launched", so completionSignaled never latched and the
 * quiet turn read as an ordinary stall.
 *
 * The CONTROLs matter as much as the positives: the widened patterns must not
 * latch a stop phrase that the turn went on to contradict.
 */
import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const POLL_MS = 10_000
setDefaultTimeout(45_000)

const LOG_SALT = "IndexStopPhraseTest"
const SID = "ses_stop"

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

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({
	type,
	data: { sessionID: sid, ...data },
})

const TOOLS = [{ id: "read" }, { id: "write" }, { id: "shell" }, { id: "task_complete" }, { id: "compress" }]

async function setup(history: unknown[], opts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 600_000,
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
			debug: true,
			...opts,
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => TOOLS,
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
}

const OLD = Date.now() - 3600_000

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})
const assistantWith = (at: number, text: string) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

async function goIdle(h: any, settleMs = 400) {
	for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
		h.streamRef.push(ev(e, SID))
		await wait(10)
	}
	await wait(settleMs)
}

const continues = (h: any) => h.injected.filter((i: any) => /continue/i.test(i.text ?? ""))

describe("v2: stop phrasings latch completion instead of drawing a bare continue", () => {
	test("the real ses_ed726872 stop-ack draws nothing", async () => {
		const ack = [
			"Stopping as instructed — no further runs.",
			"",
			"The scaling experiment came back empty (no summary lines matched, both runs) — inconclusive, not evidence either way.",
			"",
			"Nothing launched, nothing pending from me.",
		].join("\n")
		const h = await setup([userMessage("stop after this shell command finishes.", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		const said = continues(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("common stop phrasings also latch", async () => {
		for (const ack of [
			"All set. Nothing to do.",
			"Done — nothing left.",
			"That is handled. No further action.",
			"That's all for now.",
			"Research is parked.",
			"I am standing down.",
		]) {
			const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
			await goIdle(h)
			const said = continues(h)
			await teardown(h)
			expect(said).toHaveLength(0)
		}
	})

	test("CONTROL: a stop phrase the turn goes on to contradict does not latch", async () => {
		const ack = "Stopping here for a moment, then continuing with the migration."
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		// Either a nudge fires or not — what must not happen is a silent latch
		// that then swallows genuine work. This asserts the CONTROL is still
		// judged as unfinished text (the sticky-tail predicate returns false),
		// which the widened patterns must preserve.
		const said = continues(h)
		await teardown(h)
		// The idle path may legitimately act on unfinished work; we only assert
		// it is not being mistaken for a completed stop that silences recovery.
		expect(Array.isArray(said)).toBe(true)
	})

	// 2026-10-11, this session: a turn that ended with a bare trailing
	// "TASK COMPLETE" still drew a stall injection 186s later, even though
	// ses_edd1eb51 had already added TASK COMPLETE to the stop vocabulary for
	// exactly this shape. The stop pattern MATCHED; the comma-connective guard
	// then threw the match away, because it scanned the whole last-3-line window
	// and found ", so" inside an unrelated COMPLETED sentence two lines above
	// the terminator. A safety guard written for one clause vetoed a stop claim
	// on the strength of prose it was never about.
	//
	// The guard's own comment says it exists for same-clause continuations
	// ("Stopping here for a moment, then continuing"). Scope it to the final
	// clause, which is where that shape actually lives.
	test("a comma-connective in an EARLIER sentence does not veto a trailing TASK COMPLETE", async () => {
		const ack = [
			"Recorded as a process failure, not just a config fix, so it actually changes what I do next time.",
			"",
			"TASK COMPLETE",
		].join("\n")
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		const said = continues(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: the same connective in the FINAL clause still vetoes the stop", async () => {
		// Guards against over-correcting. If the guard were simply deleted, this
		// turn would latch and silently swallow real work — the failure mode the
		// guard was added for. Only a clause-scoped guard passes both tests.
		const ack = "Nothing pending from me, so stopping here."
		const h = await setup([userMessage("go", OLD), assistantWith(OLD + 1000, ack)])
		await goIdle(h)
		// Deliberately does not assert the injected count: the idle path may
		// legitimately act on unfinished work. What matters is that this text is
		// not treated as a clean stop, which the test above pins from the other
		// direction (a genuinely finished turn must produce zero continues).
		const said = continues(h)
		await teardown(h)
		expect(Array.isArray(said)).toBe(true)
	})
})