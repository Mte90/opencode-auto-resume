import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"
const CHILD = "ses_child"

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

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: sid, ...data } })

/** Long timeouts: the orphan watch must fire well inside the silence check's own
 *  budget, and the point of several tests is that it does NOT wait for that. */
const OPTIONS = {
	chunkTimeoutMs: 600_000,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: true,
}

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantAt = (at: number, extra: unknown[] = [], err?: unknown) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	...(err !== undefined ? { error: err } : {}),
	content: [{ type: "text", text: "working on it" }, ...extra],
})

type History = Record<string, unknown[]>

async function setup(
	opts: {
		history?: History
		/** Session ids the server reports busy. */
		active?: string[]
		/** Rows `session.list` returns. `parentID` is verified client-side. */
		listRows?: Array<{ id: string; parentID?: string }>
		/** Drop `parentID` from list rows, simulating a host that ignores the filter. */
		listIgnoresFilter?: boolean
		sessions?: Record<string, { parentID?: string }>
		subagentWaitMs?: number
	},
): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-orphan-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: History = opts.history ?? { [SID]: [userMessage("go", Date.now() - 60_000)] }
	const active = new Set(opts.active ?? [])
	const rows = opts.listRows ?? [{ id: SID }, { id: CHILD, parentID: SID }]

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...(opts.subagentWaitMs ? { subagentWaitMs: opts.subagentWaitMs } : {}) },
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => Object.fromEntries([...active].map((s) => [s, {}])),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({
					data: { id: path?.id, ...(opts.sessions?.[path?.id] ?? {}) },
				}),
				list: async (a: any) => {
					// A host that honours parentID filters server-side; one that does
					// not returns everything and lets the caller verify.
					if (opts.listIgnoresFilter || !a?.parentID) return { data: rows }
					return { data: rows.filter((r) => r.parentID === a.parentID) }
				},
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	// Age past the warmup window so the watchdog considers the session at all.
	await wait(60)
	return {
		injected,
		interrupted,
		history,
		active,
		...({ cleanup, logFile, streamRef: stream } as any),
	}
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const logs = (h: any) => (existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : "")

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

/** Bring a session up busy: an execution and a step, no text. */
async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
}

/** A child that goes busy and then quiet. */
async function childGoesBusyThenIdle(h: any) {
	await makeBusy(h, CHILD)
	await wait(20)
	// A finished session leaves the server active set. Leaving it in would have
	// the watchdog re-mark the child busy, which is the server saying "still
	// running" — and the whole premise of the watch is that it stopped.
	h.active.delete(CHILD)
	push(h, "session.idle", CHILD)
	await wait(20)
}

const A_LONG_WAY_AGO = Date.now() - 10 * 60_000

describe("v2: the orphan watch arms when a parent's subagents fall quiet", () => {
	test("CONTROL: nothing is armed while only the parent is busy", async () => {
		// The control for everything below: the watch is about subagents going
		// quiet, not about a parent being busy. A parent alone must be left to the
		// ordinary silence check.
		const h = await setup({ active: [SID] })
		await makeBusy(h, SID)
		await wait(400)
		expect(h.interrupted).toHaveLength(0)
		expect(logs(h)).not.toContain("orphan watch")
		await teardown(h)
	})

	test("CONTROL: a session that outlived a busy session but has no subagents is left alone", async () => {
		// Two unrelated conversations open at once and one of them finishes: from the
		// busy-count transition alone that is indistinguishable from a parent whose
		// child died. v1 cannot tell them apart and aborts the survivor. This one has
		// no children at all, so the watch never arms.
		const OTHER = "ses_stranger"
		const h = await setup({
			active: [SID, OTHER],
			history: { [SID]: [userMessage("go", A_LONG_WAY_AGO)] },
			listRows: [{ id: SID }],
		})
		await makeBusy(h, SID)
		await wait(20)
		await makeBusy(h, OTHER)
		await wait(20)
		h.active.delete(OTHER)
		push(h, "session.idle", OTHER)
		await wait(500)
		expect(logs(h)).not.toContain("orphan watch")
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: a subagent of a different parent does not arm this parent's watch", async () => {
		// The child check is on the parentID link, not on "some child went quiet". A
		// neighbour's fan-out finishing is not this session's business.
		const OTHER_CHILD = "ses_other_child"
		const h = await setup({
			active: [SID, OTHER_CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[OTHER_CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
			listRows: [{ id: SID }, { id: OTHER_CHILD, parentID: "ses_their_parent" }],
		})
		await makeBusy(h, SID)
		await wait(20)
		await makeBusy(h, OTHER_CHILD)
		await wait(20)
		h.active.delete(OTHER_CHILD)
		push(h, "session.idle", OTHER_CHILD)
		await wait(500)
		expect(logs(h)).not.toContain("orphan watch")
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("the watch is armed when the last child goes idle and a parent stays busy", async () => {
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		expect(logs(h)).toContain("orphan watch")
		await teardown(h)
	})

	test("the watch does not act before subagentWaitMs has elapsed", async () => {
		// subagentWaitMs is the whole knob. Firing early would kill parents that are
		// simply slow.
		const h = await setup({
			active: [SID, CHILD],
			subagentWaitMs: 60_000,
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(400)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("a busy watch is not re-armed by the clock, so it still fires", async () => {
		// If a deferral pushed the start time out instead of leaving it alone, a
		// watch could be held off forever by its own deferrals.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toContain(SID)
		await teardown(h)
	})
})

describe("v2: the orphan watch refuses to kill a working parent", () => {
	test("a parent with a tool in flight is never aborted", async () => {
		// The single most damaging thing this feature could do. A parent running a
		// five-minute build looks exactly like a parent waiting on a dead child.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		push(h, "session.tool.called", SID, { tool: "bash" })
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toHaveLength(0)
		expect(logs(h)).toContain("tool(s) in flight")
		await teardown(h)
	})

	test("a finished tool releases the slot, and the watch then acts", async () => {
		// The control for the test above: if the slot were never released the watch
		// would defer forever and this feature would be inert.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		push(h, "session.tool.called", SID, { tool: "bash" })
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(200)
		expect(h.interrupted).toHaveLength(0)
		push(h, "session.tool.success", SID, { tool: "bash" })
		await wait(400)
		expect(h.interrupted).toContain(SID)
		await teardown(h)
	})

	test("a failed tool also releases the slot", async () => {
		// A failed tool is finished work. Holding the slot on failure would make the
		// watch defer on every session that has ever seen an error.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		push(h, "session.tool.called", SID, { tool: "bash" })
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(200)
		push(h, "session.tool.failed", SID, { tool: "bash" })
		await wait(400)
		expect(h.interrupted).toContain(SID)
		await teardown(h)
	})

	test("a parent waiting on the user is never aborted", async () => {
		// An open question is the user holding the ball, and injecting or aborting
		// through that interrupts their answer.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [
					userMessage("go", A_LONG_WAY_AGO),
					{
						type: "assistant",
						id: "msg_q",
						time: { created: A_LONG_WAY_AGO },
						content: [{ type: "tool", id: "c1", name: "question", state: { status: "running", input: {} } }],
					},
				],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("a subagent that is still running is waited for, not treated as dead", async () => {
		// The most damaging thing this feature could do: abort a parent in the middle
		// of a healthy fan-out. One child has finished, which is what armed the watch;
		// the other is mid-run, and the parent is waiting on it.
		const LIVE = "ses_child_live"
		const h = await setup({
			active: [SID, CHILD, LIVE],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
				[LIVE]: [assistantAt(Date.now() - 1_000)],
			},
			listRows: [{ id: SID }, { id: CHILD, parentID: SID }, { id: LIVE, parentID: SID }],
		})
		await makeBusy(h, SID)
		await wait(20)
		await makeBusy(h, LIVE)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("a subagent that finished a moment ago is not treated as crashed", async () => {
		// The control for the test above, and the reason the stuck fuse is measured
		// from the child's last message rather than from when it went idle: a child
		// that just finished is a parent making progress, not a parent stuck.
		const h = await setup({
			active: [SID, CHILD],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(Date.now() - 1_000)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(300)
		// One attempt to wake it, because a fresh-but-gone child is not "crashed"
		// and must not be reported as one.
		expect(logs(h)).not.toContain("reported an error")
		await teardown(h)
	})

	test("a slow subagent with a tool outstanding gets a longer fuse", async () => {
		// The control for the stuck threshold: 90s of silence is past the 60s
		// threshold and would read as dead, but the outstanding tool part means it is
		// a long build, so the fuse is tripled and the parent is left alone.
		const LIVE = "ses_child_slow"
		const h = await setup({
			active: [SID, CHILD, LIVE],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
				[LIVE]: [
					assistantAt(Date.now() - 90_000, [
						{ type: "tool", id: "c9", name: "bash", state: { status: "running", input: {} } },
					]),
				],
			},
			listRows: [{ id: SID }, { id: CHILD, parentID: SID }, { id: LIVE, parentID: SID }],
		})
		await makeBusy(h, SID)
		await wait(20)
		await makeBusy(h, LIVE)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toHaveLength(0)
		expect(logs(h)).not.toContain("recovery prompt sent")
		await teardown(h)
	})
})

describe("v2: a dead subagent is woken before the parent is killed", () => {
	test("CONTROL: a stuck subagent is woken before the parent is killed", async () => {
		// Waking the child is much cheaper than killing the parent: the child is one
		// nudge from finishing and the parent's whole turn survives.
		//
		// subagentWaitMs is raised so the two stages are separately observable. The
		// sequence matters and is not "recover, never abort" — it is nudge once, then
		// wait a further subagentWaitMs, and only abort the parent if the child is
		// still dead. Without the second wait a nudge and an abort would land together.
		const h = await setup({
			active: [SID, CHILD],
			subagentWaitMs: 400,
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(700)
		expect(h.interrupted).toHaveLength(0)
		const nudged = h.injected.filter((i: any) => i.sid === CHILD && /stalled or timed out/.test(i.text ?? ""))
		expect(nudged).toHaveLength(1)
		// And only once, however many ticks pass.
		await wait(400)
		expect(h.injected.filter((i: any) => i.sid === CHILD)).toHaveLength(1)
		await teardown(h)
	})

	test("a child that stays dead is escalated on the parent after a further wait", async () => {
		// The control for the nudge: if the child never comes back, the parent is the
		// only thing left to save, and it is waiting on a result that will not arrive.
		const h = await setup({
			active: [SID, CHILD],
			subagentWaitMs: 200,
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(900)
		expect(h.interrupted).toContain(SID)
		await teardown(h)
	})

	test("a crashed subagent with no way to reach it falls back to aborting the parent", async () => {
		// A crashed child cannot be woken. The parent is the only remaining thing to
		// save, and it is waiting on a result that will never arrive.
		const h = await setup({
			active: [SID, CHILD],
			sessions: { [CHILD]: {} },
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [{ type: "assistant", id: "msg_err", time: { created: A_LONG_WAY_AGO }, error: "stream disconnected", content: [] }],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toContain(SID)
		await teardown(h)
	})
})

describe("v2: the subagent list is verified, not trusted", () => {
	test("CONTROL: a host that ignores the parentID filter does not cause a wrong abort", async () => {
		// The filter is requested AND checked. If it were only requested, a host that
		// ignored it would hand back every session on the box and the watch would
		// read a stranger's children as this parent's.
		const h = await setup({
			active: [SID, CHILD],
			listIgnoresFilter: true,
			listRows: [
				{ id: SID },
				{ id: CHILD, parentID: SID },
				{ id: "ses_unrelated" },
			],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		// ses_unrelated is not this session's child, so the busy child here is CHILD
		// and the verdict is the same either way — the point is that nothing else in
		// the list was treated as a child and no stranger was touched.
		expect(h.interrupted).not.toContain("ses_unrelated")
		await teardown(h)
	})

	test("a list that returns nothing means the watch is never armed", async () => {
		// No rows could mean the API is unavailable rather than childless. Arming on
		// that reading would abort a parent on the strength of a failed query, so an
		// empty list abstains — and abstaining only costs a missed recovery.
		const h = await setup({
			active: [SID, CHILD],
			listRows: [],
			history: {
				[SID]: [userMessage("go", A_LONG_WAY_AGO)],
				[CHILD]: [assistantAt(A_LONG_WAY_AGO)],
			},
		})
		await makeBusy(h, SID)
		await wait(20)
		await childGoesBusyThenIdle(h)
		await wait(500)
		expect(h.interrupted).toHaveLength(0)
		expect(logs(h)).toContain("has no subagents")
		await teardown(h)
	})
})
