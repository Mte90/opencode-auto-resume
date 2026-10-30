import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexPermFailureTest"

/**
 * v2: permanent failures latch recovery out.
 *
 * ses_ee46693e (2026-10-08): `provider.invalid-request Model exo-free has been
 * deprecated` matched no recovery category — not abort, not rate-limit, not
 * OOC, not streaming — so it fell into generic stall recovery and injected
 * `continue (attempt 1/3)` into a model that no longer exists. Twice, because
 * 21 plugin reloads in 4 minutes gave each instance a fresh attempt counter.
 *
 * Attempt budgets cannot cover this: they are per-instance and reset on
 * reload. Only the failure CLASS is stable across instances. So permanent
 * failures latch like oocLocked — keyed on the message (deprecated /
 * model-not-found shapes), never on `invalid-request` alone, which also
 * carries transient 400s.
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
const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function setup(): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

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
			debug: true,
		},
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
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
	return { injected, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


const stepFailed = (h: any, message: string, type = "provider.invalid-request") =>
	push(h, "session.step.failed", SID, { error: { type, message } })

describe("v2: permanent failures latch recovery out", () => {
	test("deprecated model error: no continue is injected", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		stepFailed(h, "Model exo-free has been deprecated.")
		await wait(400)
		const log = h.capture.lines.join("\n")
		await teardown(h)
		expect(h.injected.length).toBe(0)
		expect(log).toContain("latched")
	})

	test("CONTROL: transient invalid-request still recovers", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		stepFailed(h, "Error from the provider: 400 Bad Request")
		await wait(400)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	})

	test("a genuine new turn clears the latch", async () => {
		const h = await setup()
		push(h, "session.execution.started", SID)
		await wait(20)
		stepFailed(h, "Model exo-free has been deprecated.")
		await wait(200)
		expect(h.injected.length).toBe(0)
		// User starts a fresh turn (model changed): latch must release.
		push(h, "session.execution.started", SID)
		await wait(20)
		stepFailed(h, "Error from the provider: 500 upstream boom")
		await wait(400)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	})
})