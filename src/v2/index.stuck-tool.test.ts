import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexStuckToolTest"

/**
 * v2: a turn parked on a tool result that never arrives gets a nudge.
 *
 * ses_edf403f5 (2026-10-09): model hit max context, called `compress` at
 * 13:09:44, turn ended 2s later, idle ever since — the call stuck at status
 * "streaming" with no result. ses_ee14d727: same shape with a `write` left
 * streaming. In both cases the plugin read healthy-idle (pendingTools === 0,
 * no failure, no stall) and stayed silent.
 *
 * The event-counted pendingTools only sees what the plugin observed live, so
 * this reads the history instead: unfinished tool parts (anything but
 * completed/error) newer than the last user message and older than the stall
 * window mean the turn is parked, not done.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The idle inspection is promise-chained and event-driven, and this file runs
 * while the suite runs 79 files in parallel. Measured on 2026-10-11: under full
 * suite contention the nudge for a stuck call was DECIDED at ~2.65s (the
 * plugin's own log line "tool call(s) ... stuck unfinished — nudging" lands
 * there) even though every mock resolves instantly — the whole process is
 * simply starved. Bun's 5s default leaves no room for that, so the six tests
 * that wait on a nudge get a real budget instead of racing one.
 */
const POLL_MS = 8_000
setDefaultTimeout(30_000)
const SID = "ses_parent"

let counter = 17000

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
const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const OLD = Date.now() - 3600_000
const TOOLS = [{ id: "read" }, { id: "write" }, { id: "shell" }, { id: "task_complete" }, { id: "compress" }]

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const toolPart = (id: string, name: string, status: string, at: number, err?: unknown) => ({
	type: "tool",
	id,
	name,
	time: { created: at },
	state: { status, input: {}, ...(err === undefined ? {} : { error: err }) },
})

const assistantWith = (at: number, ...content: unknown[]) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text: "Working on it." }, ...content],
})

async function setup(history: unknown[], opts: { chunkTimeoutMs?: number } = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-stucktool-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 50,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			logFile,
			debug: true,
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => TOOLS,
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

/**
 * Drive the session idle, then wait for the idle inspection's async chain.
 *
 * The nudge path is promise-chained — history read, then prompt build, then
 * inject — so the old fixed `wait(300)` raced it: under the suite's parallel
 * load it sometimes returned before the nudge landed and the test saw zero
 * nudges (2026-10-10, 1 run in 3). `expectNudge` polls for the outcome instead.
 *
 * The CONTROLs deliberately keep the short fixed wait: their assertion is that
 * NOTHING was sent, so waiting longer could only make them weaker, and a slow
 * idle inspection is not evidence of a nudge.
 */
async function goIdle(h: any, expectNudge = false) {
	for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
		h.streamRef.push(ev(e, SID))
		await wait(10)
	}
	if (!expectNudge) {
		await wait(300)
		return
	}
	const deadline = Date.now() + POLL_MS
	while (Date.now() < deadline) {
		if (h.injected.some((i: any) => /never returned a result|Retry it now/.test(i.text ?? ""))) return
		await wait(25)
	}
}

const stuckNudges = (h: any) => h.injected.filter((i: any) => /never returned a result/.test(i.text ?? ""))
const retryNudges = (h: any) => h.injected.filter((i: any) => /Retry it now/.test(i.text ?? ""))

describe("v2: turns parked on an unanswered tool call", () => {
	test("a streaming compress call earns a proceed-without-it nudge", async () => {
		const h = await setup([
			userMessage("do the sync job", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "compress", "streaming", OLD + 2000)),
		])
		await goIdle(h, true)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"compress"')
	})

	test("a running write call earns one too", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "write", "running", OLD + 2000)),
		])
		await goIdle(h, true)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"write"')
	})

	test("CONTROL: settled calls get nothing", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "write", "completed", OLD + 2000)),
			assistantWith(OLD + 3000, toolPart("call_2", "shell", "error", OLD + 4000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a fresh call has not had a chance to answer yet", async () => {
		// Production-scale window: a call seconds old is live, not stuck. (With
		// the 50ms test default every fixed timestamp ages past the cutoff
		// during goIdle, so this CONTROL needs its own window.)
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 1000),
				assistantWith(now - 500, toolPart("call_1", "shell", "running", now - 500)),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a user message after the call means the turn moved on", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "shell", "running", OLD + 2000)),
			userMessage("never mind, do this instead", OLD + 5000),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("a call stuck 61s nudges without waiting the stall window", async () => {
		// The age gate is 60s by default, not the ~3min stall window: idle plus
		// an unfinished call is already conclusive, the turn ended. Deterministic
		// fixed timestamps, no waiting.
		const now = Date.now()
		const h = await setup([
			userMessage("go", now - 120_000),
			assistantWith(now - 61_000, toolPart("call_1", "shell", "running", now - 61_000)),
		])
		await goIdle(h, true)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
	})

	test("CONTROL: a 30s-old call is still inside the age gate", async () => {
		const now = Date.now()
		const h = await setup([
			userMessage("go", now - 120_000),
			assistantWith(now - 30_000, toolPart("call_1", "shell", "running", now - 30_000)),
		])
		await goIdle(h)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("a failed compress is retried promptly, with no age wait", async () => {
		// Fresh error (seconds old, inside the 60s age gate): failures of listed
		// tools do not wait — the session cannot proceed until compress works.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(now - 2000, toolPart("call_1", "compress", "error", now - 2000, "boom: provider hiccup")),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h, true)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"compress"')
		expect(said[0].text).toContain("boom: provider hiccup")
	})

	test("CONTROL: an aborted compress is never retried", async () => {
		// 13:09 ses_edf403f5: the error was the user's own interrupt landing
		// mid-turn. Retrying it would fight the user the latch exists to obey.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(
					now - 2000,
					toolPart("call_1", "compress", "error", now - 2000, {
						type: "aborted",
						message: "Tool execution interrupted: compress",
					}),
				),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a failed unknown name belongs to the suggester, not the retrier", async () => {
		// Telling the model to reissue a name that does not exist teaches
		// persistence on a typo. The suggestion path owns these.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(now - 2000, toolPart("call_1", "globb", "error", now - 2000, "tool not found")),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: an error the model already continued past is handled feedback", async () => {
		// Text after the error in the same message means the model saw it and
		// moved on. Nudging those would nag on every normal turn.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				{
					type: "assistant",
					id: "msg_a_x",
					time: { created: now - 2000 },
					content: [
						{ type: "tool", id: "call_1", name: "write", time: { created: now - 2000 }, state: { status: "error", input: {}, error: "disk full" } },
						{ type: "text", text: "That path failed, trying the other one." },
					],
				},
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: an error in an earlier message with later model output is handled", async () => {
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(now - 4000, toolPart("call_1", "write", "error", now - 4000, "disk full")),
				assistantWith(now - 2000, toolPart("call_2", "read", "completed", now - 2000)),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a trailing error with another call still in flight waits", async () => {
		// The in-flight call may yet resolve the turn on its own; the stall and
		// dead-stream paths own that case, not this one.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				{
					type: "assistant",
					id: "msg_a_x",
					time: { created: now - 2000 },
					content: [
						{ type: "tool", id: "call_1", name: "write", time: { created: now - 2000 }, state: { status: "error", input: {}, error: "disk full" } },
						{ type: "tool", id: "call_2", name: "shell", time: { created: now - 1500 }, state: { status: "running", input: {} } },
					],
				},
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("CONTROL: a policy-blocked call is never retried", async () => {
		// ses_edf403f5 15:59: shell blocked on secret.home, turn ended on it.
		// The guardrail text forbids retry outright — reissuing teaches
		// circumvention. Verdict, not failure.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(
					now - 2000,
					toolPart("call_1", "shell", "error", now - 2000, {
						type: "unknown",
						message: "BLOCKED by CC Safety Net\n\nReason: Access to a sensitive path is not allowed.",
					}),
				),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(0)
	})

	test("a trailing failed write is retried", async () => {
		// The upstream job's failed write: turn ended on the error, nothing
		// after it. Known tool, non-abort error, newer than the user message.
		const now = Date.now()
		const h = await setup(
			[
				userMessage("go", now - 5000),
				assistantWith(now - 2000, toolPart("call_1", "write", "error", now - 2000, "permission denied")),
			],
			{ chunkTimeoutMs: 600_000 },
		)
		await goIdle(h, true)
		const said = retryNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"write"')
	})

	test("the nudge names the tool and tells the model not to retry it", async () => {
		const h = await setup([
			userMessage("go", OLD),
			assistantWith(OLD + 1000, toolPart("call_1", "compress", "streaming", OLD + 2000)),
		])
		await goIdle(h, true)
		const said = stuckNudges(h)
		await teardown(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain("do not retry the same call")
	})
})
