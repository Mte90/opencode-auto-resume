import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexLatchPersistTest"

/**
 * v2: durable latch state (R1, audit 2026-10-10 finding 6).
 *
 * Watch state lived only in the in-process SingletonRegistry, so every latch
 * died on a real restart — while the comment justifying `permLocked`/`oocLocked`
 * claimed they were "what stops a retry loop that spans restarts". They span
 * nothing. Every restart bought another burst of retries against a condition
 * that can never succeed, each one a user-visible prod.
 *
 * The quota ladder had the opposite problem: it DID survive, by grepping
 * `quota-armed` markers out of the log file. A log is the worst available state
 * channel — a 2MB rotation cap and a fixed 3000-line tail can drop a live arm.
 *
 * This suite pins the narrow fix: a small per-session record in ctx.storage
 * carrying only what a restart must not forget. Not the whole watch — stall
 * clocks are meaningless across a restart, and resurrecting them would re-open
 * every timer question the audit just closed.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_latch"

/**
 * Poll budgets are sized for the environment, not for isolation.
 *
 * This suite runs while `bun test` runs 79 files in parallel, and under that
 * contention a condition that resolves in microseconds with every mock in
 * place can still take seconds of wall clock — the process is simply starved.
 * Five separate tests here and in the sibling files failed this way on
 * 2026-10-10/11, each on a different budget, all passing in isolation.
 *
 * A poll budget only ever costs time when the condition NEVER arrives, which
 * is a real failure and should fail — slowly, and with the assertion saying
 * so. So these are generous on purpose.
 */
const POLL_MS = 10_000
setDefaultTimeout(30_000)

let counter = 41000

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

const OPTS = {
	chunkTimeoutMs: 50,
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
	rateLimitCooldownsMs: [120, 120],
	debug: true,
}

/** A host storage that survives a "restart". */
function durableStorage(seed?: Map<string, unknown>) {
	const map = seed ?? new Map<string, unknown>()
	return {
		map,
		get: async (key: string) => map.get(key),
		set: async (key: string, value: unknown) => {
			map.set(key, value)
		},
		remove: async (key: string) => {
			map.delete(key)
		},
	}
}

/** A host storage that discards writes: models the pre-R1 behaviour. */
function nullStorage() {
	return { get: async () => undefined, set: async () => {}, remove: async () => {} }
}

async function setup(
	logFile: string,
	history: unknown[] = [],
	storage: any = durableStorage(),
	opts: Record<string, unknown> = {},
): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()

	const ctx: any = {
		event: stream,
		options: { ...OPTS, logFile, ...opts, registryScope: LOG_SALT },
		session: {
			context: async () => history,
			active: async () => ({}),
			list: async () => [{ id: SID }],
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage,
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [{ id: "bash" }],
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	const startTurn = async () => {
		for (const e of [ev("session.execution.started"), ev("session.step.started")]) {
			stream.push(e)
			await wait(10)
		}
	}
	return {
		injected,
		cleanup,
		startTurn,
		/** A failure with no preceding genuine turn — what a mid-turn restart looks like. */
		bareFail: async (err: unknown) => {
			stream.push(ev("session.step.failed", err as Record<string, unknown>))
			await wait(150)
		},
		failTurn: async (err: unknown) => {
			await startTurn()
			stream.push(ev("session.step.failed", err as Record<string, unknown>))
			await wait(150)
		},
		logs: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
	}
}

const freshLog = () => {
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-latch-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })
	return logFile
}

/**
 * Poll the log for a line instead of sleeping a fixed span.
 *
 * The suite runs 79 files in parallel and the whole run takes ~6.5 minutes,
 * so a sleep long enough to be safe in isolation is a coin flip under load —
 * which is how these tests came to be flaky (a fixed `wait(600)` here failed
 * roughly one run in three, while passing every time on its own).
 */
async function waitForLog(h: any, needle: string, timeoutMs = POLL_MS): Promise<string> {
	const deadline = Date.now() + timeoutMs
	let text = h.logs()
	while (!text.includes(needle) && Date.now() < deadline) {
		await wait(50)
		text = h.logs()
	}
	return text
}

/** Poll until the predicate holds; resolves true/false. */
async function until(fn: () => boolean, timeoutMs = POLL_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (fn()) return true
		await wait(50)
	}
	return fn()
}

const PERMANENT = { error: { type: "provider.auth", message: "invalid api key" } }
const QUOTA = { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } }

describe("v2: durable quota state across a restart", () => {
	test("locks need NO persistence: the first genuine execution clears them", async () => {
		// R1 originally proposed persisting permLocked/oocLocked/
		// failureLoopLatched across restarts, on the theory that the code
		// comment claiming they "stop a retry loop that spans restarts" was
		// otherwise a lie. The CONTROL below disproved it: `clearLocks` and the
		// `episodeRefires = 0` reset both run on genuine `execution.started`,
		// so the first execution after boot wipes them before any failure can be
		// evaluated. Persisting them would be write amplification for nothing.
		// This test pins that invariant — if someone removes the reset, this
		// fails and says so, and persistence becomes necessary again.
		const logFile = freshLog()
		const store = durableStorage()
		const h = await setup(logFile, [], store)
		await h.failTurn(PERMANENT)
		await wait(200)
		expect(h.logs()).toMatch(/permanent|OOC|latched/i)
		// The next genuine execution is the release point.
		await h.startTurn()
		await wait(250)
		const afterClear = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		expect(afterClear).toContain("clearing")
	})

	test("a quota arm survives a restart with the log file gone", async () => {
		const logFile = freshLog()
		const store = durableStorage()

		const h1 = await setup(logFile, [], store)
		await h1.failTurn(QUOTA)
		expect(await waitForLog(h1, "quota-armed")).toContain("quota-armed")
		;(h1.cleanup as (() => void) | undefined)?.()

		// Destroy the log: the log-grep fallback cannot help, so this passes
		// only if the ladder itself is in durable storage.
		rmSync(logFile, { force: true })
		writeFileSync(logFile, "")

		// The second instance reads the record at `restoreQuotaLadders`, which
		// drops any arm older than `horizon` = sum(ladder) — the point past which
		// serving another rung could not help. With the file's default [120,120]
		// that horizon is 240ms, and the arm expires DURING this test's own
		// teardown + setup: it passed in isolation and failed under the suite's
		// parallel load (one run in three). A ladder whose horizon is ~5s makes
		// the restore the only possible outcome; the arm is real either way, and
		// the rung it reaches is not what this test is about.
		const h2 = await setup(logFile, [], store, { rateLimitCooldownsMs: [4000, 4000] })
		const log = await waitForLog(h2, "cooldown served")
		;(h2.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		expect(log).toContain("cooldown served")
	}, 30000)

	test("a genuine turn drops the durable arm", async () => {
		// The point of moving the ladder out of the log: the record is deleted
		// when the user speaks, so restore never needs to re-read history to
		// answer "did they speak after the arm?" — the boot-time per-session
		// HTTP read disappears with it.
		//
		// Asserted on the record rather than on end-to-end ordering: restore
		// runs at setup, so "no restore" would depend on whether a genuine turn
		// landed before or after it. The mechanism is the durable fact.
		const logFile = freshLog()
		const store = durableStorage()
		const h1 = await setup(logFile, [], store)
		await h1.failTurn(QUOTA)
		const gotArmed = await until(() => ((store.map.get(`resume-quota/${SID}`) as any)?.at ?? 0) > 0)
		;(h1.cleanup as (() => void) | undefined)?.()
		expect(gotArmed).toBe(true)

		const h2 = await setup(logFile, [], store)
		await h2.startTurn()
		const dropped = await until(() => {
			const rec = store.map.get(`resume-quota/${SID}`) as any
			return rec === undefined || rec?.at === 0
		})
		;(h2.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		// Genuine turn => the in-memory ladder reset must take the record with it.
		expect(dropped).toBe(true)
	}, 20000)

	test("restore never arms a session that is already busy", async () => {
		// The boot race: a user who messaged before the plugin finished starting
		// must not get a restored ladder served into their live turn. Status is
		// already in memory, so this costs no history read.
		//
		// Determinism: the storage read is slowed so the turn is observably busy
		// before restore reaches its check. Without the delay this races the
		// restore, and a pass would prove nothing either way.
		const logFile = freshLog()
		const AT = Date.now()
		const map = new Map<string, unknown>([[`resume-quota/${SID}`, { v: 1, at: AT, rung: 0, noticed: AT }]])
		const slowStore = {
			get: async (key: string) => {
				await wait(300)
				return map.get(key)
			},
			set: async (key: string, value: unknown) => {
				map.set(key, value)
			},
			remove: async (key: string) => {
				map.delete(key)
			},
		}

		const h = await setup(logFile, [], slowStore)
		// Mid-turn by the time restore gets there.
		await h.startTurn()
		await wait(1200)
		const log = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		const restoredLine = log.split("\n").find((l: string) => l.includes("quota ladder restored")) ?? ""
		expect(restoredLine).toBe("")
	}, 20000)

	test("a record older than the horizon is ignored", async () => {
		const logFile = freshLog()
		const OLD = Date.now() - 48 * 3600_000
		const store = durableStorage(
			new Map<string, unknown>([[`resume-quota/${SID}`, { v: 1, at: OLD, rung: 0, noticed: OLD }]]),
		)

		const h = await setup(logFile, [], store)
		await wait(400)
		const log = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		// Two days stale: past any plausible ladder horizon, so not restored.
		expect(log).not.toContain("quota ladder restored")
	}, 20000)

	test("storage failures never block recovery", async () => {
		const logFile = freshLog()
		const hostile = {
			get: async () => {
				throw new Error("storage exploded")
			},
			set: async () => {
				throw new Error("storage exploded")
			},
			remove: async () => {
				throw new Error("storage exploded")
			},
		}

		const h = await setup(logFile, [], hostile)
		await h.failTurn(QUOTA)
		await wait(250)
		const recovered = h.logs().includes("cooldown served") || h.injected.length > 0
		;(h.cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })

		expect(recovered).toBe(true)
	})
})