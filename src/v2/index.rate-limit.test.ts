import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_ratelimit"

/**
 * Rate-limit / quota failures.
 *
 * Observed 2026-10-04: `session.step.failed: provider.quota Rate limit
 * exceeded. Please try again later.` fired a visible continue 1s later, twice
 * in two seconds — retrying straight into the ban. The failure handler
 * recovered from every non-abort, non-OOC error with no rate-limit
 * classification at all.
 *
 * The rule: a quota hit stands down on a gate ladder (gates, not timers —
 * armed timeouts do not survive a plugin reload), evaluated on each failure
 * and each watchdog tick. Attempts consume their own budget; past it, silence
 * until a genuine user turn. A fresh turn resets the ladder.
 *
 * Every group carries a control.
 */

let counter = 0

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

const QUOTA = { error: { type: "provider.quota", message: "Rate limit exceeded. Please try again later." } }
const STREAM_ERR = { error: { type: "StreamError", message: "connection reset" } }

const userTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - 60 * 60_000 },
	content: [{ type: "text", text: "do the thing" }],
})

const OPTIONS = {
	chunkTimeoutMs: 600_000,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	debug: true,
}

type Harness = { injected: Array<{ text?: string }>; logs: string[]; stream: any; cleanup?: () => void; logFile: string; failTurn: (err: unknown) => Promise<void>; startTurn: () => Promise<void>; failStep: (err: unknown) => Promise<void>; idleTurn: () => Promise<void> }

async function replay(opts: Record<string, unknown> = {}): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-ratelimit-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...opts },
		session: {
			context: async () => [userTurn()],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => {
				injected.push({ text: a?.text })
				return {}
			},
			prompt: async (a: any) => {
				injected.push({ text: a?.text })
				return {}
			},
		},
		client: { session: { get: async () => ({ data: {} }) } },
	}

	const cleanup = await (plugin as any).setup(ctx)
	// Split on purpose: a new execution re-arms the ladder (fresh turn =
	// activity = quota available again), while repeated step failures inside
	// one execution share a single ladder episode.
	const startTurn = async () => {
		for (const e of [ev("session.execution.started"), ev("session.step.started")]) {
			stream.push(e)
			await wait(10)
		}
	}
	const failStep = async (err: unknown) => {
		stream.push(ev("session.step.failed", err as Record<string, unknown>))
		await wait(10)
	}
	const idleTurn = async () => {
		stream.push(ev("session.idle"))
		await wait(50)
	}
	const failTurn = async (err: unknown) => {
		await startTurn()
		await failStep(err)
	}
	return {
		injected,
		logs: [],
		stream,
		cleanup,
		logFile,
		failTurn,
		startTurn,
		failStep,
		idleTurn,
	}
}

function readLogs(h: Harness): string[] {
	const logs = existsSync(h.logFile) ? readFileSync(h.logFile, "utf8").split("\n") : []
	rmSync(h.logFile, { force: true })
	return logs
}

describe("v2: rate-limit failures stand down on a ladder", () => {
	test("CONTROL: a non-rate failure recovers immediately", async () => {
		const h = await replay()
		await h.failTurn(STREAM_ERR)
		await wait(600)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
		h.cleanup?.()
		readLogs(h)
	})

	test("a quota hit injects nothing inside the cooldown", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(QUOTA)
		await wait(300)
		expect(h.injected).toEqual([])
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("rate limited") && l.includes("standing down"))).toBe(true)
		expect(logs.some((l) => l.includes("session.step.failed") && l.includes("resume attempt"))).toBe(false)
		h.cleanup?.()
	})

	test("a second quota hit inside the cooldown still injects nothing", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await h.failStep(QUOTA)
		await wait(300)
		expect(h.injected).toEqual([])
		h.cleanup?.()
		readLogs(h)
	})

	test("a served cooldown retries through the normal path", async () => {
		const h = await replay({ rateLimitCooldownsMs: [50] })
		await h.failTurn(QUOTA)
		await wait(500)
		expect(h.injected).toHaveLength(1)
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("cooldown served"))).toBe(true)
		h.cleanup?.()
	})

	test("past the ladder the session goes silent until a user turn", async () => {
		const h = await replay({ rateLimitCooldownsMs: [20] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await wait(300)
		expect(h.injected).toHaveLength(1)
		// Budget spent (1 rung): the next hit must not inject.
		await h.failStep(QUOTA)
		await wait(300)
		expect(h.injected).toHaveLength(1)
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("budget exhausted"))).toBe(true)
		h.cleanup?.()
	})

	test("a fresh turn resets the ladder", async () => {
		const h = await replay({ rateLimitCooldownsMs: [20] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await wait(300)
		expect(h.injected).toHaveLength(1)
		await h.failStep(QUOTA)
		await wait(200)
		// New turn = activity = quota available again: fresh ladder, so the
		// next quota hit stands down with a new cooldown instead of silence.
		// The idle first ends our recovery turn (consuming the self-cause
		// flag), so the new execution reads as genuine.
		await h.idleTurn()
		await h.startTurn()
		await h.failStep(QUOTA)
		await wait(200)
		const logs = readLogs(h)
		expect(logs.filter((l) => l.includes("next attempt in")).length).toBeGreaterThanOrEqual(2)
		h.cleanup?.()
	})
})
