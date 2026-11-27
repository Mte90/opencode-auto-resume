import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/**
 * Negative assertions for the quota fail-loop stand-down (fix B, PR #57).
 *
 * index.quota-loop.test.ts proves the latch warning appears; it never proves
 * the behavior. Here:
 *  1. after the latch, further rate-limit failures arm nothing and inject
 *     nothing new (the stand-down actually stands down);
 *  2. a genuine user turn re-arms: the next failures restart the count from 1
 *     and no longer latch. Without the reset, the continued counting would
 *     latch again — the completionHard bug class.
 */

const LOG_SALT = "IndexQuotaLoopResetTest"
const SID_ARM = "ses_quota_arm"
const SID_RESET = "ses_quota_reset"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeStream() {
	const q: any[] = []
	const ws: ((e: any) => void)[] = []
	const s: any = {
		push(e: any) {
			if (ws.length) ws.shift()!(e)
			else q.push(e)
		},
		subscribe: () => s,
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((res) => {
						if (q.length) return res({ value: q.shift(), done: false })
						ws.push((e) => res({ value: e, done: false }))
					}),
			}
		},
	}
	return s
}

const rateLimitFailure = (sid: string) => ({
	type: "session.step.failed",
	data: { sessionID: sid, error: { type: "provider.rate-limit", message: "429 too many requests" } },
})

async function setup(sid: string) {
	const stream = makeStream()
	const capture = capturePluginLogs()
	const history: any[] = [
		{ type: "user", id: "u1", time: { created: Date.now() - 60_000 }, text: "do the work" },
		{ type: "assistant", id: "a1", time: { created: Date.now() - 1_000 }, content: [] },
	]
	const injected: string[] = []
	const removeCalls: string[] = []
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: 150,
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
		},
		session: {
			context: async () => history,
			active: async () => ({ [sid]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push(String(a?.text ?? "")), {}),
			prompt: async (a: any) => (injected.push(String(a?.text ?? "")), {}),
		},
		client: { session: { get: async () => ({ data: {} }), list: async () => ({ data: [{ id: sid }] }) } },
		storage: {
			get: async () => ({ todos: [] }),
			set: async () => {},
			remove: async (key: string) => {
				removeCalls.push(String(key))
			},
		},
		tool: { transform: async () => ({ dispose() {} }), list: async () => [] },
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	return { cleanup, stream, capture, history, injected, removeCalls, sid }
}

const countOf = (log: string, re: RegExp) => (log.match(re) ?? []).length

describe("quota fail-loop stand-down behavior", () => {
	test("after the latch, further rate-limit failures arm and inject nothing", async () => {
		const h = await setup(SID_ARM)
		for (let i = 0; i < 5; i++) {
			h.stream.push(rateLimitFailure(h.sid))
			await wait(60)
		}
		await wait(200)
		const logBefore = h.capture.lines.join("\n")
		expect(logBefore).toContain("quota loop (")
		// Rung 0 armed once on the first failure; the skipped re-arm branch
		// keeps cooldown renewals silent until the latch.
		expect(countOf(logBefore, /quota-armed sid=/g)).toBe(1)
		expect(h.injected.length).toBe(1)
		for (let i = 0; i < 3; i++) {
			h.stream.push(rateLimitFailure(h.sid))
			await wait(60)
		}
		await wait(200)
		const logAfter = h.capture.lines.join("\n")
		await h.cleanup()
		h.capture.stop()
		// Stand-down holds: no new arming, no new user-visible notice.
		expect(countOf(logAfter, /quota-armed sid=/g)).toBe(1)
		expect(h.injected.length).toBe(1)
	})

	test("a genuine user turn re-arms after the latch", async () => {
		const h = await setup(SID_RESET)
		for (let i = 0; i < 5; i++) {
			h.stream.push(rateLimitFailure(h.sid))
			await wait(60)
		}
		await wait(200)
		// Genuine user takeover — the same block that resets workRetries also
		// clears quotaLoopCount/quotaLoopLatched and drops the persisted record.
		h.history.push({ type: "user", id: "u_human", time: { created: Date.now() }, text: "switch to a different approach" })
		h.stream.push({ type: "session.execution.started", data: { sessionID: h.sid } })
		await wait(150)
		expect(h.removeCalls).toContain(`resume-counters/${h.sid}`)
		for (let i = 0; i < 4; i++) {
			h.stream.push(rateLimitFailure(h.sid))
			await wait(60)
		}
		await wait(200)
		const log = h.capture.lines.join("\n")
		await h.cleanup()
		h.capture.stop()
		// Counts restart from 1, so failures 1-4 after the reset stay under the
		// latch threshold: the only "quota loop" line in the log is the
		// original one. Without the reset the counts would continue 6,7,8,9 and
		// produce four more.
		expect(countOf(log, /quota loop \(/g)).toBe(1)
	})
})
