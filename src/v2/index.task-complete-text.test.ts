import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: a bare "TASK COMPLETE" latches completion like a stop statement.
 *
 * ses_edd1eb51 (2026-10-09): the model ended two deliveries with a trailing
 * "TASK COMPLETE" and the plugin fired resume attempt 1/3 on schedule 186s
 * later. endsWithCelebration is emoji-only and the completionSignaled setters
 * are tool/emoji/stop-word paths, so the system's own completion vocabulary
 * written as text latched nothing. The literal now latches when no todos are
 * open (open todos still get the once-budgeted reminder), and the busy-stall
 * path respects the latch. End-of-text anchored so mid-text mentions don't fire.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 9000

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

async function setup(opts: {
	messages?: unknown[]
	todos?: Array<{ content: string; status: string }>
	toolIds?: string[]
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-tc-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const messages = opts.messages ?? []
	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => messages,
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
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => (opts.toolIds ?? []).map((id) => ({ id })),
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

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const assistantMsg = (text: string) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: Date.now() - 60_000 },
	content: [{ type: "text", text }],
})

// Mirrors the ses_edd1eb51 delivery: report naming a file, trailing literal.
const TC_TEXT = "All recommendations are in /tmp/opencode/calibre-reco_findings.md  TASK COMPLETE"
const PLAIN_TEXT = "All recommendations are in /tmp/opencode/calibre-reco_findings.md"

describe("v2: bare TASK COMPLETE latches completion", () => {
	test("TASK COMPLETE latches: later busy-stall stays quiet", async () => {
		const h = await setup({ messages: [assistantMsg(TC_TEXT)] })
		// Prod shape (ses_edd1eb51): the delivery went quiet with no
		// session.idle event, so no idle inspection ever ran and the stall
		// ladder fired 186s later. No new turn arrives here either: a fresh
		// turn re-arms by design (markBusy clears the latch).
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	})

	test("TASK COMPLETE with open todos still earns the once-budgeted reminder", async () => {
		const h = await setup({
			messages: [assistantMsg(TC_TEXT)],
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

	test("CONTROL: same delivery without the literal still recovers on stall", async () => {
		const h = await setup({ messages: [assistantMsg(PLAIN_TEXT)] })
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	})
})
