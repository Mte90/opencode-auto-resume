import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexOocThrottleTest"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_ooc_throttle"

/**
 * Upstream issue #46: a provider rate-limit whose message contains "too many
 * tokens" ("You have sent too many tokens to CodiX in a short period. Please
 * wait a moment before retrying.") matched the bare `too many tokens`
 * alternative in OOC_ERROR_RE, latched oocLocked, and halted all recovery.
 *
 * The rule: transient throttle phrasing routes to the rate-limit cooldown
 * ladder (like quota), never to the OOC latch. Genuine context-overflow
 * phrasing still latches (control).
 */



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

const THROTTLE = { error: { type: "AI_APICallError", message: "You have sent too many tokens to CodiX in a short period. Please wait a moment before retrying." } }
const GENUINE_OOC = { error: { type: "ContextOverflowError", message: "This request exceeds the available context size" } }

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

type Harness = { injected: Array<{ text?: string; resume?: boolean; synth?: boolean }>; stream: any; cleanup?: () => void; capture: any; failTurn: (err: unknown) => Promise<void> }

async function replay(opts: Record<string, unknown> = {}): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, ...opts, registryScope: LOG_SALT },
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
	const failTurn = async (err: unknown) => {
		for (const e of [ev("session.execution.started"), ev("session.step.started")]) {
			stream.push(e)
			await wait(10)
		}
		stream.push(ev("session.step.failed", err as Record<string, unknown>))
		await wait(10)
	}
	return { injected, stream, cleanup, capture, failTurn }
}



describe("v2: throttle phrasing never latches OOC (issue #46)", () => {
	test("throttle 'too many tokens ... wait before retrying' stands down on the ladder, no OOC latch", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(THROTTLE)
		await wait(300)
		expect(h.injected.some((i) => /Rate limited, retrying in/.test(i.text ?? ""))).toBe(true)
		const logs = h.capture.lines
		expect(logs.some((l) => l.includes("OOC error latched"))).toBe(false)
		h.capture.stop()
		h.cleanup?.()
	})

	test("CONTROL: genuine context overflow still latches OOC", async () => {
		const h = await replay({ rateLimitCooldownsMs: [60_000] })
		await h.failTurn(GENUINE_OOC)
		await wait(300)
		const logs = h.capture.lines
		expect(logs.some((l) => l.includes("OOC error latched"))).toBe(true)
		h.capture.stop()
		h.cleanup?.()
	})
})
