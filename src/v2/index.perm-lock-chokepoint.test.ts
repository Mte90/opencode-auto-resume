import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexPermLockChokepointTest"

/**
 * v2: the permanent/OOC locks belong at the injection choke point.
 *
 * The locks are enforced in `recover()` and `tryAbortAndResume()` — two of the
 * five `injectOnce` call sites. The other three are separate features with
 * their own triggers and their own budgets: the unknown-tool suggestion
 * (`checkForUnknownToolCalls`), the task_complete blocked nudge, and
 * `targetedRecovery` for intent/tool-loop patterns.
 *
 * That is a real hole, not a theoretical one. A permanently-failed session
 * goes idle with its history intact, and the unknown-tool pass then reads that
 * history and injects a suggestion — into a model that cannot answer at all.
 * Same for the OOC lock, which predates this. Enforcing at `injectOnceLocked`
 * closes all five paths and every future one, instead of five call sites.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_choke"

let counter = 15000

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
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: true,
}

const OLD = Date.now() - 60 * 60_000
const TOOLS = [{ id: "read" }, { id: "write" }, { id: "glob" }, { id: "bash" }, { id: "task_complete" }]

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const toolPart = (id: string, name: string) => ({
	type: "tool",
	id,
	name,
	time: { created: OLD },
	state: { status: "error", input: {}, error: "tool not found" },
})

/** Carries a text part too, deliberately: a finished assistant message with no
 * text part trips the silent-dead-stream detector first and would swallow this. */
const assistantWith = (...content: unknown[]) => ({
	type: "assistant",
	id: "msg_a_here",
	time: { created: OLD + 1_000 },
	content: [{ type: "text", text: "Let me look at that." }, ...content],
})

/** Two invented calls to the same name: enough to earn a suggestion normally. */
const TYPO_HISTORY = [
	userMessage("go", OLD),
	assistantWith(toolPart("call_1", "globb")),
	assistantWith(toolPart("call_2", "globb")),
]

async function setup(history: unknown[]): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-choke-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// Prod shape: no ctx.client, empty active set.
	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
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

async function goIdle(h: any) {
	for (const e of [
		ev("session.execution.started"),
		ev("session.step.started"),
		ev("session.step.ended"),
		ev("session.idle"),
	]) {
		h.streamRef.push(e)
		await wait(10)
	}
	await wait(250)
}

const suggestions = (h: any) => h.injected.filter((i: any) => /does not exist/.test(i.text ?? ""))

/**
 * Reach idle WITHOUT pushing `session.execution.started`. That event is a genuine
 * new turn and correctly clears both locks, so including it would test the wrong
 * thing — the latch would already be gone before the idle passes ran. The step and
 * idle events are enough: the unknown-tool pass is driven by `session.idle`.
 */
async function reachIdle(h: any) {
	for (const e of [ev("session.step.started"), ev("session.step.ended"), ev("session.idle")]) {
		h.streamRef.push(e)
		await wait(10)
	}
	await wait(250)
}

/** Latch a permanent failure, then let the idle passes run. */
async function driveWithLatch(h: any) {
	h.streamRef.push(ev("session.execution.started"))
	await wait(20)
	h.streamRef.push(
		ev("session.step.failed", { error: { type: "provider.auth", message: "no api key found", status: 401 } }),
	)
	await wait(150)
	await reachIdle(h)
}

describe("v2: locked sessions inject nothing from ANY path", () => {
	test("CONTROL: without a latch, the unknown-tool suggestion is sent", async () => {
		const h = await setup(TYPO_HISTORY)
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		await teardown(h)
	})

	test("a permanently failed session gets no suggestion", async () => {
		const h = await setup(TYPO_HISTORY)
		await driveWithLatch(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("an OOC-locked session gets no suggestion either", async () => {
		const h = await setup(TYPO_HISTORY)
		h.streamRef.push(ev("session.execution.started"))
		await wait(20)
		h.streamRef.push(
			ev("session.step.failed", {
				error: { type: "provider.invalid-request", message: "prompt is too long: 210000 tokens" },
			}),
		)
		await wait(150)
		await reachIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("a genuine turn releases both locks and the suggestion returns", async () => {
		const h = await setup(TYPO_HISTORY)
		await driveWithLatch(h)
		expect(suggestions(h)).toHaveLength(0)
		// Fresh user turn (credentials fixed): locks clear, idle pass works again.
		h.streamRef.push(ev("session.execution.started"))
		await wait(20)
		h.streamRef.push(ev("session.idle"))
		await wait(300)
		await teardown(h)
		expect(suggestions(h)).toHaveLength(1)
	})
})