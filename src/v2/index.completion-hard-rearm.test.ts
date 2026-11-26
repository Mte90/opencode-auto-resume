import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const SALT = "IndexCompletionHardRearm"
let tempHome = ""
let prevHome: string | undefined
let prevState: string | undefined
let prevXdg: string | undefined
let prevConfig: string | undefined
const SID = "ses_completion_hard_rearm"

beforeAll(async () => {
	tempHome = await mkdtemp(join(tmpdir(), "oc-ar-hard-rearm-"))
	prevHome = process.env.HOME
	prevState = process.env.XDG_STATE_HOME
	prevXdg = process.env.XDG_CONFIG_HOME
	prevConfig = process.env.OPENCODE_CONFIG_DIR
	process.env.HOME = tempHome
	process.env.XDG_STATE_HOME = join(tempHome, ".local", "state")
	process.env.XDG_CONFIG_HOME = join(tempHome, ".config")
	process.env.OPENCODE_CONFIG_DIR = join(tempHome, ".config", "opencode")
	await chmod(tempHome, 0o700)
})

afterAll(async () => {
	if (prevHome === undefined) delete process.env.HOME
	else process.env.HOME = prevHome
	if (prevState === undefined) delete process.env.XDG_STATE_HOME
	else process.env.XDG_STATE_HOME = prevState
	if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
	else process.env.XDG_CONFIG_HOME = prevXdg
	if (prevConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
	else process.env.OPENCODE_CONFIG_DIR = prevConfig
	if (tempHome) await rm(tempHome, { recursive: true, force: true })
})

function makeEventStream() {
	const queue: any[] = []
	const waiters: Array<(ev: any) => void> = []
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const userMessage = (text: string, at: number, id = "msg_u") => ({
	type: "user", id, time: { created: at }, content: [{ type: "text", text }],
})
const assistantText = (text: string, at: number, id = "msg_a") => ({
	type: "assistant", id, time: { created: at }, content: [{ type: "text", text }],
})

async function setup(opts: { chunkTimeoutMs?: number } = {}) {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const now = Date.now()
	const history: Record<string, unknown[]> = {
		[SID]: [
			userMessage("do the work", now - 60_000, "msg_u1"),
			assistantText("Working on the deploy.", now - 1000),
		],
	}
	let tool: any = null
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 60_000, toolTextCheckDelayMs: 0, checkIntervalMs: 20,
			gracePeriodMs: 0, warmupMs: 0, baseBackoffMs: 1, maxBackoffMs: 2,
			maxRetries: 3, injectIntervalMs: 0, subagentWaitMs: 40, debug: true,
			registryScope: SALT,
		},
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => ({ [SID]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: { session: { get: async ({ path }: any) => ({ data: { id: path?.id } }), list: async () => ({ data: [{ id: SID }] }) } },
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => {
				cb({ add: (t: any) => { tool = t } })
				return { dispose() {} }
			},
			list: async () => (tool ? [tool] : []),
		},
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	const push = (type: string, data: Record<string, unknown> = {}) =>
		stream.push({ type, data: { sessionID: SID, ...data } })
	return {
		injected, cleanup, capture, push, history,
		call: () => tool.execute({}, { sessionID: SID }),
		logs: () => capture.lines.join("\n"),
	}
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
}

async function waitFor(what: () => boolean, budgetMs = 3000): Promise<boolean> {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) { if (what()) return true; await wait(10) }
	return what()
}

const nudges = (h: any) => h.injected.filter((i: any) => i.sid === SID && !String(i.text ?? "").startsWith("auto-resume ")).length

describe("completionHard re-armed by a genuine user message", () => {
	test("a genuine user message after task_complete re-arms the regular stall nudge", async () => {
		const h = await setup({ chunkTimeoutMs: 120 })
		await h.call()
		const before = nudges(h)
		h.history[SID] = [
			...h.history[SID],
			userMessage("keep going", Date.now() + 1000, "msg_u2"),
			assistantText("Working on it.", Date.now() + 1500, "msg_a2"),
		]
		await wait(80)
		h.push("session.execution.started")
		expect(await waitFor(() => nudges(h) > before, 1500)).toBe(true)
		await teardown(h)
	})

	test("an own injected prompt does NOT re-open the hard latch", async () => {
		const h = await setup()
		await h.call()
		h.history[SID] = [
			...h.history[SID],
			userMessage("continue — stalled (attempt 1/3)", Date.now() + 1000, "msg_own"),
		]
		await wait(80)
		h.push("session.execution.interrupted", { reason: "inactivity" })
		await wait(400)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})

	test("a synthetic interruption message does NOT re-open the hard latch", async () => {
		const h = await setup()
		await h.call()
		h.history[SID] = [
			...h.history[SID],
			userMessage("The previous response was interrupted. Continue from where you left off.", Date.now() + 1000, "msg_syn"),
		]
		await wait(80)
		h.push("session.execution.interrupted", { reason: "inactivity" })
		await wait(400)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})

	test("a stale pre-latch user message discovered late does NOT re-open the hard latch", async () => {
		const h = await setup()
		await h.call()
		h.history[SID] = [
			...h.history[SID],
			userMessage("an older instruction", Date.now() - 120_000, "msg_stale"),
		]
		await wait(80)
		h.push("session.execution.interrupted", { reason: "inactivity" })
		await wait(400)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})

	test("a user interrupt still stands down after the latch is re-opened", async () => {
		const h = await setup()
		await h.call()
		h.history[SID] = [
			...h.history[SID],
			userMessage("next request", Date.now() + 1000, "msg_u2"),
			assistantText("On it.", Date.now() + 1500, "msg_a2"),
		]
		await wait(80)
		h.push("session.execution.interrupted", { reason: "user" })
		await wait(400)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})
});
