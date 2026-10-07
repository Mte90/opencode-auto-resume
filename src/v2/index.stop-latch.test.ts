import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: explicit stop statements latch completion like celebrations.
 *
 * ses_eec5ba74 (2026-10-07): "No action needed … Stopping here" kept
 * collecting nudges after the work was finished. A bare stop carries no
 * done-claim for the details challenge and no celebration emoji, so every
 * idle detector passed over it. Stop language now latches completion when
 * no todos are open (open todos still get the once-budgeted reminder), and
 * the busy-stall path respects a latched completion — safe because any
 * fresh turn clears the latch in markBusy.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 7000

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

const errPart = (name: string, id: string) => ({
	type: "tool",
	id,
	name,
	state: { status: "error", input: {} },
})

async function setup(opts: {
	messages?: unknown[]
	todos?: Array<{ content: string; status: string }>
	toolIds?: string[]
	onAdd?: (def: any) => void
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-stop-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const messages = opts.messages ?? []
	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => messages,
			// Prod has no active-session surface: always empty, so busy
			// comes only from events. Reporting the session active here
			// would re-mark idle sessions busy every tick and manufacture
			// stall recoveries no real deployment can produce.
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
			transform: async (cb: any) => (cb({ add: (def: any) => opts.onAdd?.(def) }), { dispose() {} }),
			list: async () => (opts.toolIds ?? []).map((id) => ({ id })),
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

const STOP_TEXT = "No action needed — the task is complete and all todos are closed. Stopping here."

describe("v2: explicit stop statements latch completion", () => {
	test("stop text latches: no unknown-tool nudge on the same idle", async () => {
		const h = await setup({
			toolIds: ["shell", "bash", "read"],
			messages: [
				{
					type: "assistant",
					id: "msg_a",
					time: { created: Date.now() - 5_000 },
					content: [
						{ type: "text", text: STOP_TEXT },
						errPart("bashh", "p1"),
						errPart("bashh", "p2"),
					],
				},
			],
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(600)
		console.log('DBG INJECTED:', JSON.stringify(h.injected))
		expect(h.injected).toHaveLength(0)
		await teardown(h)
	})

	test("stop text with open todos still earns the once-budgeted reminder", async () => {
		const h = await setup({
			messages: [
				{
					type: "assistant",
					id: "msg_a",
					time: { created: Date.now() - 5_000 },
					content: [{ type: "text", text: "Stopping here." }],
				},
			],
			todos: [{ content: "unfinished business", status: "pending" }],
		})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(600)
		expect(h.injected.length).toBeGreaterThan(0)
		expect(h.injected[0].text).toMatch(/unfinished business/)
		await teardown(h)
	})

	test("busy-stall respects a latched completion", async () => {
		const defs: any[] = []
		const h = await setup({ onAdd: (d: any) => defs.push(d) })
		const complete = defs.find((d: any) => d.name === "task_complete")
		expect(complete).toBeDefined()
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(10)
		await complete.execute({}, { sessionID: SID })
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: busy-stall without completion still recovers", async () => {
		const h = await setup({})
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(10)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})
})
