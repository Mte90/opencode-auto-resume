import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexDeadStreamTest"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_deadstream"

/**
 * Silent dead stream.
 *
 * The model can end a turn having produced nothing the user can see: reasoning
 * only, or a finish reason the provider did not describe. The turn looks
 * complete, so no stall timer expires and no streaming failure fires — the
 * session just goes quiet with the work unfinished. Nothing in v1's event
 * stream catches it either; it takes reading the finished message itself.
 *
 * The rule, from v1: the newest assistant message that HAS a finish reason
 * decides. If it carried text, the session answered and there is nothing to
 * recover. If it did not, and it generated at least `silentDeadStreamMinTokens`
 * output tokens, the stream died mid-response.
 *
 * The walk deliberately skips messages with no finish reason. An intermediate
 * tool-call step has none, and stopping at it would report a dead stream for
 * every session that used a tool — which is why "walk back past a delivered
 * answer to an intermediate step" matters.
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

const userTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - 60 * 60_000 },
	content: [{ type: "text", text: "do the thing" }],
})

/** An assistant message that finished with a `finish` reason and `output` tokens. */
const finished = (opts: { finish?: string; text?: string; output?: number; reasoning?: string }) => ({
	type: "assistant",
	id: "msg_a1",
	time: { created: Date.now() - 60_000 },
	...(opts.text !== undefined
		? { content: [{ type: "text", text: opts.text }] }
		: { content: [{ type: "reasoning", text: opts.reasoning ?? "thinking about the answer" }] }),
	finish: opts.finish ?? "stop",
	tokens: { input: 100, output: opts.output ?? 400, reasoning: 0, cache: { read: 0, write: 0 } },
})

/** A finished turn that issued tool calls but no chatter text: active work. */
const finishedWithTools = () => ({
	type: "assistant",
	id: "msg_a3",
	time: { created: Date.now() - 60_000 },
	content: [{ type: "tool", id: "call_9", name: "bash", state: { status: "completed" } }],
	finish: "stop",
	tokens: { input: 100, output: 400, reasoning: 0, cache: { read: 0, write: 0 } },
})

/** An intermediate tool-call step: no finish reason, so the walk skips it. */
const toolStep = () => ({
	type: "assistant",
	id: "msg_a2",
	time: { created: Date.now() - 30_000 },
	content: [{ type: "tool", id: "call_1", name: "bash", state: { status: "completed" } }],
	tokens: { input: 200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
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
	// Several assertions here are about a silent skip, which is exactly what the
	// debug log is for — and in v2 that log goes to the file, not the console.
	debug: true,
}

type Harness = { injected: Array<{ text?: string }>; logs: string[] }

async function replay(
	messages: unknown[],
	opts: Record<string, unknown> = {},
	extra: { serverRunning?: boolean; preIdleEvents?: Array<{ type: string; data?: Record<string, unknown> }> } = {},
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, ...opts, registryScope: LOG_SALT },
		session: {
			context: async () => [userTurn(), ...messages],
			// The server's own record of what is running, which is what the
			// recovering-provider guard consults.
			active: async () => (extra.serverRunning ? { [SID]: { sessionID: SID } } : {}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => {
				injected.push({ text: a?.text })
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

	for (const e of [
		ev("session.execution.started"),
		ev("session.step.started"),
		...(extra.preIdleEvents ?? []).map((p) => ev(p.type, p.data ?? {})),
		ev("session.step.ended"),
		ev("session.idle"),
	]) {
		stream.push(e)
		await wait(10)
	}
	await wait(700)
	capture.stop()
	;(cleanup as (() => void) | undefined)?.()

	return { injected, logs: capture.lines }
}

/** Reasoning-only finish with plenty of output: the real dead stream. */
const DEAD = [finished({ output: 400 })]

describe("v2: silent dead stream", () => {
	test("CONTROL: a finished message with no text and enough output tokens resumes", async () => {
		const { injected, logs } = await replay(DEAD)
		expect(injected).toHaveLength(1)
		expect(logs.some((l) => l.includes("silent dead stream: finish=stop, 400 output tokens"))).toBe(true)
		expect(logs.some((l) => l.includes("Silent dead stream (stop)"))).toBe(true)
	})

	test("a finished message that delivered text is a normal completion", async () => {
		const { injected, logs } = await replay([finished({ text: "The change is in src/index.ts and tests pass.", output: 400 })])
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("silent dead stream"))).toBe(false)
	})

	test("below the token floor it is a short answer, not a dead stream", async () => {
		// 40 output tokens with no text: the model simply had nothing to say. The
		// floor exists so a one-word turn is not nudged forever.
		const { injected, logs } = await replay([finished({ output: 40 })])
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("only 40 output tokens (floor 200)"))).toBe(true)
	})

	test("the floor is configurable", async () => {
		const quiet = await replay([finished({ output: 40 })], { silentDeadStreamMinTokens: 200 })
		expect(quiet.injected).toEqual([])
		const loud = await replay([finished({ output: 40 })], { silentDeadStreamMinTokens: 10 })
		expect(loud.injected).toHaveLength(1)
	})

	test("the walk skips a tool-call step and judges the answer behind it", async () => {
		// Newest is an intermediate step with no finish reason. The finished
		// message behind it has text, so this session just used a tool.
		const { injected } = await replay([finished({ text: "Ran the tests; 42 pass.", output: 400 }), toolStep()])
		expect(injected).toEqual([])
	})

	test("a tool-call step in front of a dead stream is still found", async () => {
		// The other direction: skipping the unfinished step must not hide the
		// dead finish behind it.
		const { injected } = await replay([finished({ output: 400 }), toolStep()])
		expect(injected).toHaveLength(1)
	})

	test("a finished turn carrying tool calls is working, not a dead stream", async () => {
		// ses_efaec2f99ffexosULGDJJ8i6sA 2026-10-04: a thinking model doing tool
		// work ends turns with finish=stop, hundreds of output tokens, and no
		// text parts. Judging that "silent" fires a visible continue into
		// active work. Tool calls are delivered work — not silence.
		const { injected, logs } = await replay([finishedWithTools()])
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("silent dead stream"))).toBe(false)
	})

	test("tools still in flight veto the dead-stream inject", async () => {
		// Belt and braces for the race the test above cannot see: the finished
		// message predates the tool events, so the message looks dead while the
		// calls it issued have not answered yet.
		const { injected } = await replay([finished({ output: 400 })], {}, {
			preIdleEvents: [{ type: "session.tool.called", data: { tool: "bash", id: "call_9" } }],
		})
		expect(injected).toEqual([])
	})

	test("a session the server still reports as running is left alone — this pass", async () => {
		// A provider that is quietly retrying looks identical from the event
		// stream. Injecting into that would turn a recovering session into a
		// stalled one, which is the harm the guard prevents — and the event may
		// not have arrived yet, so the guard asks the server.
		//
		// "This pass" is doing real work in that sentence. The server listing
		// is weak evidence (its active map is known-stale), so declining must
		// not bury the session: the next inspection re-reads the server fresh.
		// The old code returned handled here, which ended the whole inspection
		// and permanently buried real dead streams (2026-10-11).
		const { injected, logs } = await replay(DEAD, {}, { serverRunning: true })
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("deferring, not burying"))).toBe(true)
	})

	test("declining on a stale server listing does not bury the remaining checks", async () => {
		// The fall-through this pins: a dead stream where the server still
		// lists the session, PLUS an unfinished tool call. Old code returned
		// handled at the dead-stream guard, so the stuck-tool check never ran
		// and nothing was ever injected. New code declines (false), the
		// stuck-tool check runs, and the session gets its nudge.
		const stuckPart = {
			type: "assistant",
			id: "msg_stuck",
			time: { created: Date.now() - 120_000 },
			content: [{ type: "tool", id: "call_9", name: "compress", state: { status: "streaming" }, time: { created: Date.now() - 120_000 } }],
		}
		const { injected } = await replay([finished({ output: 400 }), stuckPart], {}, { serverRunning: true })
		expect(injected).toHaveLength(1)
		expect(String((injected[0] as any).text ?? "")).toContain("never returned a result")
	})

	test("CONTROL for that guard: the same dead stream on an idle session does resume", async () => {
		// Otherwise the guard could pass because the detector stopped working.
		const { injected } = await replay(DEAD, {}, { serverRunning: false })
		expect(injected).toHaveLength(1)
	})

	test("no finished message at all is not a dead stream", async () => {
		// Mid-first-turn: nothing has finished yet, so there is nothing to judge.
		const { injected } = await replay([toolStep()])
		expect(injected).toEqual([])
	})

	test("a user-cancelled session is never resumed", async () => {
		const stream = makeEventStream()
		const capture = capturePluginLogs()
		const injected: unknown[] = []
		const ctx: any = {
			app: { name: "opencode", version: "2.0.27", channel: "stable" },
			event: stream,
			options: { ...OPTIONS, registryScope: LOG_SALT },
			session: {
				context: async () => [userTurn(), finished({ output: 400 })],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => (injected.push(1), {}),
			},
			client: { session: { get: async () => ({ data: {} }) } },
		}
		const cleanup = await (plugin as any).setup(ctx)
		for (const e of [
			ev("session.execution.started"),
			ev("session.execution.interrupted", { reason: "user" }),
			ev("session.idle"),
		]) {
			stream.push(e)
			await wait(10)
		}
		await wait(600)
		capture.stop()
		;(cleanup as (() => void) | undefined)?.()
		expect(injected).toEqual([])
	})

	test("the recovery budget is finite", async () => {
		// Two dead turns in a row must not queue unbounded injections.
		const { injected } = await replay([finished({ output: 400 })], { maxRetries: 2 })
		expect(injected.length).toBeGreaterThan(0)
		expect(injected.length).toBeLessThanOrEqual(2)
	})

	test("an idle turn that delivered nothing gets one instant nudge", async () => {
		// The hole this closes: no finish (not a dead stream), no parts (not
		// stuck), no text (nothing for the pattern checks) — every detector
		// passes over it in silence and the session sits until the next event,
		// which may never come. One quiet continue, immediately, no 180s wait.
		const { injected, logs } = await replay([])
		expect(injected).toHaveLength(1)
		expect(logs.some((l) => l.includes("instant nudge"))).toBe(true)
	})

	test("CONTROL: a turn that delivered text gets no instant nudge", async () => {
		const { logs } = await replay([finished({ text: "The change is in src/index.ts and tests pass.", output: 400 })])
		expect(logs.some((l) => l.includes("instant nudge"))).toBe(false)
	})

	test("CONTROL: a user-cancelled empty turn is never nudged", async () => {
		// The user's stop is final, even when the turn delivered nothing.
		const stream = makeEventStream()
		const capture = capturePluginLogs()
		const injected: unknown[] = []
		const ctx: any = {
			app: { name: "opencode", version: "2.0.27", channel: "stable" },
			event: stream,
			options: { ...OPTIONS, registryScope: LOG_SALT },
			session: {
				context: async () => [userTurn()],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => (injected.push(1), {}),
			},
			client: { session: { get: async () => ({ data: {} }) } },
		}
		const cleanup = await (plugin as any).setup(ctx)
		for (const e of [
			ev("session.execution.started"),
			ev("session.execution.interrupted", { reason: "user" }),
			ev("session.idle"),
		]) {
			stream.push(e)
			await wait(10)
		}
		await wait(600)
		capture.stop()
		;(cleanup as (() => void) | undefined)?.()
		expect(injected).toEqual([])
	})

	test("the instant nudge fires once per episode, not once per idle", async () => {
		// Two idle transitions with no new turn between them: the second finds
		// the flag set and stays quiet. A new turn (markBusy) re-arms it.
		const stream = makeEventStream()
		const capture = capturePluginLogs()
		const injected: unknown[] = []
		const ctx: any = {
			app: { name: "opencode", version: "2.0.27", channel: "stable" },
			event: stream,
			options: { ...OPTIONS, registryScope: LOG_SALT },
			session: {
				context: async () => [userTurn()],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => (injected.push(1), {}),
			},
			client: { session: { get: async () => ({ data: {} }) } },
		}
		const cleanup = await (plugin as any).setup(ctx)
		for (const e of [
			ev("session.execution.started"),
			ev("session.step.started"),
			ev("session.step.ended"),
			ev("session.idle"),
			ev("session.idle"),
		]) {
			stream.push(e)
			await wait(10)
		}
		await wait(700)
		;(cleanup as (() => void) | undefined)?.()
		expect(injected).toHaveLength(1)
	})
})