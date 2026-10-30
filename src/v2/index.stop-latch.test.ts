import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexStopLatchTest"

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
	onHook?: (name: string, cb: (event: any) => unknown) => void
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const messages = opts.messages ?? []
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT },
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
			// The task_complete tool now lives in its own plugin, so auto-resume
			// only SEES its calls - through this hook.
			hook: (name: string, cb: (event: any) => unknown) => {
				opts.onHook?.(name, cb)
				return { dispose() {} }
			},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
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
		// The completion signal arrives as a task_complete CALL, which auto-resume
		// observes through the tool registry's execute.after hook (the tool itself
		// lives in its own plugin now).
		let onAfter: ((event: any) => unknown) | undefined
		const h = await setup({ onHook: (name: string, cb: any) => { if (name === "execute.after") onAfter = cb } })
		expect(onAfter).toBeDefined()
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(10)
		await onAfter?.({
			tool: "task_complete",
			sessionID: SID,
			status: "completed",
			result: { content: "Task completion acknowledged.", metadata: { completed: true } },
		})
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
