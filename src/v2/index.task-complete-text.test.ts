import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "IndexTaskCompleteTextTest"

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
	const capture = capturePluginLogs()

	const messages = opts.messages ?? []
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT },
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
	return { injected, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

const assistantMsg = (text: string) => ({
	// Prod shape carries role, not type (session.messages API). The harness
	// convention is type-shaped; these tests deliberately use role-shaped
	// messages because the ses_edbb4e67 incident was a type-only reader
	// returning "" in prod while every test stayed green.
	role: "assistant",
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

	test("flat-text history (prod shape) latches like parts", async () => {
		// ses_ed93e258 (2026-10-10): prod transcripts carry text flat, not
		// in content parts. A parts-only reader went blind and the latch
		// never engaged despite the fix being live.
		const h = await setup({
			messages: [
				{
					role: "assistant",
					id: "msg_a",
					time: { created: Date.now() - 60_000 },
					text: "Report written.\n\nTASK COMPLETE\n",
				},
			],
		})
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("newest-first history (prod order) latches like oldest-first", async () => {
		// ses_ed975114 (2026-10-10): the message API returns newest-first;
		// every walk reads the END as newest. Without canonicalization the
		// busy latch judged the oldest turn: a stale plain delivery masked
		// the fresh TASK COMPLETE and the stall fired. Two assistant turns
		// force the order to matter (a single turn reads the same either way).
		const now = Date.now()
		const h = await setup({
			messages: [
				{
					role: "assistant",
					id: "msg_new",
					time: { created: now - 60_000 },
					text: "Report written.\n\nTASK COMPLETE\n",
				},
				{
					role: "assistant",
					id: "msg_old",
					time: { created: now - 120_000 },
					text: "Still digging through the list.",
				},
			],
		})
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("trailing @N@ boundary marker does not defeat the latch (parts shape)", async () => {
		// ses_ecca0ad6 (2026-10-13): the harness appends @12@-style boundary
		// ids to stored message text. Nine "TASK COMPLETE" deliveries ended
		// with a marker and the stall ladder fired on every one — the
		// end-anchored match never saw the literal. Markers are metadata,
		// not model prose, so the predicates strip trailing runs.
		const h = await setup({ messages: [assistantMsg("Report written.\n\nTASK COMPLETE\n\n@75@")] })
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("trailing @N@ boundary marker does not defeat the latch (flat shape)", async () => {
		const h = await setup({
			messages: [
				{
					role: "assistant",
					id: "msg_a",
					time: { created: Date.now() - 60_000 },
					text: "Report written.\n\nTASK COMPLETE\n\n@80@",
				},
			],
		})
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("noun between all and the verdict still latches (S14 Schwab tail)", async () => {
		// 2026-10-15 session-tail review: "All work complete. Ready for your
		// next instruction." matched nothing — the all/everything pattern
		// admitted no noun — and the stall ladder fired on a finished session.
		const h = await setup({
			messages: [assistantMsg("Reviewed the positions.\n\nAll work complete. Ready for your next instruction.")],
		})
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("standby phrasing latches without a done-claim beside it (S15 tail)", async () => {
		// "Standing by for next instructions." carries no all/done/finished
		// word, so only the standby stop pattern can latch it.
		const h = await setup({ messages: [assistantMsg("PR merged and verified.\n\nStanding by for next instructions.")] })
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("ready-for-next-task latches instead of continuing (S3 tail)", async () => {
		// "Ready when you have the next task." means out of work, not
		// ready-to-continue — it must latch quiet, never draw a `continue`.
		const h = await setup({ messages: [assistantMsg("Stack session done.\n\nReady when you have the next task.")] })
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID)).toHaveLength(0)
		await teardown(h)
	}, 20000)

	test("CONTROL: lowercase task complete is model prose, not the signal", async () => {
		// Case discipline (2026-10-15): only byte-exact TASK COMPLETE latches.
		// A lowercase "task complete" must NOT latch — the stall ladder stays
		// armed and recovers on schedule like any unfinished delivery.
		const h = await setup({ messages: [assistantMsg("Still working through it.\n\ntask complete")] })
		push(h, "session.execution.started", SID)
		await wait(1200)
		expect(h.injected.filter((i: any) => i.sid === SID).length).toBeGreaterThan(0)
		await teardown(h)
	}, 20000)
})
