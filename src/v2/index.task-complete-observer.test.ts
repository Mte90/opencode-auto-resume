import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * auto-resume CONSUMES the `task_complete` tool; it does not own it.
 *
 * The tool lives in its own plugin (config/plugins/task-complete): it is a
 * general capability, and the tool registry is one global map per opencode
 * server, so every plugin can list it, extend it and observe its calls.
 *
 * What is auto-resume's business is the STAND-DOWN: once the model says the
 * work is done, the nudges stop. It learns about the call through the
 * registry's `execute.after` hook, which carries the tool name, the session and
 * the result - the tool reports `metadata.completed` (true when the
 * completion was accepted, false when its todo gate refused it).
 */

const LOG_SALT = "IndexTaskCompleteObserverTest"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_task_complete"
const OLD = Date.now() - 60 * 60_000

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
	// Small enough that a stall WOULD fire: the point of the latch is that it
	// does not.
	chunkTimeoutMs: 300,
	toolTextCheckDelayMs: 0,
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

type Harness = {
	hooks: Map<string, (event: any) => unknown>
	injected: Array<{ text?: string }>
	logFile: string
	history: unknown[]
	streamRef: any
	cleanup: () => void
}

/** The log file, read fresh: the plugin keeps appending after setup. */
const readLog = (h: Harness) => (existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : "")

async function setup(opts: { toolRegistry?: boolean } = {}): Promise<Harness> {
	const injected: Harness["injected"] = []
	const hooks = new Map<string, (event: any) => unknown>()
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: unknown[] = [userMessage("do the work", OLD)]

	const ctx: any = {
		event: stream,
		options: { registryScope: LOG_SALT, ...OPTIONS, logFile },
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: { session: { get: async () => ({ data: { id: SID } }) } },
		storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
	}

	if (opts.toolRegistry !== false) {
		ctx.tool = {
			transform: async () => ({ dispose() {} }),
			list: async () => [],
			hook: (name: string, cb: (event: any) => unknown) => {
				hooks.set(name, cb)
				return { dispose() {} }
			},
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return {
		hooks,
		injected,
		logFile,
		history,
		streamRef: stream,
		cleanup: cleanup as () => void,
	}
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
}

/** The tool call, as the registry reports it. */
const toolCall = (opts: { completed?: boolean; content?: string; status?: string } = {}) => ({
	tool: "task_complete",
	sessionID: SID,
	status: opts.status ?? "completed",
	result: {
		content: opts.content ?? "Task completion acknowledged.",
		metadata: { completed: opts.completed ?? true },
	},
})

describe("v2: auto-resume observes the task_complete tool", () => {
	test("the observer registers an execute.after hook", async () => {
		const h = await setup()
		expect(h.hooks.get("execute.after")).toBeDefined()
		await teardown(h)
	})

	test("CONTROL: a call from another tool is ignored", async () => {
		const h = await setup()
		await h.hooks.get("execute.after")?.({ tool: "read", sessionID: SID, status: "completed" })
		expect(h.injected.length).toBe(0)
		await teardown(h)
	})

	test("a completed call latches the stand-down - the nudges stop", async () => {
		const h = await setup()
		// The session is busy and going silent: without the latch the watchdog
		// nudges it. The first sweep also teaches the watch about the session's
		// user message, which is what a live watch has already seen.
		h.streamRef.push(ev("session.execution.started"))
		await wait(700)
		const nudgesBefore = h.injected.length
		expect(nudgesBefore).toBeGreaterThan(0)
		// The model declares the work done.
		await h.hooks.get("execute.after")?.(toolCall())
		await wait(900)
		const log = readLog(h)
		// The stand-down is the completion latch: the watchdog skips stall
		// detection for a latched session, so no further nudge is sent.
		expect(log).toContain("task_complete called")
		expect(log).toContain("completion latched")
		expect(h.injected.length).toBe(nudgesBefore)
		await teardown(h)
	})

	test("a refused completion fires the visible nudge naming the work that is left", async () => {
		// The tool's todo gate refused it (metadata.completed false). The tool
		// result carries the reminder, but a collapsed tool result would hide it,
		// so auto-resume injects it too.
		const h = await setup()
		await h.hooks.get("execute.after")?.(
			toolCall({ completed: false, content: "Mark any finished todos complete.\n1. [pending] Write the guide" }),
		)
		expect(h.injected.length).toBeGreaterThan(0)
		expect(h.injected[0].text).toContain("Write the guide")
		await teardown(h)
	})

	test("a host with no tool registry still runs the plugin", async () => {
		const h = await setup({ toolRegistry: false })
		expect(h.hooks.size).toBe(0)
		await teardown(h)
	})
})
