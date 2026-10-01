import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_standdown"
/** Older than the 15m default activeUserWindowMs, so guard (b) cannot mask a failure. */
const OLD_USER_MS = 30 * 60_000

/** Text that trips `ready-to-continue` but NOT `isUserHandoff` (no "?", no "should I"). */
const READY_TEXT = "Ready to continue with task"

// ---------------------------------------------------------------------------
// Mock host: drives the real v2 seam (`event.subscribe` async iterable) and
// records the real injection primitive (`session.synthetic`).
// ---------------------------------------------------------------------------

type Injected = { kind: string; text?: string; description?: string }

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

const textPart = (t: string) => ({ type: "text", text: t })

function toolPart(name: string, status: string) {
	return {
		type: "tool",
		id: "prt_" + name,
		name,
		callID: "call_" + name,
		executed: status === "completed",
		state: { status, input: { questions: [{ header: "Pick", question: "A or B?" }] } },
		time: { created: Date.now() },
	}
}

const oldUserTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - OLD_USER_MS },
	content: [textPart("go ahead")],
})

/** Assistant turn carrying recovery-triggering text and an optional tool part. */
function assistantTurn(text: string, tool?: ReturnType<typeof toolPart>) {
	const content: any[] = [textPart(text)]
	if (tool) content.push(tool)
	return { type: "assistant", id: "msg_a1", time: { created: Date.now() - 60_000 }, content }
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: SID, ...data } })

/** Events for one assistant turn that streams `text`, then goes idle. */
function turnEvents(text: string, toolName?: string) {
	const seq: any[] = [
		ev("session.execution.started"),
		ev("session.text.delta", { messageID: "msg_a1", delta: text }),
		ev("session.text.ended", { messageID: "msg_a1" }),
	]
	if (toolName) seq.push(ev("session.tool.called", { tool: toolName }))
	seq.push(ev("session.idle"))
	return seq
}

/** Replay a turn and report whether the plugin injected a recovery. */
async function replay(opts: { messages: any[]; events: any[] }): Promise<Injected[]> {
	const injected: Injected[] = []
	const stream = makeEventStream()
	const ctx: any = {
		event: stream,
		app: { log: () => {} },
		options: { toolTextCheckDelayMs: 0 },
		session: {
			// v2 returns a plain ARRAY here, not { messages }. Asserted separately below.
			context: async () => opts.messages,
			active: async () => ({}),
			synthetic: async (a: any) => {
				injected.push({ kind: "synthetic", ...a })
				return {}
			},
			prompt: async (a: any) => {
				injected.push({ kind: "prompt", ...a })
				return {}
			},
		},
	}
	const cleanup = await (plugin as any).setup(ctx)
	for (const e of opts.events) {
		stream.push(e)
		await wait(10)
	}
	await wait(500) // handleEvent is sync; its work is async
	;(cleanup as (() => void) | undefined)?.()
	return injected
}

// ============================================================================
// BEHAVIOURAL — drive the real plugin and assert on real injections.
// ============================================================================

describe("v2: stand down while the user owes us an answer", () => {
	test("CONTROL: nothing pending -> recovery fires (otherwise the rest proves nothing)", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn(READY_TEXT)],
			events: turnEvents(READY_TEXT),
		})
		expect(injected.length).toBeGreaterThan(0)
		expect(injected[0].kind).toBe("synthetic")
	})

	// The v2 message projection never writes "pending" — it writes "running".
	// The old guard tested for "pending" literally, so it could never fire and
	// every nudge went out over an unanswered `question` (#33 / valentimarco).
	for (const status of ["running", "error", "pending"]) {
		test(`question tool unanswered, state.status=${status} -> no injection`, async () => {
			const injected = await replay({
				messages: [oldUserTurn(), assistantTurn(READY_TEXT, toolPart("question", status))],
				events: turnEvents(READY_TEXT, "question"),
			})
			expect(injected).toEqual([])
		})
	}

	test("question tool ANSWERED (status=completed) -> recovery may fire", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn(READY_TEXT, toolPart("question", "completed"))],
			events: turnEvents(READY_TEXT, "question"),
		})
		expect(injected.length).toBeGreaterThan(0)
	})

	test("non-interactive tool that errored (status=error) -> recovery may fire", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn(READY_TEXT, toolPart("shell", "error"))],
			events: turnEvents(READY_TEXT, "shell"),
		})
		expect(injected.length).toBeGreaterThan(0)
	})

	test("permission.asked then session.idle -> no injection", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn(READY_TEXT)],
			events: [
				ev("session.execution.started"),
				ev("session.text.delta", { messageID: "msg_a1", delta: READY_TEXT }),
				ev("session.text.ended", { messageID: "msg_a1" }),
				ev("permission.asked"),
				ev("session.idle"),
			],
		})
		expect(injected).toEqual([])
	})

	test("permission asked then REPLIED, then session.idle -> recovery may fire", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn(READY_TEXT)],
			events: [
				ev("session.execution.started"),
				ev("session.text.delta", { messageID: "msg_a1", delta: READY_TEXT }),
				ev("session.text.ended", { messageID: "msg_a1" }),
				ev("permission.asked"),
				ev("permission.replied"),
				ev("session.idle"),
			],
		})
		expect(injected.length).toBeGreaterThan(0)
	})

	test("unanswered text question -> no injection (hand-off guard still works)", async () => {
		const injected = await replay({
			messages: [oldUserTurn(), assistantTurn("Which option do you want me to take?")],
			events: turnEvents("Which option do you want me to take?"),
		})
		expect(injected).toEqual([])
	})
})

// ============================================================================
// CONTRACT — fail deterministically if someone reverts the fix.
// ============================================================================

describe("v2: contract assertions on source", () => {
	test("FIX: the tool-state test is not a literal 'pending'-only comparison", () => {
		// The old single condition could never be true on v2.
		expect(SOURCE).not.toMatch(/t\.startsWith\("tool"\)\)\s*&&\s*part\?\.state\?\.status === "pending"/)
		expect(SOURCE).toMatch(/TOOL_STATE_RUNNING/)
		expect(SOURCE).toMatch(/TOOL_STATE_COMPLETED/)
	})

	test("FIX: markIdle no longer clears permissionPending", () => {
		const start = SOURCE.indexOf("function markIdle")
		expect(start).toBeGreaterThan(-1)
		// Scope to markIdle's own body: the stale-clear helper that follows it is
		// allowed to reset the flag, markIdle is not.
		const end = SOURCE.indexOf("function clearStalePermissionFlag", start)
		expect(end).toBeGreaterThan(start)
		const body = SOURCE.slice(start, end)
		expect(body).not.toMatch(/w\.permissionPending = false/)
		// ...but a stale unanswered prompt still cannot strand the session forever.
		expect(body).toMatch(/clearStalePermissionFlag/)
	})

	test("FIX: permission.replied is paired with its timestamp", () => {
		expect(SOURCE).toMatch(/case "permission\.asked"[\s\S]{0,400}permissionPendingAt = Date\.now\(\)/)
		expect(SOURCE).toMatch(/case "permission\.replied"[\s\S]{0,400}permissionPendingAt = null/)
	})

	test("FIX: a stale permission flag is cleared by TTL, not by the idle transition", () => {
		expect(SOURCE).toMatch(/PERMISSION_STALE_TTL_MS/)
		expect(SOURCE).toMatch(/function clearStalePermissionFlag/)
	})
})
