import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: a send that throws after delivering must not send again.
 *
 * Observed 2026-10-06: twin identical `continue — stalled` prods 5ms apart
 * in child ses_eed4521bdffeHLLmpomhiB0KXx. One sufficient mechanism needs no
 * second instance at all: `ctx.session.prompt()` delivers, then throws
 * (transport flakiness was in the log minutes earlier), and the catch falls
 * through to `synthetic` — same text twice. After any throw, the plugin
 * verifies delivery against the session log (our text already the newest
 * user message) and only then falls back.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 4000

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
	maxRetries: 1,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
	visibleContinue: true,
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

async function setup(opts: {
	deliverPrompt?: boolean
	failPrompt?: boolean
	failSynthetic?: boolean
	logMessages?: unknown[]
}): Promise<any> {
	const sends: Array<{ channel: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-delivery-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const logMessages: unknown[] = opts.logMessages ?? []
	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => [],
			active: async () => ({ [SID]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => {
				sends.push({ channel: "synthetic", text: a?.text })
				if (opts.failSynthetic) throw new Error("synthetic transport blew up after send")
				return {}
			},
			prompt: async (a: any) => {
				// deliver-then-throw: the transport error lands after the
				// message is already in the log, like the 19:59 transport
				// retry storm around the observed twin.
				if (opts.deliverPrompt !== false) {
					sends.push({ channel: "prompt", text: a?.text })
					// Newest-first log: a delivery lands at the front.
					logMessages.unshift({
						role: "user",
						time: { created: Date.now() },
						content: [{ type: "text", text: a?.text }],
					})
				}
				if (opts.failPrompt) throw new Error("prompt transport blew up after send")
				return {}
			},
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [] }),
				message: { list: async () => logMessages },
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { sends, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusyStalled(h: any) {
	push(h, "session.execution.started", SID)
	await wait(10)
	push(h, "session.step.started", SID)
	await wait(10)
	await wait(900)
}

describe("v2: a send that throws after delivering sends nothing more", () => {
	test("prompt delivers-then-throws: no synthetic fallback", async () => {
		const now = Date.now()
		const h = await setup({
			deliverPrompt: true,
			failPrompt: true,
			logMessages: [
				{ role: "assistant", time: { created: now - 5_000 }, content: [{ type: "text", text: "working" }] },
				{ role: "user", time: { created: now - 60_000 }, content: [{ type: "text", text: "go" }] },
			],
		})
		await makeBusyStalled(h)
		expect(h.sends).toHaveLength(1)
		expect(h.sends[0].channel).toBe("prompt")
		await teardown(h)
	})

	test("CONTROL: prompt fails undelivered: synthetic fallback still fires", async () => {
		const now = Date.now()
		const h = await setup({
			deliverPrompt: false,
			failPrompt: true,
			logMessages: [
				{ role: "assistant", time: { created: now - 5_000 }, content: [{ type: "text", text: "working" }] },
				{ role: "user", time: { created: now - 60_000 }, content: [{ type: "text", text: "go" }] },
			],
		})
		await makeBusyStalled(h)
		expect(h.sends).toHaveLength(1)
		expect(h.sends[0].channel).toBe("synthetic")
		await teardown(h)
	})
})
