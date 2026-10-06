import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"
const CHILD = "ses_child"

let counter = 1000

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

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
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
	/** Session ids the server reports busy. */
	active?: string[]
	/** Rows `session.list` returns. Defaults to parent + one linked child. */
	listRows?: Array<{ id: string; parentID?: string }>
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-parentwait-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: History = opts.history ?? {}
	const active = new Set(opts.active ?? [])
	const rows = opts.listRows ?? [{ id: SID }, { id: CHILD, parentID: SID }]

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
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
	return { injected, interrupted, history, active, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
}

const parentInjects = (h: any) => h.injected.filter((i: any) => i.sid === SID)

describe("v2: busy-stall skips a parent waiting on a live subagent", () => {
	test("no stall recovery while a live child works, even with no task-tool event", async () => {
		// ses_ef73a206 shape: parent blocked on a subagent, silent past
		// chunkTimeoutMs, never emitted session.tool.called for the dispatch
		// (lastWasTaskTool false, pendingTools 0). The parentID link + recent
		// child activity is the only evidence — and it must be enough.
		const now = Date.now()
		const h = await setup({
			active: [SID, CHILD],
			history: { [SID]: [userMessage("go", now - 60_000)], [CHILD]: [assistantAt(now - 5_000)] },
		})
		await makeBusy(h, SID)
		await wait(900)
		expect(parentInjects(h)).toHaveLength(0)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("no stall recovery while tools are held and children are unresolved", async () => {
		// tool.called fired (pendingTools 1, lastWasTaskTool true) but the
		// child is absent from the server active set — the old
		// lastWasTaskTool+others guard misses, the parentID link must catch it.
		const now = Date.now()
		const h = await setup({
			active: [SID],
			history: { [SID]: [userMessage("go", now - 60_000)], [CHILD]: [assistantAt(now - 5_000)] },
		})
		await makeBusy(h, SID)
		push(h, "session.tool.called", SID, { tool: "subagent", input: { description: "research" } })
		await wait(900)
		expect(parentInjects(h)).toHaveLength(0)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: a truly stalled parent with no live children still recovers", async () => {
		// No children at all on the parentID link — ordinary stall, must fire.
		// (A merely-quiet child now reads as waiting, not dead, so the link
		// itself must be absent for this control.)
		const now = Date.now()
		const h = await setup({
			active: [SID],
			listRows: [{ id: SID }],
			history: { [SID]: [userMessage("go", now - 60_000)] },
		})
		await makeBusy(h, SID)
		await wait(900)
		expect(parentInjects(h).length).toBeGreaterThan(0)
		await teardown(h)
	})
})
