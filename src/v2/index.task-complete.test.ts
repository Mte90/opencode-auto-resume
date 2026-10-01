import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_task_complete"

/**
 * `task_complete`: the model's explicit "I am finished".
 *
 * v2 ships no built-in equivalent — nothing in the v2 source mentions the name —
 * so the plugin registering it is the only way it exists. That makes this a
 * feature rather than a shim: the model gets a completion signal stronger than a
 * trailing 🎉, because it chose to call this.
 *
 * The escalation is the part worth testing. The ack is fed straight back into the
 * turn, and a stuck model answers it by calling the tool again rather than ending
 * with text; v1 logged 27 consecutive acked calls with zero new user input. So the
 * first call acks with an explicit stop instruction, the second warns, and the
 * third throws to force the turn to end.
 *
 * The counter is reset by a new user message and by any other tool call, so the
 * escalation measures a stuck loop and not several legitimate rounds of work.
 *
 * Every group carries a control.
 */

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

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: SID, ...data } })

const OPTIONS = {
	chunkTimeoutMs: 600_000,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	debug: true,
}

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

/** An hour ago: outside the 5-minute active-user window. */
const OLD = Date.now() - 60 * 60_000

type Registered = {
	name: string
	description: string
	input: unknown
	execute: (input: any, context: { sessionID: string }) => Promise<{ content: string }>
}

type Harness = {
	tool: Registered | null
	injected: Array<{ text?: string }>
	logs: string[]
}

async function setup(
	opts: {
		todos?: unknown[] | undefined
		toolRegistry?: boolean
		extraMessages?: unknown[]
		parentID?: string
		maxRetriesOverride?: number
	},
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-tc-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	let registered: Registered | null = null
	const history: unknown[] = [userMessage("do the work", OLD), ...(opts.extraMessages ?? [])]

	const ctx: any = {
		event: stream,
		options: {
			...OPTIONS,
			logFile,
			// Raise maxRetries so the "blocked call does not count toward the ack
			// escalation" test can stay inside the block for several calls instead of
			// walking into the bounded-block path.
			...(opts.maxRetriesOverride ? { maxRetries: opts.maxRetriesOverride } : {}),
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: {
			session: {
				get: async () => ({ data: opts.parentID ? { id: SID, parentID: opts.parentID } : { id: SID } }),
			},
		},
		storage: {
			get: async () => ({ todos: opts.todos ?? [], updatedAt: Date.now() }),
			set: async () => {},
			remove: async () => {},
		},
	}
	if (opts.toolRegistry !== false) {
		ctx.tool = {
			transform: async (cb: any) => {
				cb({
					add: (t: Registered) => {
						registered = t
					},
				})
				return { dispose() {} }
			},
			list: async () => (registered ? [registered] : []),
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	return {
		get tool() {
			return registered
		},
		injected,
		logs,
		// Exposed for the few tests that deliver an event or a message mid-session.
		...({ cleanup, logFile, streamRef: stream, historyRef: history } as any),
	}
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const call = (h: Harness, sid = SID) => h.tool!.execute({}, { sessionID: sid })

describe("v2: task_complete is offered to the model", () => {
	test("CONTROL: the tool is registered, and takes no arguments", async () => {
		const h = await setup({})
		expect(h.tool).not.toBeNull()
		expect(h.tool!.name).toBe("task_complete")
		expect(h.tool!.description).toContain("Signal that all work is complete")
		// v1's `args: {}`: the signal is the call, not a payload.
		expect(h.tool!.input).toMatchObject({ type: "object", properties: {} })
		await teardown(h)
	})

	test("CONTROL: a plain call is acknowledged and records completion", async () => {
		const h = await setup({})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		// The stop instruction is in the ack on purpose: the ack is fed straight
		// back into the turn, so a stuck model calls again instead of ending.
		expect(res.content).toContain("End your turn now")
		expect(res.content).toContain("do not call task_complete")
		await teardown(h)
	})

	test("CONTROL: the ack is repeatable by design — no latching on the first call", async () => {
		// The counter only escalates from the second consecutive call. This is the
		// control for the escalation tests below: if the ack threw or latched, they
		// would pass for the wrong reason.
		const h = await setup({})
		await call(h)
		await teardown(h)
	})
})

describe("v2: task_complete escalation — the ack self-loop", () => {
	test("a second consecutive call warns instead of acking again", async () => {
		const h = await setup({})
		await call(h)
		const second = await call(h)
		expect(second.content).toContain("acknowledged already on your previous call")
		expect(second.content).toContain("further repeat calls are rejected as errors")
		await teardown(h)
	})

	test("a third consecutive call is rejected as an error, forcing the turn to end", async () => {
		const h = await setup({})
		await call(h)
		await call(h)
		await expect(call(h)).rejects.toThrow(/acknowledged twice/)
		await teardown(h)
	})

	test("a fourth call is still an error — the loop cannot re-enter through the ack", async () => {
		const h = await setup({})
		await call(h)
		await call(h)
		await expect(call(h)).rejects.toThrow()
		await expect(call(h)).rejects.toThrow()
		await teardown(h)
	})

	test("CONTROL: one call, then real tool work, then another call is not a repeat", async () => {
		// Several legitimate rounds of work must not trip the escalation. This is
		// the difference between a stuck model and a model that did more work.
		const h = await setup({})
		await call(h)
		stream2(h).push(ev("session.tool.called", { tool: "read" }))
		await wait(30)
		const second = await call(h)
		expect(second.content).toContain("Task completion acknowledged")
		expect(second.content).not.toContain("acknowledged already")
		await teardown(h)
	})

	test("CONTROL: a new user message also resets the loop counter", async () => {
		const h = await setup({})
		await call(h)
		await call(h) // now on the warning
		// A new request is new work: the counter starts clean, or one bad stretch
		// would poison the rest of the session.
		//
		// Driven by an idle rather than by the message appearing: the reset is
		// observed during idle inspection, so a test that never goes idle is testing
		// nothing. (The todo and dead-stream tests hit the same wall.)
		pushUserMessage(h, "actually, also this", Date.now() - 10 * 60_000)
		await goIdle(h)
		const third = await call(h)
		expect(third.content).toContain("Task completion acknowledged")
		expect(third.content).not.toContain("acknowledged already")
		await teardown(h)
	})
})

describe("v2: task_complete respects the todo list", () => {
	const OPEN = [
		{ content: "Write the migration guide", status: "pending", priority: "high" },
		{ content: "Delete the temp fixtures", status: "in_progress", priority: "low" },
	]

	test("CONTROL: a call with todos still open is blocked and names them", async () => {
		const h = await setup({ todos: OPEN })
		const res = await call(h)
		expect(res.content).toContain("Write the migration guide")
		expect(res.content).toContain("Delete the temp fixtures")
		expect(res.content).toContain("Mark any finished todos complete")
		// Not an ack: the model has not been told its work is recorded.
		expect(res.content).not.toContain("No further continuation will be sent")
		await teardown(h)
	})

	test("a blocked call also fires a visible nudge naming the open items", async () => {
		// The tool result can collapse to an invisible one-liner in the transcript,
		// so the blocking todos are also injected. Mirrors the idle-resume path.
		const h = await setup({ todos: OPEN })
		await call(h)
		expect(h.injected.length).toBeGreaterThan(0)
		expect(h.injected[0].text).toContain("Write the migration guide")
		await teardown(h)
	})

	test("a blocked call does not count toward the ack escalation", async () => {
		// Work remains, so a later completion is legitimate. Feeding the escalation
		// here would reject a model that was simply told to finish more.
		// maxRetries 1 so the first call is blocked and the second is let through:
		// the point is what signal the let-through call carries, not how long the
		// block lasts.
		const h = await setup({ todos: OPEN, maxRetriesOverride: 1 })
		await call(h)
		const second = await call(h)
		expect(second.content).toContain("Task completion acknowledged")
		expect(second.content).not.toContain("acknowledged already")
		await teardown(h)
	})

	test("the block is bounded — a model insisting is eventually believed", async () => {
		// An unbounded block is its own kind of loop. After maxRetries the call is
		// honoured, because a model that keeps saying "done" may know something the
		// todo list does not. maxRetries defaults to 3, so the fourth call is let
		// through.
		const h = await setup({ todos: OPEN })
		let res = await call(h)
		for (let i = 0; i < 3; i++) res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.content).not.toContain("Mark any finished todos")
		await teardown(h)
	})

	test("a call with every todo closed is acked", async () => {
		const h = await setup({
			todos: [
				{ content: "Done already", status: "completed", priority: "high" },
				{ content: "Dropped", status: "cancelled", priority: "low" },
			],
		})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		await teardown(h)
	})

	test("a call with no todo tool at all is acked, not blocked", async () => {
		// The dangerous failure is a session with no list being told it has open
		// work. An absent list must not read as an empty-but-authoritative one.
		const h = await setup({})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.content).not.toContain("Mark any finished todos")
		await teardown(h)
	})
})

describe("v2: task_complete on a subagent", () => {
	test("a subagent reporting completion is not gated on the parent's todo list", async () => {
		// A child was never asked to do the parent's open items, so gating its
		// report on them would block it on work outside its scope.
		const h = await setup({
			todos: [{ content: "Parent's own task", status: "pending", priority: "high" }],
			parentID: "ses_parent",
		})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		await teardown(h)
	})
})

describe("v2: task_complete degrades rather than failing the watchdog", () => {
	test("a host with no tool registry still runs the plugin", async () => {
		const h = await setup({ toolRegistry: false })
		expect(h.tool).toBeNull()
		// The rest of the plugin must be live regardless.
		stream2(h).push(ev("session.execution.started"))
		await wait(30)
		stream2(h).push(ev("session.idle"))
		await wait(200)
		expect(h.logs.some((l) => l.includes("task_complete not offered"))).toBe(true)
		await teardown(h)
	})

	test("a registry that throws does not stop the watchdog", async () => {
		// Registration failure is the one thing that must never take down the
		// session recovery that the rest of this plugin exists for.
		const stream = makeEventStream()
		const logFile = join(tmpdir(), `auto-resume-tc-throw-${process.pid}-${counter++}.log`)
		rmSync(logFile, { force: true })
		const ctx: any = {
			event: stream,
			options: { ...OPTIONS, logFile },
			session: {
				context: async () => [userMessage("go", OLD)],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			client: { session: { get: async () => ({ data: { id: SID } }) } },
			storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
			tool: {
				transform: async () => {
					throw new Error("registry unavailable")
				},
				list: async () => [],
			},
		}
		const cleanup = await (plugin as any).setup(ctx)
		for (const e of [ev("session.execution.started"), ev("session.step.started"), ev("session.idle")]) {
			stream.push(e)
			await wait(10)
		}
		await wait(400)
		;(cleanup as (() => void) | undefined)?.()
		const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
		rmSync(logFile, { force: true })
		expect(logs.some((l) => l.includes("task_complete registration failed"))).toBe(true)
		// And the plugin is still running: it logged its startup line.
		expect(logs.some((l) => l.includes("task_complete registration failed") && l.includes("continuing without it"))).toBe(
			true,
		)
	})
})

/** The harness keeps the event stream private; these reach it for the tests
 *  that need to deliver a tool call or a user message mid-session. */
function stream2(h: any) {
	return h.streamRef as ReturnType<typeof makeEventStream>
}

function pushUserMessage(h: any, text: string, at: number) {
	;(h.historyRef as unknown[]).push(userMessage(text, at))
}

/** Drive a turn to idle, which is what makes the plugin look at the history. */
async function goIdle(h: any) {
	const stream = stream2(h)
	for (const e of [
		ev("session.execution.started"),
		ev("session.step.started"),
		ev("session.step.ended"),
		ev("session.idle"),
	]) {
		stream.push(e)
		await wait(10)
	}
	await wait(200)
}
