import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/**
 * v2: `contextWrapupAttempts` re-arms per turn.
 *
 * Bug (2026-11-20): the field's own doc says "Saturation intervention is
 * one-shot per turn, like v1's `contextWrapupAttempts`." (line 462) and
 * "The intervention is one-shot per turn." (line 6377), yet the ONLY
 * initialization is at line 2124 — there is NO `w.contextWrapupAttempts = 0`
 * in the per-turn reset block (markBusy, ~2205-2234). Result: the intervention
 * fires at most ONCE PER SESSION, contradicting its documented "per turn"
 * behaviour. The v1 build re-arms it per busy cycle (src/index.ts:1449, inside
 * resetBusyFlags).
 *
 * This test drives TWO separate busy cycles, each reaching saturation. The
 * intervention must fire in BOTH — not just the first. Observable via the
 * "context saturation" log line, not by inspecting the field directly.
 */

const LOG_SALT = "IndexContextWrapupRearms"
const SID = "ses_rerarm"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

const userTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - 60 * 60_000 },
	content: [{ type: "text", text: "keep going" }],
})

const usage = (input: number) => ({
	input,
	output: 0,
	reasoning: 0,
	cache: { read: 0, write: 0 },
})

async function setup(tokens: { input: number }, stream?: any, cleanupRef?: any) {
	const commands: Array<{ sessionID: string; name: string }> = []
	const stream_ = stream ?? makeEventStream()
	const capture = capturePluginLogs()

	const limit = { context: 200_000, output: 32_000 }
	const model = { id: "coder", providerID: "llama-server", limit, name: "coder" }

	const session: Record<string, unknown> = {
		context: async () => [userTurn(), { type: "assistant", id: "msg_a1", model: { providerID: "llama-server", id: "coder" } }],
		active: async () => ({}),
		interrupt: async () => ({}),
		synthetic: async () => ({}),
		prompt: async () => ({}),
		command: async (a: any) => {
			commands.push({ sessionID: a?.sessionID, name: a?.name })
			return {}
		},
	}

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream_,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: 600_000,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			injectIntervalMs: 0,
		},
		session,
		client: {
			session: {
				get: async () => ({ data: {} }),
			},
		},
		model: { get: (providerID: string, modelID: string) => (providerID === "llama-server" && modelID === "coder" ? model : undefined) },
		plugin: { list: async () => [{ id: "magic-context", source: { type: "local", path: "/x/magic-context" } }] },
	}

	const cleanup = cleanupRef ?? (await (plugin as any).setup(ctx))

	const events: any[] = [
		ev("session.execution.started", { agent: "build", model: { providerID: "llama-server", id: "coder" } }),
		ev("session.text.delta", { messageID: "msg_a1", delta: "Working through the list." }),
		ev("session.text.ended", { messageID: "msg_a1" }),
		ev("session.usage.updated", { tokens: usage(tokens.input) }),
		ev("session.idle"),
	]

	for (const e of events) {
		stream_.push(e)
		await wait(10)
	}
	await wait(400)

	return { commands, capture, cleanup, streamRef: stream_ }
}

describe("v2: contextWrapupAttempts re-arms per busy cycle", () => {
	test("the intervention fires in TWO separate busy cycles, not just the first", async () => {
		// SINGLE plugin instance, TWO busy cycles separated by a genuine user message.
		const stream = makeEventStream()
		const { cleanup, capture } = await setup({ input: 160_000 }, stream)

		// CYCLE 1: saturated context -> intervention fires
		const cycle1Events: any[] = [
			ev("session.execution.started", { agent: "build", model: { providerID: "llama-server", id: "coder" } }),
			ev("session.step.started"),
			ev("session.step.ended"),
			ev("session.text.delta", { messageID: "msg_a1", delta: "Working on it." }),
			ev("session.text.ended", { messageID: "msg_a1" }),
			ev("session.usage.updated", { tokens: usage(160_000) }),
			ev("session.idle"),
		]
		for (const e of cycle1Events) {
			stream.push(e)
			await wait(10)
		}
		await wait(400)

		const cycle1Saturation = capture.lines.filter((l) => l.includes("context saturation:"))
		expect(cycle1Saturation.length).toBeGreaterThanOrEqual(1)

		// A genuine user message arrives (not our own prompt)
		stream.push({
			type: "user",
			id: "msg_u1",
			time: { created: Date.now() },
			content: [{ type: "text", text: "please continue with the work" }],
		})
		await wait(10)

		// CYCLE 2: new execution.started triggers markBusy (which re-arms contextWrapupAttempts)
		// then saturated context -> intervention must fire AGAIN
		const cycle2Events: any[] = [
			ev("session.execution.started", { agent: "build", model: { providerID: "llama-server", id: "coder" } }),
			ev("session.step.started"),
			ev("session.step.ended"),
			ev("session.text.delta", { messageID: "msg_a2", delta: "Still working." }),
			ev("session.text.ended", { messageID: "msg_a2" }),
			ev("session.usage.updated", { tokens: usage(160_000) }),
			ev("session.idle"),
		]
		for (const e of cycle2Events) {
			stream.push(e)
			await wait(10)
		}
		await wait(400)

		const cycle2Saturation = capture.lines.filter((l) => l.includes("context saturation:"))
		// BEFORE fix: only 1 saturation log (first cycle only, counter never re-armed in markBusy)
		// AFTER fix: 2 saturation logs (one per cycle, counter re-armed by markBusy)
		expect(cycle2Saturation.length).toBeGreaterThanOrEqual(2)

		cleanup()
		capture.stop()
	})
})
