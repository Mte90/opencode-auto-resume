import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: a quiet subagent is waited on within a patience window, not killed.
 *
 * ses_ef1c822c (2026-10-06): the orphan watch declared a healthy
 * long-thinking coder worker "crashed" after 60s of quiet, interrupted the
 * parent twice, then looped every 5s forever (orphan aborts never counted
 * toward gaveUp). Two corrections, both bounded so a hung model can't sit
 * forever:
 *  1. Quiet without error evidence waits inside an outer dead-window
 *     (default 30m); only error evidence or quiet past the window reads
 *     as crashed.
 *  2. Each orphan abort counts toward the gaveUp budget, so the watch
 *     terminates instead of cycling indefinitely.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"
const CHILD = "ses_child"

let counter = 5000

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
}

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: "msg_u",
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantAt = (at: number) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	content: [{ type: "text", text: "working on it" }],
})

type History = Record<string, unknown[]>

async function setup(opts: {
	history?: History
	active?: string[]
	maxRetries?: number
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-patience-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: History = opts.history ?? {}
	const active = new Set(opts.active ?? [])
	const rows = [{ id: SID }, { id: CHILD, parentID: SID }]

	const ctx: any = {
		event: stream,
		options: {
			...OPTIONS,
			logFile,
			...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
		},
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => Object.fromEntries([...active].map((s) => [s, {}])),
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
	return { injected, interrupted, logFile, streamRef: stream, cleanup }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const logs = (h: any) => (existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : "")
const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
}

/** Parent busy, child goes quiet: arms the orphan watch. */
async function armWatch(h: any) {
	await makeBusy(h, SID)
	await wait(20)
	await makeBusy(h, CHILD)
	await wait(20)
	push(h, "session.idle", CHILD)
	await wait(20)
}

describe("v2: quiet subagents wait inside a patience window", () => {
	test("a healthy quiet worker is waited on, not aborted", async () => {
		// 5 minutes of quiet: past the 60s stuck window, inside the 30m
		// dead window, no error. Old verdict: crashed -> interrupt + prod.
		const now = Date.now()
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", now - 60_000)],
				[CHILD]: [assistantAt(now - 5 * 60_000)],
			},
		})
		await armWatch(h)
		await wait(600)
		expect(h.interrupted).toHaveLength(0)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: quiet past the dead window still aborts", async () => {
		// 40 minutes of quiet with no error: a hung model must not sit
		// forever. Crashed handling is preserved.
		const now = Date.now()
		const h = await setup({
			active: [SID],
			history: {
				[SID]: [userMessage("go", now - 60_000)],
				[CHILD]: [assistantAt(now - 40 * 60_000)],
			},
		})
		await armWatch(h)
		await wait(600)
		expect(h.interrupted.length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("orphan aborts terminate instead of cycling forever", async () => {
		// maxRetries 1: one orphan abort spends the budget; the next tick
		// must give up, not abort again.
		const now = Date.now()
		const h = await setup({
			active: [SID],
			maxRetries: 1,
			history: {
				[SID]: [userMessage("go", now - 60_000)],
				[CHILD]: [assistantAt(now - 40 * 60_000)],
			},
		})
		await armWatch(h)
		// The abort path holds `aborting` for 2s (interrupt window), during
		// which the watch skips; gaveUp lands on the first tick after that.
		await wait(3000)
		expect(h.interrupted).toHaveLength(1)
		expect(logs(h)).toContain("gave up")
		await teardown(h)
	})
})
