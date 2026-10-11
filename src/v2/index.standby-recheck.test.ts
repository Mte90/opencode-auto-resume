import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexStandbyRecheckTest"

/**
 * v2: a stand-down re-arms one deferred pattern pass for window expiry.
 *
 * ses_edbb4e67 (2026-10-10): the structural idle evaluation is the only one
 * an idle gets. It hit shouldStandDownForUser (user active <5min earlier)
 * and returned with no follow-up — no reschedule, no re-arm — so the session
 * sat invisible until the user typed continue manually, twice. The watchdog
 * idle branch only runs the reasoning sweep, and discovery only seeds. Now
 * the stand-down arms one replacement pattern pass for window expiry +1s. A
 * new turn replaces it (markBusy clears the slot); a hand-off never arms it
 * (returned earlier), so an awaited user reply is never nagged.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 9600

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
	chunkTimeoutMs: 600_000,
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
	// Short window so the recheck fires inside the test. Prod default 5min.
	activeUserWindowMs: 400,
}

async function setup(opts: { messages?: unknown[]; todos?: Array<{ content: string; status: string }> }): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-recheck-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => opts.messages ?? [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
				message: { list: async () => [] },
			},
		},
		storage: {
			get: async () => ({ todos: opts.todos ?? [] }),
			set: async () => {},
			remove: async () => {},
		},
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [],
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

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

// Action-intent text (colon ending): fires the intent path once evaluated.
const INTENT_TEXT = "Reading the full summary (everything before the title list):"
const userMsg = (ageMs: number) => ({
	// Prod shape: role, not type (see assistantMsg note above).
	role: "user",
	id: "msg_u",
	time: { created: Date.now() - ageMs },
	content: [{ type: "text", text: "go" }],
})
const assistantMsg = (text: string, ageMs: number) => ({
	// Prod shape: role, not type (see task-complete-text note above).
	role: "assistant",
	id: "msg_a",
	time: { created: Date.now() - ageMs },
	content: [{ type: "text", text }],
})

describe("v2: stand-down re-arms a deferred pattern pass", () => {
	test("intent stall nudges after the activity window expires", async () => {
		const h = await setup({
			messages: [userMsg(100), assistantMsg(INTENT_TEXT, 50)],
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		// Window (400ms) expires ~300ms after setup; recheck margin +1000ms.
		await wait(1800)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("CONTROL: long-stale user gets the nudge promptly, no recheck needed", async () => {
		const h = await setup({
			messages: [userMsg(60_000), assistantMsg(INTENT_TEXT, 50)],
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("CONTROL: hand-off turn never arms a recheck", async () => {
		const h = await setup({
			messages: [userMsg(100), assistantMsg("Should I proceed with the migration?", 50)],
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(1800)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})
})
