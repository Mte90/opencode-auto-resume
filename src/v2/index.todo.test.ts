import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_todo"

/**
 * The todo list as the plugin under test reads it.
 *
 * auto-resume does not own a todo list — it reads one. In v2 the real store is the
 * SESSION MESSAGE LOG: every `todowrite` call is persisted as a tool part whose
 * input carries the whole list, so the newest completed call IS the current list.
 * The v1-shaped `todos/<sessionID>` storage key is kept as a last-resort fallback
 * (nothing in v2 writes it, so it always misses).
 *
 * The `replay` harness therefore takes both: `todos` populates the storage
 * fallback, `messages` supplies the message log. Left undefined, `messages`
 * resolves to an empty page so the storage cases keep testing storage — which is
 * the point, because the fallback must stay alive.
 *
 * Three things are under test:
 *
 *   The celebration cross-check. A trailing 🎉 is the model's own "finished"
 *   signal, and latching on it is what stops the nudge. But a model that finishes
 *   early celebrates early, so the emoji alone is not trustworthy: with work still
 *   listed, the celebration is a false positive and the right answer is to name
 *   what is unfinished.
 *
 *   Two done-claim prompts, two budgets. A done-claim with open todos and a
 *   done-claim with no detail report are different problems; spending one budget
 *   must not silence the other.
 *
 *   When a budget re-arms. #26 was an unbounded done-claim nudge. The fix is that
 *   it re-arms only on a genuinely new work cycle — an inbound user message —
 *   not on every turn the model announces completion again.
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

const userMessage = (text: string, at: number) => ({
	type: "user",
	id: `msg_u_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

const assistantMessage = (text: string, at: number) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
	finish: "stop",
	tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
})

const OPEN = [
	{ content: "Write the migration guide", status: "pending", priority: "high" },
	{ content: "Delete the temp fixtures", status: "in_progress", priority: "low" },
]
const CLOSED = [
	{ content: "Write the migration guide", status: "completed", priority: "high" },
	{ content: "Delete the temp fixtures", status: "cancelled", priority: "low" },
]

/** An hour ago: outside the 5-minute active-user window, so idle nudges do not stand down. */
const OLD = Date.now() - 60 * 60_000
/** Ten minutes ago: still outside that window, but newer than OLD. */
const RECENT_BUT_STALE = Date.now() - 10 * 60_000

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

type Harness = {
	injected: Array<{ text?: string }>
	logs: string[]
	storageWrites: string[]
	storageReads: string[]
}

async function replay(
	turns: Array<{ text: string; userMessages?: unknown[] }>,
	todos: unknown[] | undefined,
	opts: Record<string, unknown> = {},
	storageShape: { omitStorage?: boolean } = {},
	messages: unknown[] | undefined = undefined,
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const storageWrites: string[] = []
	const storageReads: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-todo-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// The history grows turn by turn, exactly as a real session's does.
	let history: unknown[] = []

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile, ...opts },
		session: {
			context: async () => history,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: {
			session: {
				get: async () => ({ data: {} }),
				// The message list endpoint answers with a `{ data, cursor }` envelope,
				// never a bare array — handing the envelope straight to the parser trips
				// its Array.isArray guard and silently resolves nothing. Reproduced here
				// so that trap is exercised by every test in the group below.
				message: { list: async () => ({ data: messages ?? [], cursor: null }) },
			},
		},
	}
	if (!storageShape.omitStorage) {
		ctx.storage = {
			get: async (key: string) => {
				storageReads.push(key)
				return { todos: todos ?? [], updatedAt: Date.now() }
			},
			// Present so that "the plugin never writes here" is an assertion the
			// harness can actually make, rather than an assumption.
			set: async (key: string) => storageWrites.push(key),
			remove: async (key: string) => storageWrites.push(key),
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	for (const turn of turns) {
		for (const m of turn.userMessages ?? []) history.push(m)
		history.push(assistantMessage(turn.text, Date.now() - 30_000))
		for (const e of [
			ev("session.execution.started"),
			ev("session.step.started"),
			ev("session.step.ended"),
			ev("session.idle"),
		]) {
			stream.push(e)
			await wait(10)
		}
	}
	await wait(700)
	;(cleanup as (() => void) | undefined)?.()

	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, logs, storageWrites, storageReads }
}

/** A done-claim with nothing in it — the premature stop. */
const BARE_DONE = "Task done."
/** The same, but closed out with the model's own finished signal. */
const CELEBRATED = "Everything is in place. 🎉"

describe("v2: the todo list, read from the tool that owns it", () => {
	test("CONTROL: a celebration with open todos is a false positive, and is named", async () => {
		const { injected, logs } = await replay([{ text: CELEBRATED }], OPEN)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("Write the migration guide")
		expect(injected[0].text).toContain("Delete the temp fixtures")
		expect(logs.some((l) => l.includes("open-todos-celebration-false-positive"))).toBe(true)
	})

	test("CONTROL: a celebration with everything closed latches and never nudges", async () => {
		const { injected, logs } = await replay([{ text: CELEBRATED }, { text: CELEBRATED }], CLOSED)
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("no open todos — latching completion"))).toBe(true)
	})

	test("CONTROL: a bare done-claim with open todos gets the work prompt, not the details prompt", async () => {
		const { injected } = await replay([{ text: BARE_DONE }], OPEN)
		expect(injected).toHaveLength(1)
		// v1's wording for this branch names the todo list.
		expect(injected[0].text).toContain("todo list")
	})

	test("CONTROL: the same bare done-claim with no todos still gets the details prompt", async () => {
		const { injected } = await replay([{ text: BARE_DONE }], [])
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("no work description")
		expect(injected[0].text).not.toContain("todo list")
	})

	test("both done-claim prompts stay live independently", async () => {
		// Two different problems. If the todo branch spent the same budget as the
		// details branch, exhausting one would silently disable the other.
		const withTodos = await replay([{ text: BARE_DONE }, { text: BARE_DONE }], OPEN, { maxRetries: 1 })
		const withoutTodos = await replay([{ text: BARE_DONE }, { text: BARE_DONE }], [], { maxRetries: 1 })
		expect(withTodos.injected).toHaveLength(1)
		expect(withoutTodos.injected).toHaveLength(1)
		expect(withTodos.injected[0].text).not.toBe(withoutTodos.injected[0].text)
	})

	test("the done-claim budget does not re-arm just because the model repeated itself", async () => {
		// This is #26. A model that re-announces completion every turn used to be
		// handed a fresh budget every time it announced, so the nudge never stopped.
		const { injected } = await replay([{ text: BARE_DONE }, { text: BARE_DONE }, { text: BARE_DONE }], [], {
			maxRetries: 1,
		})
		expect(injected).toHaveLength(1)
	})

	test("a genuinely new user message does re-arm it", async () => {
		// The other half of the fix: the budget must be recoverable, or one bad
		// stretch would silence the plugin for the rest of the session.
		const { injected } = await replay(
			[
				{ text: BARE_DONE, userMessages: [userMessage("first ask", OLD)] },
				{ text: BARE_DONE },
				{ text: BARE_DONE, userMessages: [userMessage("actually, also this", RECENT_BUT_STALE)] },
			],
			[],
			{ maxRetries: 1 },
		)
		expect(injected).toHaveLength(2)
	})

	test("a celebration with open todos keeps being caught on later turns", async () => {
		// Proof that the false-positive branch does not latch: a latched turn
		// would go silent here.
		const { injected } = await replay([{ text: CELEBRATED }, { text: CELEBRATED }], OPEN, { maxRetries: 1 })
		expect(injected).toHaveLength(2)
	})

	test("the list is read under the todo tool's own key", async () => {
		const { storageReads } = await replay([{ text: CELEBRATED }], OPEN)
		expect(storageReads).toContain(`todos/${SID}`)
	})

	test("the plugin never writes to that key", async () => {
		// It is a consumer, not a second owner. A write here would mean auto-resume
		// was maintaining a copy that could drift from the real one.
		const { storageWrites } = await replay([{ text: CELEBRATED }], OPEN)
		expect(storageWrites).toEqual([])
	})

	test("the list is read once per turn, not once per check", async () => {
		// The storage call is cheap but the cache is the difference between one read
		// and two on every idle where both a celebration and a done-claim are judged.
		const { storageReads } = await replay([{ text: CELEBRATED }], OPEN)
		expect(storageReads.filter((k) => k === `todos/${SID}`).length).toBeLessThanOrEqual(2)
	})

	test("no storage domain at all is not a crash", async () => {
		// A host without ctx.storage must degrade to "cannot conclude", which means
		// the old behaviour — latch on the emoji — rather than a thrown error.
		const { injected, logs } = await replay([{ text: CELEBRATED }], OPEN, {}, { omitStorage: true })
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("latching completion"))).toBe(true)
	})

	test("a malformed record is treated as no list, not as no work", async () => {
		// The dangerous direction is "list unreadable" → "nothing is open" → nudge.
		// Both malformed shapes must fall back to the old behaviour instead.
		for (const bad of [{ todos: "nope" }, { todos: [null, 7] }, null]) {
			const stream = makeEventStream()
			const logFile = join(tmpdir(), `auto-resume-todo-bad-${process.pid}-${counter++}.log`)
			rmSync(logFile, { force: true })
			const injected: unknown[] = []
			const ctx: any = {
				event: stream,
				options: { ...OPTIONS, logFile },
				session: {
					context: async () => [userMessage("ask", OLD), assistantMessage(CELEBRATED, Date.now())],
					active: async () => ({}),
					interrupt: async () => ({}),
					synthetic: async (a: any) => (injected.push(a?.text), {}),
					prompt: async (a: any) => (injected.push(a?.text), {}),
				},
				client: { session: { get: async () => ({ data: {} }) } },
				storage: { get: async () => bad, set: async () => {}, remove: async () => {} },
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
			await wait(600)
			;(cleanup as (() => void) | undefined)?.()
			rmSync(logFile, { force: true })
			expect(injected).toEqual([])
		}
	})

	test("the work prompt is configurable", async () => {
		const { injected } = await replay([{ text: BARE_DONE }], OPEN, {
			doneWithoutWorkPrompt: "Your todo list still has open items.",
		})
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toBe("Your todo list still has open items.")
	})
})


describe("v2: the todo list is read from the session message log", () => {
	/** A completed `todowrite` tool part, stamped so ordering is unambiguous. */
	const part = (todos: unknown[], at: number) => ({
		type: "tool",
		name: "todowrite",
		state: { status: "completed", input: { todos }, time: { start: at, end: at } },
	})
	const msg = (parts: unknown[]) => ({ role: "user", content: parts })
	/** A `todowrite` part whose `input` is `input` verbatim, for malformed shapes. */
	const rawPart = (input: unknown, at: number) => ({
		type: "tool",
		name: "todowrite",
		state: { status: "completed", input, time: { start: at, end: at } },
	})

	/** Distinct from OPEN/CLOSED so an assertion cannot pass on the wrong list. */
	const NEWEST = [{ content: "newest open item", status: "pending", priority: "high" }]
	const OLDER = [{ content: "older open item", status: "pending", priority: "low" }]

	test("CONTROL: a todowrite in the log is enough, with the storage key left empty", async () => {
		// The bug this group exists for. A storage-only reader finds an empty key,
		// concludes "no todos", and fires a false done-claim nudge on a session with
		// work still listed — which is how /todo printed [0/0] beside 14 todos.
		const { injected, logs, storageReads } = await replay(
			[{ text: CELEBRATED }],
			[],
			{},
			{},
			[msg([part(OPEN, Date.now())])],
		)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("Write the migration guide")
		// Not read at all: the log answered, so the dead key is never consulted.
		expect(storageReads).not.toContain(`todos/${SID}`)
		expect(logs.some((l) => l.includes("todos via ctx.client.session.message.list"))).toBe(true)
	})

	test("the NEWEST completed todowrite wins, not the oldest", async () => {
		// `/api/session/{id}/message` returns NEWEST FIRST, so a last-match-wins loop
		// selects the OLDEST list. This shipped in two places before it was caught,
		// and it is silent: an older list is a plausible-looking list.
		const now = Date.now()
		const { injected } = await replay(
			[{ text: CELEBRATED }],
			[],
			{},
			{},
			// Newest first, exactly as the endpoint orders it.
			[msg([part(NEWEST, now)]), msg([part(OLDER, now - 60_000)])],
		)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("newest open item")
		expect(injected[0].text).not.toContain("older open item")
	})

	test("an unfinished todowrite is ignored, not half-read", async () => {
		// Only a COMPLETED call replaced the list. A pending or failed one carries a
		// partial input, and treating that as the list is how a half-written todo
		// becomes "everything is done".
		const { injected, logs } = await replay(
			[{ text: CELEBRATED }],
			[],
			{},
			{},
			[
				msg([
					{
						type: "tool",
						name: "todowrite",
						state: { status: "error", input: { todos: NEWEST }, time: { end: Date.now() } },
					},
				]),
			],
		)
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("no open todos — latching completion"))).toBe(true)
	})

	test("a malformed list yields 'cannot conclude', never an empty list", async () => {
		// The dangerous direction is "unreadable" becoming "nothing is open". An
		// unreadable list must fall through to the fallback, exactly like no list.
		for (const bad of [{ todos: "nope" }, { todos: [null, 7] }, {}]) {
			const { injected } = await replay(
				[{ text: CELEBRATED }],
				[],
				{},
				{},
				[msg([rawPart(bad, Date.now())])],
			)
			expect(injected).toEqual([])
		}
	})

	test("the storage fallback still answers when the log has no todowrite", async () => {
		// The fallback is not dead code we can drop: it is the only source on a host
		// whose log the plugin cannot read.
		const { injected, storageReads } = await replay(
			[{ text: CELEBRATED }],
			OPEN,
			{},
			{},
			[msg([{ type: "text", text: "no tool calls here" }])],
		)
		expect(storageReads).toContain(`todos/${SID}`)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toContain("Write the migration guide")
	})

	test("a host with neither source degrades instead of crashing", async () => {
		const { injected, logs } = await replay(
			[{ text: CELEBRATED }],
			[],
			{},
			{ omitStorage: true },
			[],
		)
		expect(injected).toEqual([])
		expect(logs.some((l) => l.includes("latching completion"))).toBe(true)
	})
})
