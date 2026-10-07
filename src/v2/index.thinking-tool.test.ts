import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_thinking_tool"

/**
 * A tool call written into the reasoning block.
 *
 * When a model emits raw tool-call markup inside its thinking instead of calling
 * the tool, nothing executes and nothing raises: the turn completes, the text the
 * user sees may be fine, and the work silently does not happen. The text variant
 * of this failure has its own detector and its own prompt; the reasoning variant
 * needs a different one, because the model is not forgetting the mechanism, it is
 * writing in the wrong channel.
 *
 * v2 makes this a separate read rather than a filter inside a joined string:
 * `AssistantContent` tags reasoning and text distinctly, so the newest message's
 * reasoning parts can be judged on their own.
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
	content: [{ type: "text", text: "fix the failing test" }],
})

const assistantTurn = (parts: Array<Record<string, unknown>>) => ({
	type: "assistant",
	id: "msg_a1",
	time: { created: Date.now() - 60_000 },
	content: parts,
	finish: "stop",
	tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
})

/**
 * Every fixture carries a normal text part.
 *
 * Without one the message is a *silent dead stream* — finished, no text, plenty
 * of output tokens — and that detector fires first with its own "continue". That
 * is correct behaviour and it has its own tests; here it would just mask which
 * branch is under test.
 */

/** A raw tool call sitting in the reasoning, with normal prose alongside. */
const REASONING_WITH_TOOL_CALL = [
	{ type: "text", text: "Let me start by reading the failing test." },
	{
		type: "reasoning",
		text: "I should read the test file first.\n<function=read>\n<parameter=path>src/a.test.ts</parameter>\n</function>",
	},
]
/** Ordinary reasoning, no markup. */
const REASONING_ONLY = [
	{ type: "text", text: "Checking which assertion is wrong." },
	{ type: "reasoning", text: "Let me think about which assertion is wrong here." },
]
/** The same markup, but in the text part where the text detector already sees it. */
const TEXT_WITH_TOOL_CALL = [{ type: "text", text: "<function=read><parameter=path>src/a.test.ts</parameter></function>" }]

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

async function replay(
	parts: Array<Record<string, unknown>>,
	opts: Record<string, unknown> = {},
): Promise<{ injected: Array<{ text?: string }>; logs: string[] }> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-thinktool-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...opts },
		session: {
			context: async () => [userTurn(), assistantTurn(parts)],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: { session: { get: async () => ({ data: {} }) } },
	}

	const cleanup = await (plugin as any).setup(ctx)
	for (const e of [
		ev("session.execution.started"),
		ev("session.step.started"),
		ev("session.step.ended"),
		ev("session.idle"),
	]) {
		stream.push(e)
		await wait(10)
	}
	await wait(700)
	;(cleanup as (() => void) | undefined)?.()

	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, logs }
}

describe("v2: a tool call written into the reasoning block", () => {
	test("CONTROL: markup in the reasoning asks the model to use the tool mechanism", async () => {
		const { injected } = await replay(REASONING_WITH_TOOL_CALL)
		expect(injected).toHaveLength(1)
		// The reasoning prompt is specific to this failure: the tool call is
		// well-formed, it was just written in the wrong channel.
		expect(injected[0].text).toContain("thinking/reasoning")
	})

	test("CONTROL: the same markup in a text part asks for the tool mechanism generally", async () => {
		const { injected } = await replay(TEXT_WITH_TOOL_CALL)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).not.toContain("thinking/reasoning")
	})

	test("reasoning with no tool call in it is left alone", async () => {
		const { injected, logs } = await replay(REASONING_ONLY)
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("tool-call-in-reasoning"))).toBe(false)
	})

	test("the reasoning prompt is configurable", async () => {
		const { injected } = await replay(REASONING_WITH_TOOL_CALL, {
			thinkingToolRecoveryPrompt: "Use the real tool call, not reasoning.",
		})
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toBe("Use the real tool call, not reasoning.")
	})

	test("code blocks in reasoning are not mistaken for a tool call", async () => {
		// Same code-stripping the text detector uses: a fenced example of the
		// shape, or an inline path in backticks, must not trigger a nudge.
		const { injected } = await replay([
			{ type: "text", text: "Checking how the tool-call format is documented." },
			{
				type: "reasoning",
				text: "The format is documented as:\n```\n<function=read>\n<parameter=path>x</parameter>\n</function>\n```\n",
			},
		])
		expect(injected).toEqual([])
	})

	test("both channels in one message: the reasoning one is judged first", async () => {
		// The reasoning variant silently does nothing, so reporting the text one
		// would send the model off to fix the wrong thing.
		const { injected } = await replay([...TEXT_WITH_TOOL_CALL, ...REASONING_WITH_TOOL_CALL])
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("thinking/reasoning")
	})

	test("the budget is shared with the text variant, not doubled", async () => {
		// One phenomenon with two symptoms. Two independent budgets would let the
		// plugin spend twice the retries on a model that keeps doing this.
		const { injected } = await replay(REASONING_WITH_TOOL_CALL, { maxRetries: 1 })
		expect(injected.length).toBeLessThanOrEqual(1)
	})
})