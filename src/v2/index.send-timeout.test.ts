import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: wedged sends time out instead of stacking into twins.
 *
 * ses_ee7dade1 (2026-10-07): two rich stall texts 5ms apart carrying
 * attempt counters 1 and 2, with only ONE detection log line in the window
 * and zero reloads (single process, single setup — stacked instances ruled
 * out). The consistent mechanism: an earlier cascade's send wedged in a
 * transport await for minutes; a later cascade's send wedged behind it;
 * both resolved together. No send await may hang unbounded: each send gets
 * a timeout, after which the normal throw path (log verify + fallback)
 * applies. Slow-but-completing sends log a latency warning for forensics.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 8000

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

async function setup(promptImpl: (a: any) => Promise<unknown>, opts: Record<string, unknown> = {}): Promise<any> {
	const sends: Array<{ channel: string; at: number }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-sendtimeout-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })
	const now = Date.now()
	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 300,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 1,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			debug: false,
			visibleContinue: true,
			sendTimeoutMs: 300,
			...opts,
			logFile,
		},
		session: {
			context: async () => [
				{ type: "assistant", time: { created: now - 5_000 }, content: [{ type: "text", text: "working" }] },
			],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (sends.push({ channel: "synthetic", at: Date.now() }), {}),
			prompt: async (a: any) => {
				sends.push({ channel: "prompt", at: Date.now() })
				await promptImpl(a)
				return {}
			},
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
				message: { list: async () => [] },
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

async function driveStall(h: any) {
	h.streamRef.push(ev("session.execution.started", SID))
	await wait(10)
	h.streamRef.push(ev("session.step.started", SID))
	await wait(900)
}

describe("v2: wedged sends time out instead of stacking", () => {
	test("a prompt that never resolves falls back instead of hanging", async () => {
		const h = await setup(() => new Promise(() => {}))
		const started = Date.now()
		await driveStall(h)
		const elapsed = Date.now() - started
		// Prompt wedged forever: must fall back to synthetic promptly
		// (sendTimeoutMs 300 + slack), never hang the recovery.
		expect(h.sends.filter((s: any) => s.channel === "synthetic")).toHaveLength(1)
		expect(elapsed).toBeLessThan(3000)
		await teardown(h)
	})

	test("CONTROL: a slow-but-completing prompt sends once, no fallback", async () => {
		const h = await setup(async () => {
			await wait(150)
		})
		await driveStall(h)
		expect(h.sends.filter((s: any) => s.channel === "prompt")).toHaveLength(1)
		expect(h.sends.filter((s: any) => s.channel === "synthetic")).toHaveLength(0)
		await teardown(h)
	})
})
