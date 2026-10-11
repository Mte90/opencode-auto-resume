import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexRateLimitTest"

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
const SLOT503 = { error: { type: "provider.http", message: "Request failed with status 503", status: 503 } }
const SLOT503_TEXT = { error: { type: "provider.transport", message: "upstream returned 503 Service Unavailable" } }

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

type Harness = { injected: Array<{ text?: string; resume?: boolean; synth?: boolean }>; logs: string[]; stream: any; cleanup?: () => void; logFile: string; failTurn: (err: unknown) => Promise<void>; startTurn: () => Promise<void>; failStep: (err: unknown) => Promise<void>; idleTurn: () => Promise<void> }

async function replay(opts: Record<string, unknown> = {}): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-ratelimit-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...opts, registryScope: LOG_SALT },
		session: {
			context: async () => [userTurn()],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => {
				injected.push({ text: a?.text, resume: a?.resume, synth: true })
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

	test("a quota hit injects nothing inside the cooldown except the notice", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(QUOTA)
		await wait(300)
		// Only the quota notice — no recovery prompt while cooling down.
		expect(h.injected.length).toBe(1)
		expect(h.injected[0].text).toMatch(/Rate limited, retrying in/)
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("rate limited") && l.includes("standing down"))).toBe(true)
		expect(logs.some((l) => l.includes("session.step.failed") && l.includes("resume attempt"))).toBe(false)
		h.cleanup?.()
	})

	test("quota stand-down posts one visible notice with wait + attempt", async () => {
		// ses_edd3d940 (2026-10-10): standing down silently reads as dead.
		// One synthetic notice (resume:false — never kicks a turn), then
		// quiet: a second failure inside the cooldown adds no second notice.
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(QUOTA)
		await wait(300)
		const notices = () => h.injected.filter((i) => /Rate limited, retrying in/.test(i.text ?? ""))
		expect(notices()).toHaveLength(1)
		expect(notices()[0].text).toMatch(/attempt 1\/1/)
		expect(notices()[0].text).toMatch(/~1m|~60m|~1h/)
		expect(notices()[0].resume).toBeFalsy()
		expect(notices()[0].synth).toBe(true)
		await h.failStep(QUOTA)
		await wait(300)
		expect(notices()).toHaveLength(1)
		h.cleanup?.()
	})

	test("quota budget exhaustion posts the standing-down notice once", async () => {
		const h = await replay({ rateLimitCooldownsMs: [30, 30] })
		// No new turns between failures: same episode climbs the ladder to
		// exhaustion (a fresh startTurn would reset it — see next test).
		await h.startTurn()
		for (let i = 0; i < 3; i++) {
			await h.failStep(QUOTA)
			await wait(200)
		}
		const endNotices = h.injected.filter((i) => /standing down until you return/.test(i.text ?? ""))
		expect(endNotices).toHaveLength(1)
		expect(endNotices[0].resume).toBeFalsy()
		h.cleanup?.()
	})

	test("CONTROL: non-quota failure posts no quota notice", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(STREAM_ERR)
		await wait(300)
		expect(h.injected.some((i) => /Rate limited/.test(i.text ?? ""))).toBe(false)
		h.cleanup?.()
	})

	test("a second quota hit inside the cooldown adds no second notice", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await h.failStep(QUOTA)
		await wait(300)
		// Exactly the one first-arm notice; the second hit stays silent.
		expect(h.injected.length).toBe(1)
		expect(h.injected[0].text).toMatch(/Rate limited, retrying in/)
		h.cleanup?.()
		readLogs(h)
	})

	test("a served cooldown retries through the normal path", async () => {
		const h = await replay({ rateLimitCooldownsMs: [50] })
		await h.failTurn(QUOTA)
		await wait(500)
		// The first-arm notice plus the served recovery prompt.
		expect(h.injected.length).toBe(2)
		expect(h.injected.some((i) => /Rate limited, retrying in/.test(i.text ?? ""))).toBe(true)
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("cooldown served"))).toBe(true)
		h.cleanup?.()
	})

	test("past the ladder the exhausted notice fires once, then silence", async () => {
		const h = await replay({ rateLimitCooldownsMs: [20] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await wait(300)
		// Armed notice + served recovery inside the wait.
		expect(h.injected).toHaveLength(2)
		// Budget spent (1 rung): the next hit moves to exhausted (notice +
		// recovery + exhausted notice), then silence.
		await h.failStep(QUOTA)
		await wait(300)
		expect(h.injected).toHaveLength(3)
		expect(h.injected[2].text).toMatch(/standing down until you return/)
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("budget exhausted"))).toBe(true)
		h.cleanup?.()
	})

	test("a fresh turn resets the ladder", async () => {
		const h = await replay({ rateLimitCooldownsMs: [20] })
		await h.startTurn()
		await h.failStep(QUOTA)
		await wait(300)
		// Notice + served recovery (20ms ladder serves inside the wait).
		expect(h.injected).toHaveLength(2)
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

	test("a 503 recovers like a generic failure (no slot ladder)", async () => {
		// SelfRef #5 (2026-10-10): TabbyAPI queues past max-batch-size, it
		// never 503s on overflow — the 503s we saw were the DFlash2 draft
		// crash bug. A 503 is breakage like any other provider failure: it
		// recovers through the normal failure path, with no patient ladder.
		const h = await replay()
		await h.startTurn()
		await h.failStep(SLOT503)
		await wait(300)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
		const logs = readLogs(h)
		expect(logs.some((l) => /slot.busy/i.test(l))).toBe(false)
		h.cleanup?.()
	})

	test("503 told only in prose behaves the same", async () => {
		const h = await replay()
		await h.startTurn()
		await h.failStep(SLOT503_TEXT)
		await wait(300)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
		const logs = readLogs(h)
		expect(logs.some((l) => /slot.busy/i.test(l))).toBe(false)
		h.cleanup?.()
	})

	test("repeated 503s latch the failure loop like generic failures", async () => {
		// Six hits: a couple of recoveries fire (bounded), then the
		// consecutive-failure latch stands the session down until a genuine
		// turn — the same shape as any repeated provider failure. Exact
		// delivery count stays loose (identical-text dedup may merge
		// same-minute repeats); the latch is the contract.
		const h = await replay({ loopMaxContinues: 99, maxRetries: 9 })
		await h.startTurn()
		for (let i = 0; i < 6; i++) {
			await h.failStep(SLOT503)
			await wait(150)
		}
		const logs = readLogs(h)
		expect(logs.some((l) => l.includes("standing down until a genuine turn"))).toBe(true)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
		expect(h.injected.length).toBeLessThanOrEqual(3)
		h.cleanup?.()
	})
})
