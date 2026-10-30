import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { capturePluginLogs } from "./test-utils"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexQuotaRestoreTest"

/**
 * v2: quota ladders survive a plugin reload.
 *
 * ses_ef72c5f3 (2026-10-09): quota failure armed the ladder at 14:31:49
 * (rung 1/8, next attempt in 900s), the plugin reloaded at 14:37:28, and the
 * gate due 14:46:49 never fired — `dispose()` clears the session map, wiping
 * `awaitingQuotaRetry`/`rateLimitedAt`/`rateLimitAttempts`, and no new failure
 * event ever re-arms it. The design comment claimed "reloads lose nothing";
 * they lost the whole gate.
 *
 * The `quota-armed` marker lines in the file-backed log are the record. On
 * setup, `restoreQuotaLadders()` re-arms still-listed sessions from them
 * unless a user message newer than the arm means the ladder already reset.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"


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

async function setup(capture: any, history: unknown[] = [], store = new Map<string, unknown>()): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
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
			rateLimitCooldownsMs: [150, 150],
			debug: true,
		},
		session: {
			context: async () => history,
			active: async () => ({}),
			list: async () => [{ id: SID }],
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: {
			get: async (k: any) => (typeof k === "string" && store.has(k) ? store.get(k) : { todos: [] }),
			set: async (k: any, v: any) => void store.set(String(k), v),
			remove: async (k: any) => void store.delete(String(k)),
		},
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	return {
		injected,
		cleanup,
		push: (type: string, data: Record<string, unknown> = {}) => stream.push(ev(type, SID, data)),
		logs: () => capture.lines.join("\n"),
	}
}

const OLD = Date.now() - 3600_000

describe("v2: quota ladders survive a plugin reload", () => {
	test("a fresh evaluation re-arms from the stored record and retries", async () => {
		// First evaluation: quota failure arms the ladder (record written).
		const store = new Map<string, unknown>()
		const capture = capturePluginLogs()
		const h1 = await setup(capture, [], store)
		h1.push("session.execution.started")
		await wait(20)
		h1.push("session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(150)
		expect(h1.logs()).toContain("quota-armed sid=ses_parent")
		;(h1.cleanup as (() => void) | undefined)?.()
		const marked = h1.logs()

		// Second evaluation (the reload): same capture and store, fresh memory.
		const h2 = await setup(capture, [], store)
		await wait(600)
		const log = h2.logs()
		;(h2.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(marked).not.toContain("quota ladder restored")
		expect(log).toContain("quota ladder restored")
		// And the restored gate actually serves: cooldowns are 150ms here.
		expect(log).toContain("rate-limit cooldown served")
		expect(h2.injected.length).toBeGreaterThanOrEqual(1)
	})

	test("CONTROL: a user message after the arm means no restore", async () => {
		const store = new Map<string, unknown>()
		const capture = capturePluginLogs()
		const h1 = await setup(capture, [], store)
		h1.push("session.execution.started")
		await wait(20)
		h1.push("session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(150)
		// The user's genuine turn resets the ladder and deletes the stored
		// record, so the reload has nothing to restore.
		h1.push("session.execution.started")
		await wait(100)
		;(h1.cleanup as (() => void) | undefined)?.()

		// User continued the session after the arm: ladder already reset.
		const h2 = await setup(capture, [
			{
				type: "user",
				id: "msg_u_new",
				time: { created: Date.now() },
				content: [{ type: "text", text: "continue" }],
			},
			...[],
		])
		await wait(400)
		const log = h2.logs()
		;(h2.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).not.toContain("quota ladder restored")
	})
})
