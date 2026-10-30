import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "IndexUnrelatedActiveSessionTest"

/**
 * v2: "some other session is running" is not evidence that this parent waits.
 *
 * ses_ea173ea1effe7LdQB40HNuv2Jl (2026-10-21, the 9am upstream-sync job): the
 * parent dispatched its four workers, the user CANCELLED them, and the parent
 * then went idle and was never nudged again. The plugin log shows 805
 * consecutive sweeps of:
 *
 *   …0HNuv2Jl silent after task tool with 5 active child(ren) — waiting
 *
 * — "5 active children" that were not its children at all: unrelated
 * scheduled runs and other sessions on the same box. The guard treated
 * "anything else is running" as "my child is still running", so the stall
 * detector was skipped for the whole session (7 hours idle, one nudge when
 * the user came back).
 *
 * The flag behind it (`lastWasTaskTool`) survives a task-tool dispatch that
 * never reports back through a tool.success/tool.failed event — a subagent
 * dispatch completes as a message part, not as a tool event — so the guard
 * stayed armed long after the child was gone.
 *
 * The parentID-aware guard (parentWaitingOnSubagents) does this job
 * correctly: it waits on a live child, waits on a quiet one inside the
 * patience window, and RECOVERS a crashed one. It is the only evidence that
 * counts.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"
const OTHER = "ses_unrelated"

let counter = 1200

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
	// Short, so the abandoned tool call ages out of the young-tool gate
	// instead of deferring the stall for a minute.
	stuckToolAgeMs: 100,
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
	debug: false,
}

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

async function setup(opts: { history?: Record<string, unknown[]>; active?: string[]; listRows?: Array<{ id: string; parentID?: string }> }): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const history = opts.history ?? {}
	const active = new Set(opts.active ?? [])
	const rows = opts.listRows ?? [{ id: SID }]

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT },
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
					return { data: rows.filter((r: any) => r.parentID === a.parentID) }
				},
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, interrupted, history, active, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))
const parentInjects = (h: any) => h.injected.filter((i: any) => i.sid === SID)

describe("v2: an unrelated active session must not silence the stall detector", () => {
	test("a parent whose child is gone still recovers while other sessions run", async () => {
		// The incident shape: the parent dispatched a subagent, the child is gone
		// (no parentID link at all), and ANOTHER session on this box is running.
		// Pre-fix the "silent after task tool with N active child(ren)" guard
		// counted the unrelated session as a child and skipped every sweep.
		const now = Date.now()
		const h = await setup({
			active: [SID, OTHER],
			listRows: [{ id: SID }, { id: OTHER }],
			history: { [SID]: [userMessage("go", now - 60_000)] },
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(10)
		// A task-tool dispatch whose completion never arrives as a tool event
		// (a subagent returns as a message part). The flag stays armed.
		push(h, "session.tool.called", SID, { tool: "subagent", id: "call_1" })
		await wait(1200)
		const injects = parentInjects(h)
		await teardown(h)
		expect(injects.length).toBeGreaterThan(0)
	})
})
