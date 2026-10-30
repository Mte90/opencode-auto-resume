import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { capturePluginLogs } from "./test-utils"
import { capturePluginLogs } from "./test-utils"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexUserWaitTest"

/**
 * v2: busy-stall stands down while a turn waits on the user.
 *
 * Repro: ses_ef72c5f3 (2026-10-05) — the watchdog injected
 * `continue — stalled (no activity for 186s)` into a session parked on a
 * `question` tool awaiting the user. The busy-stall path had no user-wait
 * guard (only the idle path stands down via `shouldStandDownForUser`).
 * A turn awaiting the user is waiting, not stalled — but a wedged bare
 * tool (or an answered question) must still recover.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"


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
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
}

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: "msg_u",
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantWithTool = (name: string, status: string, at: number) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	content: [{ type: "tool", name, state: { status } }],
})

type History = Record<string, unknown[]>

async function setup(history: History, active: string[]): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const activeSet = new Set(active)
	const rows: Array<{ id: string; parentID?: string }> = [{ id: SID }]

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT },
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => Object.fromEntries([...activeSet].map((s) => [s, {}])),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async (a: any) => {
					if (!a?.parentID) return { data: rows }
					return { data: rows.filter((r) => (r as any).parentID === a.parentID) }
				},
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, interrupted, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
}

const parentInjects = (h: any) => h.injected.filter((i: any) => i.sid === SID)

describe("v2: busy-stall stands down while a turn waits on the user", () => {
	test("no stall recovery while a question tool is still running", async () => {
		const now = Date.now()
		const h = await setup(
			{
				[SID]: [userMessage("go", now - 60_000), assistantWithTool("question", "running", now - 5_000)],
			},
			[SID],
		)
		await makeBusy(h, SID)
		await wait(900)
		expect(parentInjects(h)).toHaveLength(0)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: a wedged bare tool still recovers", async () => {
		// A non-user tool stuck running with no events is exactly what the
		// stall path exists for — the user-wait guard must not swallow it.
		// "Wedged" means past the stuck-tool age gate (60s): a YOUNG running
		// part is working, not wedged — the event-based young-tool guard already
		// defers on it when its tool.called arrives, and the history-based
		// young-unfinished guard defers when events were lost (e.g. reload).
		// So this fixture uses a part old enough to actually be wedged; the
		// young side of the boundary is pinned by the stall-shell-guard suite.
		// Uses `write`, not `shell`: shells get a longer stall-path TTL of
		// their own (10 min), so a 120s shell is still working, not wedged.
		const now = Date.now()
		const h = await setup(
			{
				[SID]: [userMessage("go", now - 600_000), assistantWithTool("write", "running", now - 120_000)],
			},
			[SID],
		)
		await makeBusy(h, SID)
		await wait(900)
		expect(parentInjects(h).length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("CONTROL: an answered question still recovers", async () => {
		// The user answered (tool completed) but the session never moved:
		// that IS a stall, not a wait.
		const now = Date.now()
		const h = await setup(
			{
				[SID]: [userMessage("go", now - 60_000), assistantWithTool("question", "completed", now - 5_000)],
			},
			[SID],
		)
		await makeBusy(h, SID)
		await wait(900)
		expect(parentInjects(h).length).toBeGreaterThan(0)
		await teardown(h)
	})
})
