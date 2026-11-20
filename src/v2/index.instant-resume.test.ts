import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const SALT = "IndexInstantResume"
let tempHome = ""
let prevHome: string | undefined
let prevState: string | undefined
let prevXdg: string | undefined
let prevConfig: string | undefined
const SID = "ses_instant_resume"

beforeAll(async () => {
	tempHome = await mkdtemp(join(tmpdir(), "oc-ar-instant-"))
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
const assistantText = (text: string, at: number) => ({
	type: "assistant", id: "msg_a", time: { created: at }, content: [{ type: "text", text }],
})

async function setup(opts: { tail?: string; extraOpts?: Record<string, unknown> } = {}) {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const now = Date.now()
	const history: Record<string, unknown[]> = {
		[SID]: [
			userMessage("do the work", now - 60_000, "msg_u1"),
			assistantText(opts.tail ?? "Working on the deploy, but the live config", now - 1000),
		],
	}
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			chunkTimeoutMs: 60_000, toolTextCheckDelayMs: 0, checkIntervalMs: 20,
			gracePeriodMs: 0, warmupMs: 0, baseBackoffMs: 1, maxBackoffMs: 2,
			maxRetries: 3, injectIntervalMs: 0, subagentWaitMs: 40, debug: true,
			registryScope: SALT, ...opts.extraOpts,
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
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	const push = (type: string, data: Record<string, unknown> = {}) =>
		stream.push({ type, data: { sessionID: SID, ...data } })
	return { injected, cleanup, capture, push, history, logs: () => capture.lines.join("\n") }
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

describe("instant resume after non-user interruption", () => {
	test("inactivity interrupt sends one continue immediately, no timer wait", async () => {
		const h = await setup()
		h.push("session.execution.interrupted", { reason: "inactivity" })
		expect(await waitFor(() => nudges(h) >= 1, 1500)).toBe(true)
		expect(nudges(h)).toBe(1)
		await teardown(h)
	})

	test("shutdown and superseded reasons also resume", async () => {
		for (const reason of ["shutdown", "superseded"]) {
			const h = await setup()
			h.push("session.execution.interrupted", { reason })
			expect(await waitFor(() => nudges(h) >= 1, 1500)).toBe(true)
			await teardown(h)
		}
	})

	test("a user-reason interrupt with no new user message still resumes", async () => {
		const h = await setup()
		h.push("session.execution.interrupted", { reason: "user" })
		expect(await waitFor(() => nudges(h) >= 1, 1500)).toBe(true)
		expect(nudges(h)).toBe(1)
		await teardown(h)
	})

	test("a user message at the interruption still stands down", async () => {
		const h = await setup()
		h.history[SID].push(userMessage("stop please", Date.now() + 5000, "msg_u2"))
		h.push("session.execution.interrupted", { reason: "user" })
		await wait(600)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})

	test("an unknown or missing reason defaults to user-safe (no continue)", async () => {
		const h1 = await setup()
		h1.push("session.execution.interrupted", { reason: "brand_new_runtime_reason" })
		await wait(600)
		expect(nudges(h1)).toBe(0)
		await teardown(h1)
		const h2 = await setup()
		h2.push("session.execution.interrupted")
		await wait(600)
		expect(nudges(h2)).toBe(0)
		await teardown(h2)
	})

	test("a trailing TASK COMPLETE last line suppresses the instant continue", async () => {
		const h = await setup({ tail: "All done.\nTASK COMPLETE" })
		h.push("session.execution.interrupted", { reason: "inactivity" })
		await wait(600)
		expect(nudges(h)).toBe(0)
		await teardown(h)
	})

	test("the instant continue counts as the episode's first continue (budget recorded)", async () => {
		const h = await setup()
		h.push("session.execution.interrupted", { reason: "inactivity" })
		expect(await waitFor(() => nudges(h) >= 1, 1500)).toBe(true)
		// A second interruption in the same episode must not stack a second immediate continue.
		h.push("session.execution.interrupted", { reason: "inactivity" })
		await wait(600)
		expect(nudges(h)).toBe(1)
		await teardown(h)
	})
})
