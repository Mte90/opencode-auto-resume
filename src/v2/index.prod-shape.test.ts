import { describe, test, expect } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexProdShapeTest"

/**
 * v2: history readers must accept the PRODUCTION message shape.
 *
 * Audit 2026-10-10, verified against `opencode.db` (`message.data`):
 *   {"role":"user","time":{"created":1790213672332},"agent":"coder",...}
 *
 * The shape carries `role`, not `type`. Six readers checked only `.type`
 * while their neighbours in the same file already used the tolerant
 * `type ?? role` pattern, so the suite (938 green) validated a fiction:
 * every fixture in the suite built `{type:"user"}` / `{type:"assistant"}`.
 *
 * The worst case fails OPEN. `restoreQuotaLadders` computed `lastUserAt = 0`
 * for every session, so its guard `if (lastUserAt > mark.at) continue` never
 * fired and a quota ladder re-armed for a session the user had already
 * continued after a restart — a false nag injected into live work.
 *
 * These tests assert BOTH shapes work. Fixing by swapping to `role` alone
 * would be the same bug wearing a different hat.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_prod"


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
	rateLimitCooldownsMs: [150, 150],
	debug: true,
}

async function setup(
	capture: any,
	history: unknown[] = [],
	extra: Record<string, unknown> = {},
	contextDelayMs = 0,
): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()

	const ctx: any = {
		event: stream,
		options: { ...OPTS, capture, ...extra, registryScope: LOG_SALT },
		session: {
			context: async () => {
				if (contextDelayMs) await wait(contextDelayMs)
				return history
			},
			active: async () => ({}),
			list: async () => [{ id: SID }],
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [{ id: "bash" }],
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	return {
		injected,
		cleanup,
		push: (type: string, data: Record<string, unknown> = {}) => stream.push(ev(type, data)),
		logs: () => capture.lines.join("\n"),
		capture,
	}
}

const freshLog = () => {
	const capture = capturePluginLogs()
	return capture
}

// --- prod-shaped fixtures ---------------------------------------------------
// `role` + flat `text`, exactly as opencode.db stores them.

const prodUser = (at: number, text = "do the thing") => ({ role: "user", text, time: { created: at } })

const prodAssistant = (at: number, content: Array<Record<string, unknown>>) => ({
	role: "assistant",
	content,
	time: { created: at },
})

// The shape the rest of the suite uses. Kept as a control: the fix must make
// both shapes work, not trade one for the other.
const TYPE_USER = (at: number) => ({ type: "user", content: [{ type: "text", text: "go" }], time: { created: at } })
const TYPE_ASSISTANT = (at: number, content: any[]) => ({ type: "assistant", content, time: { created: at } })

describe("v2: history readers accept the production message shape", () => {
	test("PROD: a user message after a quota arm suppresses the restore (fails OPEN today)", async () => {
		const capture = freshLog()
		const h1 = await setup(capture)
		h1.push("session.execution.started")
		await wait(20)
		h1.push("session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(150)
		expect(h1.logs()).toContain("quota-armed sid=ses_prod")
		;(h1.cleanup as (() => void) | undefined)?.()

		// Restart with the user having replied since the arm. Role shape.
		const h2 = await setup(capture, [prodUser(Date.now(), "keep going")])
		await wait(400)
		const log = h2.logs()
		;(h2.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).not.toContain("quota ladder restored")
	})

	test("PROD: a trailing tool error is retried (stuck-tool reader)", async () => {
		const capture = freshLog()
		const now = Date.now()
		// The user message must sit outside the 5-minute active window or the
		// stand-down guard fires first and the reader is never reached.
		const history = [
			prodUser(now - 600_000),
			prodAssistant(now - 120_000, [
				{ type: "text", text: "running it" },
				{
					type: "tool",
					name: "bash",
					state: { status: "error", error: { type: "tool.error", message: "command not found" } },
					time: { created: now - 115_000 },
				},
			]),
	]
	const h = await setup(capture, history)
		h.push("session.idle")
		await wait(500)
		const log = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).toContain("failed at end of turn")
		expect(h.injected.some((i: any) => /Retry it now/.test(i.text ?? ""))).toBe(true)
	})

	test("TYPE: the same trailing tool error still retries (no shape regression)", async () => {
		const capture = freshLog()
		const now = Date.now()
		const history = [
			TYPE_USER(now - 600_000),
			TYPE_ASSISTANT(now - 120_000, [
				{ type: "text", text: "running it" },
				{
					type: "tool",
					name: "bash",
					state: { status: "error", error: { type: "tool.error", message: "command not found" } },
					time: { created: now - 115_000 },
				},
			]),
	]
	const h = await setup(capture, history)
		h.push("session.idle")
		await wait(500)
		const log = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).toContain("failed at end of turn")
	})

	test("PROD: a reasoning-only turn is nudged (silent-reasoning reader)", async () => {
		const capture = freshLog()
		const now = Date.now()
		const history = [
			prodUser(now - 600_000),
			prodAssistant(now - 60_000, [{ type: "reasoning", text: "thinking about it" }]),
		]
		const h = await setup(capture, history)
		h.push("session.idle")
		await wait(500)
		const log = h.logs()
		;(h.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).toContain("reasoning-only turn with no output")
	})

	test("PROD: a restored ladder does not re-announce a notice it already sent", async () => {
		const capture = freshLog()
		const h1 = await setup(capture)
		h1.push("session.execution.started")
		await wait(20)
		h1.push("session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(150)
		;(h1.cleanup as (() => void) | undefined)?.()

		// Reload mid-episode, then a fresh quota hit. The first-arm notice went
		// out before the reload; restoring the ladder must carry that fact over
		// or the user gets a duplicate "retrying in ~Xm" for the same episode.
		const h2 = await setup(capture, [])
		await wait(300)
		h2.push("session.execution.started")
		await wait(20)
		h2.push("session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(300)
		const notices = h2.injected.filter((i: any) => /Rate limited, retrying in/.test(i.text ?? "")).length
		;(h2.cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(notices).toBeLessThanOrEqual(1)
	})

	test("PROD: a child session that died on an error is seen as crashed", async () => {
		// The child-status reader keys off the last message being an assistant
		// message carrying `error`. Prod sends `role`, so a `type`-only read
		// never matched and a crashed subagent looked merely slow.
		const capture = freshLog()
		const CHILD = "ses_child_prod"
		const now = Date.now()
		const stream = makeEventStream()
		const injected: Array<{ text?: string }> = []
		const childHistory = [{ role: "assistant", error: { type: "api.error", message: "boom" }, time: { created: now } }]

		const ctx: any = {
			event: stream,
			options: { ...OPTS, capture, subagentDeadMs: 60_000, subagentWaitMs: 50, registryScope: LOG_SALT },
			session: {
				context: async (a: any) => (a?.sessionID === CHILD ? childHistory : []),
				active: async () => ({}),
				list: async () => [{ id: SID }, { id: CHILD, parentID: SID }],
				interrupt: async () => ({}),
				synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
				prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
			},
			client: { session: { list: async () => ({ data: [{ id: SID }, { id: CHILD, parentID: SID }] }) } },
			storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
			tool: {
				transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
				list: async () => [{ id: "bash" }],
			},
		}
		const cleanup = await (plugin as any).setup(ctx)
		await wait(80)
		// Parent busy, child idle with a dead-on-arrival error.
		stream.push(ev("session.execution.started"))
		await wait(20)
		stream.push(ev("session.step.started"))
		await wait(20)
		stream.push({ type: "session.idle", data: { sessionID: CHILD } })
		await wait(700)
		stream.push({ type: "session.idle", data: { sessionID: SID } })
		await wait(900)
		const log = capture.lines.join("\n")
		;(cleanup as (() => void) | undefined)?.()
		capture.stop()

		expect(log).toContain("reported an error")
	})

	test("GUARD: no message reader compares a bare `.type` against a role", async () => {
		// The regression this file exists for. Every occurrence below is a
		// reader that goes blind when the server sends `role`, and each one
		// passed the suite because the fixtures used `type`. Part-level checks
		// (`part?.type === "tool"`) are correct and must not match.
		const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
		const blind = src.match(/\b(?:m|last|msg)\s*\??\.\s*type\s*(?:===|!==)\s*"(?:user|assistant)"/g) ?? []
		expect(blind.map((s) => s.replace(/\s+/g, ""))).toEqual([])
	})

	test("PROD: every reader routes through the shared accessors", async () => {
		// The two blind readings are gone, but so could the next one be. Count
		// the call sites: the fix must actually be load-bearing in the six
		// readers the audit named, not merely present in the file.
		const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
		const uses = (src.match(/\bmsgRole\(/g) ?? []).length
		const ats = (src.match(/\bmsgAt\(/g) ?? []).length
		// One definition of each plus the production call sites.
		expect(uses).toBeGreaterThanOrEqual(8)
		expect(ats).toBeGreaterThanOrEqual(5)
	})
})

describe("v2: watchdog re-entrancy", () => {
	test("an overrunning sweep is not overlapped by the next tick", async () => {
		const capture = freshLog()
		const now = Date.now()
		const history = [
			prodUser(now - 600_000),
			prodAssistant(now - 120_000, [
				{
					type: "tool",
					name: "bash",
					state: { status: "error", error: { type: "tool.error", message: "nope" } },
					time: { created: now - 115_000 },
				},
			]),
		]
		// context() takes 150ms against a 20ms interval: without a re-entrancy
		// guard every tick starts another concurrent sweep over the same watch.
		const h = await setup(capture, history, {}, 150)
		h.push("session.idle")
		await wait(900)
		const retries = h.injected.filter((i: any) => /Retry it now/.test(i.text ?? "")).length
		const skips = (h.logs().match(/watchdog sweep still running/g) ?? []).length
		;(h.cleanup as (() => void) | undefined)?.()
		capture.stop()

		// One stall is one recovery. Concurrent sweeps would double-inject.
		expect(retries).toBeLessThanOrEqual(1)
		// And the guard is provably what prevents it: an overrun actually
		// happened, so this is not a pass by never racing.
		expect(skips).toBeGreaterThan(0)
	})

	test("GUARD: the watchdog interval is guarded against overlap", async () => {
		// Belt and braces: a behavioural skip can be satisfied by other guards,
		// so assert the guard itself is still in the source.
		const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
		expect(src).toContain("watchdogBusy")
	})

	test("GUARD: the checked tool-part id set is bounded", async () => {
		const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
		expect(src).toContain("CHECKED_TOOL_PART_IDS_MAX")
	})
})