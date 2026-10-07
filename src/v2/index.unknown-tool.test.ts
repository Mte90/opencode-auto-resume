import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_unknown_tool"

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

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

/** An hour ago: outside the 5-minute active-user window, so the idle path is not
 *  suppressed for "the user is mid-conversation". */
const OLD = Date.now() - 60 * 60_000

/**
 * A v2 tool part. Note `name` and `id`: v2 names the tool in `name`, where v1
 * read `part.tool`. `id` is the call id, which is what the "already examined"
 * set keys on.
 */
const toolPart = (id: string, name: string, status: "error" | "completed" | "running" = "error") => ({
	type: "tool",
	id,
	name,
	time: { created: OLD },
	state:
		status === "error"
			? { status, input: {}, error: "tool not found" }
			: status === "completed"
				? { status, input: {}, content: [{ type: "text", text: "ok" }] }
				: { status, input: {}, metadata: {} },
})

/** An assistant message carrying tool parts. It always has a text part too, and
 *  that is not incidental: a finished assistant message with no text part is a
 *  silent dead stream, and that detector fires first and would swallow the test. */
const assistantWith = (...content: unknown[]) => ({
	type: "assistant",
	id: "msg_a_here",
	time: { created: OLD + 1_000 },
	content: [{ type: "text", text: "Let me look at that." }, ...content],
})

const TOOLS = [{ id: "read" }, { id: "write" }, { id: "glob" }, { id: "bash" }, { id: "task_complete" }]

async function setup(
	opts: {
		history?: unknown[]
		tools?: Array<{ id: string }> | undefined
		toolRegistry?: boolean
		toolListThrows?: boolean
		parentID?: string
	},
): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-ut-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const history: unknown[] = opts.history ?? []
	const listed = opts.tools ?? TOOLS

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: {
			session: { get: async () => ({ data: opts.parentID ? { id: SID, parentID: opts.parentID } : { id: SID } }) },
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
	}
	if (opts.toolRegistry !== false) {
		ctx.tool = {
			transform: async (cb: any) => {
				cb({ add: () => {} })
				return { dispose() {} }
			},
			list: async () => {
				if (opts.toolListThrows) throw new Error("registry unavailable")
				return listed
			},
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	return {
		injected,
		history,
		...({ cleanup, logFile, streamRef: stream } as any),
	}
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

/** Drive a turn to idle, which is what makes the plugin look at the history. */
async function goIdle(h: any) {
	for (const e of [ev("session.execution.started"), ev("session.step.started"), ev("session.step.ended"), ev("session.idle")]) {
		h.streamRef.push(e)
		await wait(10)
	}
	await wait(250)
}

const suggestions = (h: any) => h.injected.filter((i: any) => /does not exist/.test(i.text ?? ""))

describe("v2: naming a replacement for a tool that does not exist", () => {
	test("CONTROL: one invented tool call is a typo and gets no suggestion", async () => {
		// The threshold is the whole design: a model that misspells one tool name
		// normally self-corrects, and interrupting it teaches it nothing.
		const h = await setup({ history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "globb"))] })
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("a second invented call to the same name earns a suggestion", async () => {
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "globb")), assistantWith(toolPart("call_2", "globb"))],
		})
		await goIdle(h)
		const said = suggestions(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('"globb"')
		expect(said[0].text).toContain('The closest matching tool is "glob"')
		// And the list, so a name that is not a near match is still recoverable.
		expect(said[0].text).toContain("read, write, glob, bash")
		await teardown(h)
	})

	test("a name with no near match gets the list without a wrong suggestion", async () => {
		// Naming a bad near-match is worse than naming nothing: the model switches
		// to it, fails again, and now believes the registry is unreliable.
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "zzqqxx")),
				assistantWith(toolPart("call_2", "zzqqxx")),
			],
		})
		await goIdle(h)
		const said = suggestions(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain("Please check the available tools")
		expect(said[0].text).not.toContain("The closest matching tool is")
		await teardown(h)
	})

	test("the suggestion is sent once, not on every idle", async () => {
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "globb")),
				assistantWith(toolPart("call_3", "globb")),
			],
		})
		await goIdle(h)
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		await teardown(h)
	})

	test("two different unknown names are counted separately", async () => {
		// Sharing a budget across names would let an unrelated pair of typos silence
		// the threshold for the name that actually matters.
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "wriet")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("a new user message re-arms the budget", async () => {
		// The budget is scoped to one request. A model told to do something new has
		// a fresh tool list in front of it, so the previous round's typos say nothing
		// about this one.
		//
		// The re-arm resets counts and the latch, but NOT the examined-parts set:
		// recounting already-suggested errors is what nagged a live session with
		// the same suggestion on every user message (2026-10-04). New errors still
		// earn a suggestion — and it names the NEW name, not the old one.
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "globb")), assistantWith(toolPart("call_2", "globb"))],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		h.history.push(userMessage("now do the other thing", OLD + 2_000, "msg_u_second"))
		h.history.push(assistantWith(toolPart("call_3", "wriet")))
		h.history.push(assistantWith(toolPart("call_4", "wriet")))
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(2)
		expect(suggestions(h)[1].text).toContain('"wriet"')
		await teardown(h)
	})

	test("a genuine new request does not re-suggest already-reported errors", async () => {
		// The 3:40 PM incident: every real user message re-armed, cleared the
		// examined set, and recounted the SAME stale bash errors — one suggestion
		// per user message while the model had long moved on.
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "bash")), assistantWith(toolPart("call_2", "bash"))],
			tools: [{ id: "read" }, { id: "shell" }, { id: "glob" }],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		h.history.push(userMessage("stop ignoring; report repeats", OLD + 2_000, "msg_u_second"))
		await goIdle(h)
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		await teardown(h)
	})

	test("our own suggestion is not a new request and does not re-arm", async () => {
		// ses_ef81e8561ffeXyx3jAzKl5lltv 2026-10-04: the visible channel posts
		// our suggestion as a real user message with a new id. The next idle
		// read it as new instructions, cleared the error map, the latch and
		// the examined-parts set, recounted the SAME parts back to threshold,
		// and suggested again — four identical "(none)" prompts, each "2x".
		const tools = [{ id: "read" }, { id: "shell" }, { id: "glob" }]
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "bash")), assistantWith(toolPart("call_2", "bash"))],
			tools,
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		const own = suggestions(h)[0]
		h.history.push({
			type: "user",
			id: "msg_own_suggestion",
			time: { created: OLD + 3_000 },
			content: [{ type: "text", text: own.text }],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		await teardown(h)
	})

	test("own prompt with an unreadable body still does not re-arm", async () => {
		// The live projection can carry user messages with no readable text
		// (observed: content null), which defeats text matching. Recency to
		// our own inject is the backstop: our prompt always lands within
		// seconds of it.
		const tools = [{ id: "read" }, { id: "shell" }, { id: "glob" }]
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "bash")), assistantWith(toolPart("call_2", "bash"))],
			tools,
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		h.history.push({ type: "user", id: "msg_own_bare", time: { created: Date.now() }, content: null })
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(1)
		await teardown(h)
	})

	test("a v1 tool name maps to its v2 rename instead of (none)", async () => {
		// "bash" is edit-distance 4 from "shell" against a threshold of 2, so
		// the fuzzy matcher can never bridge it. A static alias tried first can.
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "bash")), assistantWith(toolPart("call_2", "bash"))],
			tools: [{ id: "read" }, { id: "shell" }, { id: "glob" }],
		})
		await goIdle(h)
		const said = suggestions(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain('The closest matching tool is "shell"')
		await teardown(h)
	})

	test("CONTROL: an alias whose target is not registered falls back to the list", async () => {
		// The alias must never name a tool that does not exist: a wrong guess
		// costs a second failure round and teaches the model the registry lies.
		const h = await setup({
			history: [userMessage("go", OLD), assistantWith(toolPart("call_1", "bash")), assistantWith(toolPart("call_2", "bash"))],
			tools: [{ id: "read" }, { id: "write" }, { id: "glob" }],
		})
		await goIdle(h)
		const said = suggestions(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain("Please check the available tools")
		expect(said[0].text).not.toContain("The closest matching tool is")
		await teardown(h)
	})
})

describe("v2: what the unknown-tool check ignores", () => {
	test("CONTROL: a tool that exists but errored is not an unknown tool", async () => {
		// The dangerous false positive is telling a model a real tool does not
		// exist. An error from a registered tool is a real problem, and the right
		// response to it is not a rename.
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "read")),
				assistantWith(toolPart("call_2", "read")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: a tool that succeeded is not counted", async () => {
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb", "completed")),
				assistantWith(toolPart("call_2", "globb", "completed")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: a still-running tool is not counted", async () => {
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb", "running")),
				assistantWith(toolPart("call_2", "globb", "running")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("the same call id is never counted twice", async () => {
		// The history is re-walked on every idle, so a part that is already counted
		// would be counted again on the next pass and the threshold would be reached
		// by one real mistake.
		const part = toolPart("call_1", "globb")
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith(part),
				assistantWith(structuredClone(part)),
				assistantWith(structuredClone(part)),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: text and reasoning parts are ignored", async () => {
		const h = await setup({
			history: [
				userMessage("go", OLD),
				assistantWith({ type: "reasoning", text: "I should call globb" }),
				assistantWith({ type: "text", text: "tool: globb" }),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})
})

describe("v2: the unknown-tool check degrades rather than guessing", () => {
	test("CONTROL: no tool registry means no suggestion, ever", async () => {
		// With no registry every name is unknown, so the check would accuse a model
		// of inventing tools that plainly exist.
		const h = await setup({
			toolRegistry: false,
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "globb")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: an empty registry means no suggestion", async () => {
		const h = await setup({
			tools: [],
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "globb")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		await teardown(h)
	})

	test("a registry that throws is logged and skipped", async () => {
		// Failing loudly here would mean a session full of one-line recovery
		// prompts, which is worse than losing the feature for a few minutes.
		const h = await setup({
			toolListThrows: true,
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "globb")),
			],
		})
		await goIdle(h)
		expect(suggestions(h)).toHaveLength(0)
		const logs = existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : ""
		expect(logs).toContain("failed to list tools")
		await teardown(h)
	})

	test("a registry entry with no name at all is dropped, not quoted as empty", async () => {
		// An unnamed entry would otherwise be joined into the tool list as an empty
		// item, and the suggestion would read "... include: , read, write".
		const h = await setup({
			tools: [{ id: "read" }, { id: "write" }, { id: "glob" }, {} as any],
			history: [
				userMessage("go", OLD),
				assistantWith(toolPart("call_1", "globb")),
				assistantWith(toolPart("call_2", "globb")),
			],
		})
		await goIdle(h)
		const said = suggestions(h)
		expect(said).toHaveLength(1)
		expect(said[0].text).toContain("read, write, glob")
		expect(said[0].text).not.toContain(", , ")
		await teardown(h)
	})
})
