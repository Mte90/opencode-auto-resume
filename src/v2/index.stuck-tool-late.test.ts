/**
 * Regression (audit of ses_ed7268728ffe6Wj6RWS7ME4DAN, 2026-10-11).
 *
 * Gap: `checkForStuckToolCalls` is reached ONLY from `inspectOnIdle` (index.ts
 * :4253), and `inspectOnIdle` is reached only from the `session.idle` event
 * handler (:5567) plus two deferred "pattern" re-inspections.
 *
 * The idle branch of the watchdog sweep (`checkActiveSessions`, :4812) re-runs
 * `checkForSilentReasoningTurn` for already-parked sessions but NEVER re-runs
 * the stuck-tool pass.
 *
 * Therefore, when the single `session.idle` event arrives BEFORE the call has
 * aged past `stuckToolAgeMs` (60s), the pass declines it (by design — the age
 * gate), no further idle event ever arrives for a parked session, and the stuck
 * call is never re-examined. The session sits forever.
 *
 * This is the class of failure the file header describes (ses_edf403f5,
 * ses_ee14d727) except the tool was YOUNG rather than 61s+ old when idle fired.
 *
 * The existing suite cannot catch it: every test pushes `session.idle` with the
 * call already past the gate (`now - 61_000`) or inside it, then asserts. None
 * drives "idle first, age later".
 */
import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const POLL_MS = 12_000
setDefaultTimeout(60_000)

const LOG_SALT = "IndexStuckToolLateRepro"
const SID = "ses_parent"
let counter = 61000

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

// A live handle to the message array so the test can age the call after idle.
async function setup(history: unknown[], opts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			// chunkTimeout large so the watchdog's *busy* stall ladder stays out
			// of the way; we want the idle/parked path only.
			chunkTimeoutMs: 600_000,
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
			logFile,
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
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const toolPart = (id: string, name: string, status: string, at: number) => ({
	type: "tool",
	id,
	name,
	time: { created: at },
	state: { status, input: {} },
})

const assistantWith = (at: number, ...content: unknown[]) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text: "Working on it." }, ...content],
})

const stuckNudges = (h: any) => h.injected.filter((i: any) => /never returned a result/.test(i.text ?? ""))

async function goIdle(h: any) {
	for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
		h.streamRef.push(ev(e, SID))
		await wait(10)
	}
	await wait(300)
}

describe("a call that ages into stuck AFTER idle still gets re-checked", () => {
	test("idle fires while the call is young; the pass should still fire once it ages past the gate", async () => {
		// A 3s age gate keeps the scenario inside the test window while preserving
		// the exact shape of the bug: idle first, age later.
		const GATE_MS = 3_000
		const now = Date.now()
		// The part object is mutated in place below to simulate real time passing.
		const part = toolPart("call_1", "shell", "running", now - 1_000)
		const history = [userMessage("go", now - 120_000), assistantWith(now - 1_500, part)]

		const h = await setup(history, { stuckToolAgeMs: GATE_MS, chunkTimeoutMs: 600_000 })

		// Drive idle with the call only 1s old -> inside the 3s gate. Correct
		// behaviour today: no nudge.
		await goIdle(h)
		expect(stuckNudges(h)).toHaveLength(0)

		// Now the call ages past the gate, exactly as it would if the server
		// simply never delivered a result. Nothing re-examines it on the event
		// path: the session is parked, so no further session.idle event exists.
		part.time.created = Date.now() - 30_000

		// Give the watchdog (checkIntervalMs: 20ms) sweeps to notice. It needs
		// idleFor > stuckToolAgeMs before it will re-run the pass.
		const deadline = Date.now() + POLL_MS
		while (Date.now() < deadline && stuckNudges(h).length === 0) await wait(50)

		const said = stuckNudges(h)
		await teardown(h)

		// Green once the watchdog re-runs the stuck-tool pass for parked sessions.
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"shell"')
	})
})