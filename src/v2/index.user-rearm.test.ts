import { describe, test, expect } from "bun:test"
import { rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexUserRearmTest"

/**
 * v2: a genuine new user message re-arms recovery after a user interrupt.
 *
 * ses_eeb02d4b (2026-10-07): after an interrupt, auto-resume never got the
 * session going again — not even after an explicit user "continue".
 * `userCancelled` latched permanently: set once on a non-plugin interrupt
 * and cleared nowhere (not on new user messages, not on new turns), while
 * every recovery path checks it first. A new inbound user message is the
 * hand-back signal and re-arms alongside the other budgets — own injected
 * prompts excluded, as with every other re-arm.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 6000

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
	debug: false,
}

const userMessage = (text: string, at: number, id = "msg_u") => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantText = (text: string, at: number) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	content: [{ type: "text", text }],
})

async function setup(history: Record<string, unknown[]>, extraOpts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-rearm-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, registryScope: LOG_SALT, ...extraOpts },
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => ({ [SID]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream, history }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

/** Poll the log file for a line instead of sleeping a fixed span. */
async function waitForLog(logFile: string, needle: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			if (readFileSync(logFile, "utf8").includes(needle)) return true
		} catch {
			// Log file not written yet.
		}
		if (Date.now() >= deadline) return false
		await wait(25)
	}
}

describe("v2: genuine user message re-arms after user interrupt", () => {
	test("interrupt latches, then a new user message re-arms recovery", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(50)
		// Genuine new inbound user message, then a fresh turn that stalls.
		history[SID] = [
			userMessage("go", now - 60_000, "msg_u1"),
			userMessage("continue", Date.now(), "msg_u2"),
			assistantText("working", Date.now()),
		]
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("CONTROL: interrupt with no new user message stays stood down", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(50)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})

	test("a genuine user message inside the backoff wait parks the recovery", async () => {
		// The race this pins: stall declared arms the recover timer (200ms
		// here so the window is drivable); a genuine user message landing
		// before it fires must park the turn instead of injecting into the
		// user's live turn ("Step interrupted"). The busy-freshness check
		// cannot see it — event-pump lag means their execution.started may
		// not have been processed yet — so the timer compares
		// lastGenuineUserAt against its own arm time. (2026-10-11: continues
		// landing right after user statements.)
		//
		// Deliberately NO second execution.started: the freshness guard would
		// park on processed activity and the test would prove nothing. The
		// user message arrives as history only — exactly the case the guard
		// exists for — picked up by the watchdog's own history reads.
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history, { baseBackoffMs: 1000, maxBackoffMs: 1000, debug: true })
		push(h, "session.execution.started", SID)
		// Wait for the watch to actually go busy before the silence window
		// starts: under a saturated event loop the started event can sit
		// unprocessed, and everything after it (chunk silence, declaration,
		// arm) shifts by the same lag. Polling the precondition beats
		// assuming it (1-in-14 flake, 2026-10-11).
		expect(await waitForLog(h.logFile, "idle/unknown -> busy", 5000)).toBe(true)
		// Wait out the 300ms chunk timeout until the watchdog declares the
		// stall and arms the timer (200ms fuse from there).
		const armed = await waitForLog(h.logFile, "resume attempt 1/3", 5000)
		expect(armed).toBe(true)
		history[SID] = [
			userMessage("go", now - 60_000, "msg_u1"),
			userMessage("go on, I am here", Date.now(), "msg_u2"),
		]
		// The guard logs when it parks; absence of injection alone would not
		// distinguish "parked" from "never fired".
		const parked = await waitForLog(h.logFile, "parking recovery", 5000)
		await teardown(h)
		expect(parked).toBe(true)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
	})
})
