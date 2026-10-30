import { describe, test, expect, setDefaultTimeout } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/**
 * Behavioural counterpart to index.continue-guardrail.test.ts.
 *
 * The source-regex file proves the four sites NAME the guarded constant. This
 * proves the guardrail actually REACHES THE WIRE — that the text a model
 * receives carries the instruction. Source assertions alone are the failure mode
 * I spent today documenting (a guard that is spelled correctly and never
 * engages); this drives the plugin and reads what it sent.
 */
const LOG_SALT = "IndexContinueGuardrailBehaviour"
const SID = "ses_parent"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
setDefaultTimeout(30_000)



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

const userMessage = (at: number, text = "go") => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})
const assistantWith = (at: number, text: string) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const GUARD = "Do not start anything new"
const DESTRUCTIVE = "destructive or irreversible actions"

async function setup(opts: Record<string, unknown>, history: unknown[]): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: 60,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 1,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			debug: true,
			...opts,
		},
		session: {
			context: async () => history,
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
	return { injected, streamRef: stream, capture, cleanup }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


describe("v2: the guardrail reaches the model, not just the source", () => {
	test("the stall recovery continue carries the guardrail", async () => {
		// Drives a real silence stall and reads the injected text.
		const now = Date.now()
		const h = await setup({}, [userMessage(now - 600_000), assistantWith(now - 300_000, "still working")])
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		const said = h.injected.map((i: { text?: string }) => i.text ?? "")
		await teardown(h)
		expect(said.length).toBeGreaterThan(0)
		expect(said[0]).toContain("continue")
		expect(said[0]).toContain(GUARD)
		expect(said[0]).toContain(DESTRUCTIVE)
	})

	test("the stall continue says not to continue anything destructive", async () => {
		// The specific worry: a fallible liveness signal plus an unbounded
		// "continue" is how a model talks itself into a destructive action.
		const now = Date.now()
		const h = await setup({}, [userMessage(now - 600_000), assistantWith(now - 300_000, "working")])
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		const text = h.injected[0]?.text ?? ""
		await teardown(h)
		expect(text).toMatch(/without explicit user approval/)
		expect(text.toLowerCase()).not.toContain("delete")
	})
})