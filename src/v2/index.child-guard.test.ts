import { describe, test, expect, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: subagent protection without ctx.client.
 *
 * Production ctx carries no client and no session list/get/active surface
 * (probed live 2026-10-06: every subagent check silently degraded to false;
 * zero "injection refused" lines in all of log history). Two injections
 * landed in child ses_eed4521bdffeHLLmpomhiB0KXx the same millisecond from
 * stacked setups whose backoff timers survived disposal. So:
 *  1. subagent identity resolves over the loopback session list
 *     (GET /api/session carries parentID rows), and
 *  2. dispose cancels pending recover timers (plus a running-check in the
 *     timer body), so a superseded instance stays silent.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"
const CHILD = "ses_eed4521bdffeHLLmpomhiB0KXx"

let counter = 3000
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
	chunkTimeoutMs: 300,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
}

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: "msg_u",
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantText = (text: string, at: number) => ({
	type: "assistant",
	id: "msg_a",
	time: { created: at },
	content: [{ type: "text", text }],
})

type History = Record<string, unknown[]>

async function setup(opts: {
	history?: History
	active?: string[]
	withClient?: boolean
	backoffMs?: number
}): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-childguard-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: History = opts.history ?? {}
	const active = new Set(opts.active ?? [])

	const ctx: any = {
		event: stream,
		options: {
			...OPTIONS,
			logFile,
			...(opts.backoffMs ? { baseBackoffMs: opts.backoffMs, maxBackoffMs: opts.backoffMs } : {}),
		},
		session: {
			context: async (a: any) => history[a?.sessionID ?? SID] ?? [],
			active: async () => Object.fromEntries([...active].map((s) => [s, {}])),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}
	if (opts.withClient !== false) {
		ctx.client = {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [] }),
			},
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, interrupted, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
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

describe("v2: subagent protection without ctx.client", () => {
	test("a stalled child is refused injection via the loopback list", async () => {
		// Prod shape: no ctx.client at all. The child goes quiet past the
		// stall threshold; the ONLY thing that knows it is a child is the
		// loopback session list. Before the HTTP fallback this injected.
		// serverBaseUrls() needs a port to build a base — prod has one via
		// env/argv, the test env does not, so pin one here.
		process.env.OPENCODE_SERVER_PORT = "18234"
		stubSessionList([
			{ id: SID },
			{ id: CHILD, parentID: SID },
		])
		const now = Date.now()
		const h = await setup(
			{
				history: { [CHILD]: [userMessage("go", now - 60_000), assistantText("working", now - 5_000)] },
				active: [CHILD],
				withClient: false,
			},
		)
		await makeBusy(h, CHILD)
		await wait(900)
		expect(h.injected.filter((i: any) => i.sid === CHILD)).toHaveLength(0)
		expect(h.interrupted).toHaveLength(0)
		await teardown(h)
	})

	test("dispose cancels a scheduled stall inject", async () => {
		// The 5ms-apart twin prods: instance A schedules its backoff timer,
		// setup B disposes A, A's timer still fires. With a 5s backoff there
		// is ample room to dispose first: nothing may land afterwards.
		stubSessionList([{ id: SID }])
		const now = Date.now()
		const h = await setup({
			history: { [SID]: [userMessage("go", now - 60_000), assistantText("working", now - 5_000)] },
			active: [SID],
			backoffMs: 1500,
		})
		await makeBusy(h, SID)
		await wait(700)
		await teardown(h)
		await wait(2200)
		expect(h.injected).toHaveLength(0)
	})
})
