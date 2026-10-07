import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: a genuine new user message re-arms recovery after a user interrupt.
 *
 * ses_eeb02d4b (2026-10-07): after an interrupt, auto-resume never got the
 * session going again — not even after an explicit user "continue".
 * `userCancelled` latched permanently: set once on a non-plugin interrupt
 * and cleared nowhere (not on new user messages, not on new turns), while
 * every recovery path checks it first. A new inbound user message is the
 * hand-back signal and re-arms alongside the other budgets — own injected
 * prompts excluded, as with every other re-arm.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 6000

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

const userMessage = (text: string, at: number, id = "msg_u") => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantText = (text: string, at: number) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	content: [{ type: "text", text }],
})

async function setup(history: Record<string, unknown[]>): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-rearm-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => ({ [SID]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream, history }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

describe("v2: genuine user message re-arms after user interrupt", () => {
	test("interrupt latches, then a new user message re-arms recovery", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(50)
		// Genuine new inbound user message, then a fresh turn that stalls.
		history[SID] = [
			userMessage("go", now - 60_000, "msg_u1"),
			userMessage("continue", Date.now(), "msg_u2"),
			assistantText("working", Date.now()),
		]
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})

	test("CONTROL: interrupt with no new user message stays stood down", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(50)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})
})
