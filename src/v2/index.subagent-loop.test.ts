import { describe, test, expect, afterEach } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"
import { SUBAGENT_LOOP_RECOVERY_PROMPT } from "../recovery/shared"

/** Unique per test FILE: bun runs every file in one process, so two files
 * starting their counters at 0 derive the SAME tmpdir log path and read each
 * other's writes. */
const LOG_SALT = "IndexSubagentLoopTest"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent_lp"
const CHILD = "ses_child_lp"

const realFetch = globalThis.fetch
const realServerPort = process.env.OPENCODE_SERVER_PORT

afterEach(() => {
	globalThis.fetch = realFetch
	if (realServerPort === undefined) delete process.env.OPENCODE_SERVER_PORT
	else process.env.OPENCODE_SERVER_PORT = realServerPort
})

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
	injectIntervalMs: 0,
	subagentWaitMs: 600_000,
	debug: false,
}

const toolMsg = (parts: Array<Record<string, unknown>>, at: number) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: parts,
})

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: "msg_u",
	time: { created: at },
	content: [{ type: "text", text }],
})

type History = Record<string, unknown[]>

async function setup(history: History) {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { registryScope: LOG_SALT, ...OPTIONS },
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => ({ [CHILD]: {} }),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
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

/** Loopback session list stub: the shape prod GET /api/session returns. */
function stubSessionList(rows: Array<{ id: string; parentID?: string }>) {
	globalThis.fetch = (async (url: any) => {
		const u = String(url)
		if (u.includes("/api/session?") || u.endsWith("/api/session")) {
			return { ok: true, json: async () => ({ data: rows }) } as any
		}
		return { ok: false, status: 404, json: async () => ({}) } as any
	}) as any
}

async function makeBusy(h: any, sid: string) {
	h.streamRef.push(ev("session.execution.started", sid))
	await wait(10)
	h.streamRef.push(ev("session.step.started", sid))
	await wait(10)
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (cond()) return true
		await wait(10)
	}
	return cond()
}

describe("v2: subagent same-command loop", () => {
	test("identical repeated commands → loop-breaker prompt with todowrite reset", async () => {
		process.env.OPENCODE_SERVER_PORT = "18241"
		stubSessionList([{ id: SID }, { id: CHILD, parentID: SID }])
		const now = Date.now()
		const h = await setup({
			[CHILD]: [
				userMessage("go", now - 60_000),
				toolMsg(
					[
						{ type: "tool", name: "bash", input: { command: "grep -r foo src/" }, state: { status: "error" } },
						{ type: "tool", name: "bash", input: { command: "grep -r foo src/" }, state: { status: "error" } },
						{ type: "tool", name: "bash", input: { command: "grep -r foo src/" }, state: { status: "error" } },
						{ type: "tool", name: "bash", input: { command: "grep -r foo src/" }, state: { status: "error" } },
						{ type: "tool", name: "bash", input: { command: "grep -r foo src/" }, state: { status: "error" } },
					],
					now - 1_000,
				),
			],
		})
		await makeBusy(h, CHILD)

		const sent = await waitFor(() =>
			h.injected.some((i: any) => i.sid === CHILD && i.text === SUBAGENT_LOOP_RECOVERY_PROMPT),
		)
		expect(sent).toBe(true)
		expect(SUBAGENT_LOOP_RECOVERY_PROMPT).toContain("todowrite")
		await teardown(h)
	})

	test("after two corrections the looping subagent is killed (interrupted)", async () => {
		process.env.OPENCODE_SERVER_PORT = "18242"
		stubSessionList([{ id: SID }, { id: CHILD, parentID: SID }])
		const now = Date.now()
		const h = await setup({
			[CHILD]: [
				userMessage("go", now - 60_000),
				toolMsg(
					Array.from({ length: 5 }, () => ({
						type: "tool",
						name: "edit",
						input: { filePath: "x.rs", edits: "." },
						state: { status: "error" },
					})),
					now - 1_000,
				),
			],
		})
		await makeBusy(h, CHILD)

		const correctedTwice = await waitFor(
			() => h.injected.filter((i: any) => i.sid === CHILD && i.text === SUBAGENT_LOOP_RECOVERY_PROMPT).length >= 2,
		)
		expect(correctedTwice).toBe(true)
		const killed = await waitFor(() => h.interrupted.includes(CHILD))
		expect(killed).toBe(true)
		await teardown(h)
	})

	test("varied commands are not a loop (control)", async () => {
		process.env.OPENCODE_SERVER_PORT = "18243"
		stubSessionList([{ id: SID }, { id: CHILD, parentID: SID }])
		const now = Date.now()
		const h = await setup({
			[CHILD]: [
				userMessage("go", now - 60_000),
				toolMsg(
					[
						{ type: "tool", name: "bash", input: { command: "ls" }, state: { status: "completed" } },
						{ type: "tool", name: "read", input: { path: "a.ts" }, state: { status: "completed" } },
						{ type: "tool", name: "bash", input: { command: "pwd" }, state: { status: "completed" } },
						{ type: "tool", name: "grep", input: { pattern: "x" }, state: { status: "completed" } },
						{ type: "tool", name: "write", input: { path: "b.ts" }, state: { status: "completed" } },
					],
					now - 1_000,
				),
			],
		})
		await makeBusy(h, CHILD)

		await wait(500)
		expect(h.injected.filter((i: any) => i.sid === CHILD)).toHaveLength(0)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("invalid tool calls with unparseable args count as identical (real-world loop)", async () => {
		process.env.OPENCODE_SERVER_PORT = "18244"
		stubSessionList([{ id: SID }, { id: CHILD, parentID: SID }])
		const now = Date.now()
		const h = await setup({
			[CHILD]: [
				userMessage("go", now - 60_000),
				toolMsg(
					Array.from({ length: 5 }, () => ({
						type: "tool",
						name: "edit",
						state: { status: "error" },
					})),
					now - 1_000,
				),
			],
		})
		await makeBusy(h, CHILD)

		const sent = await waitFor(() =>
			h.injected.some((i: any) => i.sid === CHILD && i.text === SUBAGENT_LOOP_RECOVERY_PROMPT),
		)
		expect(sent).toBe(true)
		await teardown(h)
	})
})
