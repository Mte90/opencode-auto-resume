import { describe, test, expect } from "bun:test"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: the whole permanent-failure gate set, table-driven.
 *
 * The classification is not invented here — it is opencode's own. Every gated
 * value below is an `error.type` from the taxonomy the running binary maps
 * (packages/llm/src/schema/errors.ts, `get retryable() === false`), or a status
 * / message shape that source treats the same way. Per the audit in
 * /tmp/opencode/error-taxonomy_findings.md:
 *
 *   gate: provider.auth / provider.no-route / provider.unknown /
 *         provider.content-filter / provider.unsupported-operation,
 *         http 401 / 403, model-gone messages, history-rejection messages
 *   NOT gated: provider.rate-limit + provider.quota (15m→2h cooldown ladder,
 *         ~12h total, for 5h rolling Zen quotas), provider.internal,
 *         provider.transport, provider.timeout, provider.invalid-output,
 *         tool.execution, compaction.failed, and 404 (openai returns 404 for
 *         models that ARE available — provider/error.ts:26).
 *
 * Harness is prod-shape: no `ctx.client`, `session.active()` returns {}, and the
 * loopback HTTP discovery paths are therefore unavailable — the gate must stand
 * on the event payload alone, exactly as it does in production.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 14000

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
const push = (h: any, type: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, data))

async function setup(): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-gateset-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// Prod shape: `client` is undefined in production (probed live 2026-10-06) and
	// must stay undefined here — the gate cannot lean on a discovery API.
	const ctx: any = {
		event: stream,
		options: {
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
			logFile,
			debug: true,
		},
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const logsOf = (h: any) => (existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : "")

/** Drive one failure event and report what the plugin did. */
async function drive(errType: string, errMsg: string, status?: number) {
	const h = await setup()
	push(h, "session.execution.started")
	await wait(20)
	push(h, "session.step.failed", { error: { type: errType, message: errMsg, ...(status === undefined ? {} : { status }) } })
	await wait(300)
	const injected = h.injected.length
	const latched = logsOf(h).includes("permanent failure latched")
	await teardown(h)
	return { injected, latched }
}

const GATED: Array<[string, string, number | undefined]> = [
	["provider.auth", "Unauthorized: request was blocked by a gateway or proxy.", 401],
	["provider.auth", "Forbidden: your account lacks access to this model.", 403],
	["provider.auth", "no api key found for anthropic", undefined],
	["provider.no-route", "No LLM route for openai/gpt-5 using default", undefined],
	["provider.unknown", "Model not found: exo-free", 404],
	["provider.content-filter", "Your request was blocked by content policy", undefined],
	["provider.unsupported-operation", "Model does not support tool use", undefined],
	// message-keyed (type too broad to gate on)
	["provider.invalid-request", "Model exo-free has been deprecated.", undefined],
	// 404 does NOT rescue a gone model — only the "unknown catalog entry" shape.
	["provider.invalid-request", "Model exo-free has been deprecated.", 404],
	["provider.invalid-request", "Model not found: exo-free", undefined],
	["provider.invalid-request", "Referenced reasoning item 'rs_6abf:rs_0' was not found", undefined],
	["provider.invalid-request", "No tool output found for function call call_01a0", undefined],
	["provider.invalid-request", "The model gpt-9 has been retired", 400],
]

const NOT_GATED: Array<[string, string, number | undefined]> = [
	["provider.transport", "ConnectionRefused: Unable to connect", undefined],
	["provider.timeout", "request timed out after 30s", undefined],
	["provider.internal", "server_error: The model failed to generate a response.", 500],
	["provider.invalid-output", "OpenAI Chat stream ended without finish_reason", undefined],
	["provider.invalid-request", "Error from the provider: 400 Bad Request", 400],
	// 404 + "model not found" keeps recovering (openai returns 404 for live models).
	["provider.invalid-request", "Error from the provider: 404 model not found", 404],
	["provider.quota", "Rate limit exceeded. Please try again later.", 429],
	["provider.rate-limit", "Rate limit exceeded. Please try again later.", 429],
	["tool.execution", "Command execution failed", undefined],
	["compaction.failed", "Compaction produced no summary", undefined],
]

describe("v2: permanent-failure gate set", () => {
	for (const [type, msg, status] of GATED) {
		test(`GATED  ${type} ${status ?? "-"}/${msg.slice(0, 44)}`, async () => {
			const { injected, latched } = await drive(type, msg, status)
			expect(latched).toBe(true)
			expect(injected).toBe(0)
		})
	}

	for (const [type, msg, status] of NOT_GATED) {
		test(`RECOVERS ${type} ${status ?? "-"}/${msg.slice(0, 40)}`, async () => {
			const { latched } = await drive(type, msg, status)
			// Never latches. Whether it injects now or gates behind a cooldown
			// ladder (rate-limit/quota: 15m first rung) is a separate concern.
			expect(latched).toBe(false)
		})
	}

	test("quota stays on the cooldown ladder, not the permanent latch", async () => {
		const h = await setup()
		push(h, "session.execution.started")
		await wait(20)
		push(h, "session.step.failed", { error: { type: "provider.quota", message: "Rate limit exceeded.", status: 429 } })
		await wait(300)
		const log = logsOf(h)
		await teardown(h)
		expect(log).not.toContain("permanent failure latched")
		// The ladder is what should answer a 5h rolling quota.
		expect(log).toMatch(/quota|rate limit|cooling|gate/i)
	})

	test("a genuine turn clears the latch and recovery resumes", async () => {
		const h = await setup()
		push(h, "session.execution.started")
		await wait(20)
		push(h, "session.step.failed", { error: { type: "provider.auth", message: "no api key", status: 401 } })
		await wait(150)
		expect(h.injected.length).toBe(0)
		expect(logsOf(h)).toContain("permanent failure latched")
		// User re-auths and starts a fresh turn: latch must release.
		push(h, "session.execution.started")
		await wait(20)
		push(h, "session.step.failed", { error: { type: "provider.transport", message: "ConnectionRefused" } })
		await wait(300)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThanOrEqual(1)
	})
})