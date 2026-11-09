import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "IndexCounterFixesPr51"

let tempHome = ""
let prevHome: string | undefined
let prevState: string | undefined
let prevXdg: string | undefined
let prevConfig: string | undefined

const SID = "ses_counter_fixes_pr51"

beforeAll(async () => {
	tempHome = await mkdtemp(join(tmpdir(), "oc-ar-pr51-"))
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

afterEach(() => {
	try {
		;(globalThis as any).__opencodeAutoResumeV2Registry = undefined
	} catch {}
})

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

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
	debug: true,
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

async function setup(history: Record<string, unknown[]>, extraOpts: Record<string, unknown> = {}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT, ...extraOpts },
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
	return { injected, cleanup, capture, streamRef: stream, history }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function waitForLog(capture: any, needle: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (capture.lines.join("\n").includes(needle)) return true
		if (Date.now() >= deadline) return false
		await wait(25)
	}
}

async function waitFor(what: () => boolean, budgetMs = 4000): Promise<boolean> {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (what()) return true
		await wait(10)
	}
	return what()
}

const attemptOf = (text: string | undefined): string | null => /attempt (\d+)\/\d+/.exec(text ?? "")?.[1] ?? null
const retryOf = (text: string | undefined): string | null => /retry #(\d+)/.exec(text ?? "")?.[1] ?? null

describe("PR51: synthetic interruption recovery does not re-arm counters", () => {
	test("synthetic interruption message keeps userCancelled latched", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(50)
		history[SID] = [
			userMessage("go", now - 60_000, "msg_u1"),
			userMessage("The previous response was interrupted. Continue from where you left off.", Date.now(), "msg_syn"),
			assistantText("working", Date.now()),
		]
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.step.started", SID)
		await wait(900)
		const logs = h.capture.lines.join("\n")
		await teardown(h)
		expect(logs).toContain("synthetic interruption-recovery message — keeping userCancelled latched")
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
	})
})

describe("PR51: user stop cancels queued recovery", () => {
	test("a user interrupt before the backoff timer fires prevents injection", async () => {
		const now = Date.now()
		const history: Record<string, unknown[]> = {
			[SID]: [userMessage("go", now - 60_000, "msg_u1")],
		}
		const h = await setup(history, { baseBackoffMs: 1000, maxBackoffMs: 1000 })
		push(h, "session.execution.started", SID)
		expect(await waitForLog(h.capture, "idle/unknown -> busy", 5000)).toBe(true)
		const armed = await waitForLog(h.capture, "resume attempt 1/3", 5000)
		expect(armed).toBe(true)
		push(h, "session.execution.interrupted", SID, { reason: "user" })
		await wait(1500)
		await teardown(h)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
	})
})

describe("PR51: workRetries preserved across execution.started fallback", () => {
	test("a successful tool between stalls advances retry count without a false fallback drop", async () => {
		// After the model does work (tool.success) between stalls, the retry/work
		// count should reflect that progress. The execution.started fallback must
		// not reset workRetries when ownRung is misclassified mid-episode.
		const h = await setup({ [SID]: [userMessage("go", Date.now() - 60_000, "msg_u1")] })
		push(h, "session.execution.started", SID)
		await wait(10)
		await waitFor(() => h.injected.length >= 1, 5000)
		// Model answers the nudge and does work.
		push(h, "session.tool.success", SID, { tool: "shell", id: "call_1" })
		await wait(20)
		push(h, "session.execution.started", SID)
		await wait(10)
		push(h, "session.idle", SID)
		await wait(10)
		push(h, "session.execution.started", SID)
		await waitFor(() => h.injected.length >= 2, 5000)
		const retries = h.injected.map((i: any) => retryOf(i.text)).filter(Boolean)
		await teardown(h)
		expect(retries.length).toBeGreaterThanOrEqual(2)
		// Retry count must not drop back to #1 on a false execution.started fallback.
		expect(retries[retries.length - 1]).not.toBe("1")
	})
})

describe("PR51: selfInjectFresh tolerates inject/user clock skew", () => {
	test("own prompt just after inject is not treated as a genuine new episode", async () => {
		// A message from our own inject can land with timestamps slightly skewed.
		// selfInjectFresh must tolerate OWN_PROMPT_TIME_MS skew so we do not start
		// a false new episode and reset counters.
		const messages: any[] = []
		const h = await setup({ [SID]: messages }, {})
		push(h, "session.execution.started", SID)
		await wait(20)
		await waitFor(() => h.injected.length >= 1, 5000)
		const first = h.injected[0]?.text ?? ""
		// Record our own prompt in history with a timestamp very close to inject
		// (simulating skew where message time can be slightly after lastGenuineUserAt).
		messages.push({
			id: "u_own",
			role: "user",
			time: { created: Date.now() },
			text: first || "continue — stalled (attempt 1/3 (retry #1); idle).\nOnly continue work already in progress. No open todos recorded.",
		})
		await waitFor(() => h.injected.length >= 2, 5000)
		const logs = h.capture.lines.join("\n")
		const retries = h.injected.map((i: any) => retryOf(i.text)).filter(Boolean)
		await teardown(h)
		// Must not treat our own prompt as a genuine user message restarting ladder.
		expect(logs).not.toContain("new user message — restarting the stall ladder")
		if (retries.length >= 2) expect(retries[0]).toBe("1")
	})
})
