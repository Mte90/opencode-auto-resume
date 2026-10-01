import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_settle"

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

/** An hour old, so nothing is suppressed for "the user is mid-conversation". */
const OLD = Date.now() - 60 * 60_000

/** Trips `ready-to-continue` and is not a user hand-off. */
const READY_TEXT = "Ready to continue with task"
/** Trips `ready-to-continue` *and* is a hand-off — the guards must win.
 *  Deliberately the control's text plus a bare "?", so the sentence still matches
 *  the pattern and the only reason to stay quiet is the hand-off check. */
const READY_HANDOFF_TEXT = "Ready to continue with task?"

const userTurn = () => ({ type: "user", id: "msg_u", time: { created: OLD }, content: [{ type: "text", text: "go" }] })

/**
 * A finished assistant message. `noText` gives it reasoning but no text part and
 * enough output tokens, which is what a stream that died mid-response looks like.
 */
const assistantTurn = (text: string | null) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: OLD + 1_000 },
	content: text === null ? [{ type: "reasoning", text: "thinking about the answer" }] : [{ type: "text", text }],
	finish: "stop",
	tokens: { input: 100, output: 400, reasoning: 0, cache: { read: 0, write: 0 } },
})

async function setup(opts: { text?: string | null; toolTextCheckDelayMs?: number }): Promise<any> {
	const injected: Array<{ text?: string; description?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-settle-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// Mutable on purpose: the point of several tests below is what the deferred
	// pass reads, so the history has to be able to change after the first idle.
	let history: unknown[] = [userTurn(), assistantTurn(opts.text === undefined ? "Working on it." : opts.text)]

	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 600_000,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			injectIntervalMs: 0,
			toolTextCheckDelayMs: 0,
			logFile,
			...(opts.toolTextCheckDelayMs === undefined ? {} : { toolTextCheckDelayMs: opts.toolTextCheckDelayMs }),
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text, description: a?.description }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text, description: a?.description }), {}),
		},
		client: { session: { get: async () => ({ data: { id: SID } }), list: async () => ({ data: [{ id: SID }] }) } },
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [],
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	return {
		injected,
		setText: (t: string) => {
			history = [userTurn(), assistantTurn(t)]
		},
		/** The user replies *during* the delay: a fresh message, not the old one. */
		setFreshUser: (t: string) => {
			history = [
				{ type: "user", id: "msg_u2", time: { created: Date.now() }, content: [{ type: "text", text: "hold on" }] },
				assistantTurn(t),
			]
		},
		cleanup,
		logFile,
		streamRef: stream,
	}
}

async function teardown(h: any) {
	h.cleanup?.()
	rmSync(h.logFile, { force: true })
}

async function goIdle(h: any) {
	for (const e of [ev("session.execution.started"), ev("session.step.started"), ev("session.step.ended"), ev("session.idle")]) {
		h.streamRef.push(e)
		await wait(10)
	}
}

describe("v2: the settle delay lets a finished turn's text arrive before it is judged", () => {
	test("CONTROL: a zero delay judges the turn straight away", async () => {
		// The control for every timing assertion below. Without it, a test that
		// "passed because the nudge never came" would be indistinguishable from one
		// that proved the delay works.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 0 })
		await goIdle(h)
		await wait(250)
		expect(h.injected).toHaveLength(1)
		await teardown(h)
	})

	test("a long delay holds the nudge back", async () => {
		// The option's whole effect. v1 judges from a timer rather than on the idle
		// event, and a check that reads too early sees a half-finished turn.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 3_000 })
		await goIdle(h)
		await wait(300)
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("and releases it once the delay has passed", async () => {
		// The other half of the control above: a deferral that never fires would
		// look exactly like a working delay from the test before it.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 300 })
		await goIdle(h)
		await wait(800)
		expect(h.injected).toHaveLength(1)
		await teardown(h)
	})

	test("the deferred pass sees text that only landed after the first idle", async () => {
		// The reason the delay exists, stated as a test. At the idle event the last
		// message said something else entirely; by the time the pass runs, the
		// assistant's real closing turn is in the history. Judging on idle alone
		// would have seen the wrong turn and stayed silent.
		const h = await setup({ text: "Working on it.", toolTextCheckDelayMs: 300 })
		await goIdle(h)
		h.setText(READY_TEXT)
		await wait(800)
		expect(h.injected).toHaveLength(1)
		await teardown(h)
	})

	test("a turn that starts during the delay cancels the pending judgement", async () => {
		// Otherwise the deferred pass would read the live delta buffer, which a new
		// turn has already emptied, and judge the new turn against the old turn's
		// verdict.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 400 })
		await goIdle(h)
		await wait(50)
		h.streamRef.push(ev("session.execution.started"))
		await wait(20)
		h.streamRef.push(ev("session.step.started"))
		await wait(600)
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("a second idle inside the window replaces the first, rather than stacking", async () => {
		// Two passes on one turn would spend two attempts of one budget on one piece
		// of text, and the second attempt would be a nudge about a nudge.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 250 })
		await goIdle(h)
		await wait(40)
		await goIdle(h)
		await wait(700)
		expect(h.injected).toHaveLength(1)
		await teardown(h)
	})
})

describe("v2: the settle delay defers the patterns, not the structural checks", () => {
	test("CONTROL: a dead stream is still caught immediately", async () => {
		// The reason the split exists. A stream that died before delivering any
		// text is precisely the case where every text-based check has nothing to
		// look at, so waiting would only delay a recovery that is certain.
		const h = await setup({ text: null, toolTextCheckDelayMs: 3_000 })
		await goIdle(h)
		await wait(300)
		expect(h.injected).toHaveLength(1)
		await teardown(h)
	})

	test("a turn that became a hand-off during the delay is not nudged", async () => {
		// The pattern phase re-runs the guards instead of trusting the structural
		// pass's verdict, because the wait is long enough for the user to have
		// replied. Setting this up as a *change* is what makes it a test of that:
		// with the hand-off present from the start, the structural pass refuses and
		// never arms anything, so the assertion would hold whether or not the
		// pattern phase looked at the text again.
		//
		// The closing line is a bare question mark, which is the only difference
		// between this and the control's text — so the sentence still matches
		// ready-to-continue, and it stays quiet because of the guard.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 200 })
		await goIdle(h)
		h.setText(READY_HANDOFF_TEXT)
		await wait(700)
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("a user who replies during the delay stops the nudge", async () => {
		// The second reason the pattern phase re-runs the guards. The structural
		// pass saw a user message from an hour ago and judged the turn fair game;
		// three seconds later the user is mid-conversation, and a nudge sent over
		// them is the "Step interrupted" bug every guard in this file exists for.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 300 })
		await goIdle(h)
		h.setFreshUser(READY_TEXT)
		await wait(800)
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("a cancelled session is not nudged after the delay", async () => {
		// The user interrupting mid-wait is the loudest possible "stop".
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 300 })
		await goIdle(h)
		await wait(30)
		h.streamRef.push(ev("session.execution.interrupted"))
		await wait(800)
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("stopping the plugin drops a pending judgement", async () => {
		// Otherwise a reload would leave a timer pointing at a session this build is
		// no longer watching, and it would fire minutes later against a history
		// nobody is reading.
		const h = await setup({ text: READY_TEXT, toolTextCheckDelayMs: 400 })
		await goIdle(h)
		await wait(30)
		h.cleanup()
		await wait(800)
		expect(h.injected).toHaveLength(0)
		rmSync(h.logFile, { force: true })
	})
})
