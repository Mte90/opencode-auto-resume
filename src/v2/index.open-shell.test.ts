import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_openshell"
const OTHER_SID = "ses_someone_else"
/** Older than the 15m default activeUserWindowMs, so guard (b) cannot mask a failure. */
const OLD_USER_MS = 30 * 60_000
/** Trips `ready-to-continue` but NOT `isUserHandoff` (no "?", no "should I"). */
const READY_TEXT = "Ready to continue with task"

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

const oldUserTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - OLD_USER_MS },
	content: [textPart("go ahead")],
})

function assistantTurn(text: string) {
	return { type: "assistant", id: "msg_a1", time: { created: Date.now() - 60_000 }, content: [textPart(text)] }
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: SID, ...data } })

// --- shell process-registry events -----------------------------------------
// These deliberately mirror the real payload shape observed on the running
// server: `shell.created` carries NO top-level sessionID — it is nested at
// `data.info.metadata.sessionID` — and the exit events carry only the shell id.
// `shell.deleted` is given a different id family, as observed.

const shellCreated = (id: string, sessionID: string = SID) => ({
	type: "shell.created",
	data: { info: { id, command: "sleep 12", status: "running", metadata: { sessionID } } },
})
/** Built explicitly: a default parameter would silently substitute a valid id. */
const shellCreatedRaw = (info: Record<string, unknown>) => ({ type: "shell.created", data: { info } })
const shellExited = (id: string) => ({ type: "shell.exited", data: { id, status: "exited", exit: 0 } })
const shellDeleted = (id: string) => ({ type: "shell.deleted", data: { id } })

/** One assistant turn that streams `text`, then goes idle. */
function turnEvents(text: string) {
	return [
		ev("session.execution.started"),
		ev("session.text.delta", { messageID: "msg_a1", delta: text }),
		ev("session.text.ended", { messageID: "msg_a1" }),
		ev("session.idle"),
	]
}

/** Replay events and report whether the plugin injected a recovery. */
async function replay(events: any[], messages?: any[]): Promise<Injected[]> {
	const injected: Injected[] = []
	const stream = makeEventStream()
	const ctx: any = {
		event: stream,
		app: { log: () => {} },
		options: { toolTextCheckDelayMs: 0 },
		session: {
			context: async () => messages ?? [oldUserTurn(), assistantTurn(READY_TEXT)],
			// Empty: no other session is active, so the `lastWasTaskTool` branch
			// (which needs `others.length > 0`) cannot mask any failure below.
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
	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	await wait(500) // handleEvent is sync; its work is async
	;(cleanup as (() => void) | undefined)?.()
	return injected
}

// ============================================================================
// BEHAVIOURAL
// ============================================================================

describe("v2: a session running a shell is working, not idle", () => {
	test("CONTROL: no shell involved -> recovery fires (otherwise the rest proves nothing)", async () => {
		const injected = await replay(turnEvents(READY_TEXT))
		expect(injected.length).toBeGreaterThan(0)
	})

	test("shell open -> no injection (parent parked on a background job)", async () => {
		const injected = await replay([shellCreated("sh_aaa"), ...turnEvents(READY_TEXT)])
		expect(injected).toEqual([])
	})

	test("shell open, then exited -> recovery may fire", async () => {
		const injected = await replay([shellCreated("sh_aaa"), shellExited("sh_aaa"), ...turnEvents(READY_TEXT)])
		expect(injected.length).toBeGreaterThan(0)
	})

	test("two shells open, one exits -> still suppressed", async () => {
		const injected = await replay([
			shellCreated("sh_aaa"),
			shellCreated("sh_bbb"),
			shellExited("sh_aaa"),
			...turnEvents(READY_TEXT),
		])
		expect(injected).toEqual([])
	})

	test("another session's open shell does not suppress us", async () => {
		const injected = await replay([shellCreated("sh_zzz", OTHER_SID), ...turnEvents(READY_TEXT)])
		expect(injected.length).toBeGreaterThan(0)
	})

	// A phantom entry from any of these would suppress recovery forever.
	for (const [label, info] of [
		["metadata present but sessionID missing", { id: "sh_bad", metadata: {} }],
		["metadata absent entirely", { id: "sh_bad" }],
		["sessionID is not a string", { id: "sh_bad", metadata: { sessionID: 42 } }],
		["no id", { metadata: { sessionID: SID } }],
		["info is a bare string", "not-an-object"],
	] as Array<[string, unknown]>) {
		test(`malformed shell.created (${label}) is ignored, not recorded`, async () => {
			const injected = await replay([shellCreatedRaw(info as Record<string, unknown>), ...turnEvents(READY_TEXT)])
			expect(injected.length).toBeGreaterThan(0)
		})
	}

	test("shell.exited for an unknown id does not throw or suppress", async () => {
		const injected = await replay([shellExited("sh_never_seen"), ...turnEvents(READY_TEXT)])
		expect(injected.length).toBeGreaterThan(0)
	})

	test("shell.deleted (different id family) cannot close an open shell", async () => {
		// Documents the reason `shell.deleted` is not wired up: its id never
		// matches the one recorded at create, so it is not a usable exit signal.
		const injected = await replay([shellCreated("sh_aaa"), shellDeleted("sh_bbb"), ...turnEvents(READY_TEXT)])
		expect(injected).toEqual([])
	})
})

// ============================================================================
// CONTRACT — fail deterministically if someone reverts the fix.
// ============================================================================

describe("v2: contract assertions on source", () => {
	test("FIX: the registry family is handled, not just the session-scoped one", () => {
		expect(SOURCE).toMatch(/case "shell\.created"/)
		expect(SOURCE).toMatch(/case "shell\.exited"/)
		// The session-scoped family is also correct and must be kept.
		expect(SOURCE).toMatch(/case "session\.shell\.started"/)
		expect(SOURCE).toMatch(/case "session\.shell\.ended"/)
	})

	test("FIX: the session is read from the nested path the runtime actually uses", () => {
		expect(SOURCE).toMatch(/case "shell\.created"[\s\S]{0,600}metadata\?\.sessionID/)
	})

	test("FIX: both injection paths are gated, not just the stall watchdog", () => {
		// The proactive nudge fires on session.idle, long before the watchdog
		// would look, so gating only the watchdog would not prevent the nag.
		const gate = /openShellCount\(sid\)[^\n]*\n\s*if \(busyShells > 0\)/
		const all = SOURCE.match(new RegExp(gate, "g")) ?? []
		expect(all.length).toBe(2)
		// ...one in the targeted-nudge guard chain, one in the stall watchdog.
		const targeted = SOURCE.indexOf("async function targetedRecovery")
		const watchdog = SOURCE.indexOf("async function checkActiveSessions")
		expect(targeted).toBeGreaterThan(-1)
		expect(watchdog).toBeGreaterThan(targeted)
		const targetedBody = SOURCE.slice(targeted, watchdog)
		expect(targetedBody).toMatch(/openShellCount\(sid\)/)
	})

	test("FIX: a dropped exit event cannot suppress recovery forever", () => {
		expect(SOURCE).toMatch(/SHELL_OPEN_MAX_MS/)
		expect(SOURCE).toMatch(/now - s\.startedAt > SHELL_OPEN_MAX_MS/)
	})

	test("FIX: cleanup cannot delete the watch state of a session running a shell", () => {
		const start = SOURCE.indexOf("function cleanupIdleSessions")
		expect(start).toBeGreaterThan(-1)
		const end = SOURCE.indexOf("function ", start + 10)
		const body = SOURCE.slice(start, end > start ? end : start + 2000)
		expect(body).toMatch(/openShellCount\(sid\) > 0\) continue/)
	})

	test("FIX: every sessions.delete drops that session's shell entries", () => {
		const deletes = [...SOURCE.matchAll(/^\s*sessions\.delete\(sid\)$/gm)]
		expect(deletes.length).toBeGreaterThan(0)
		for (const d of deletes) {
			const before = SOURCE.slice(Math.max(0, d.index! - 120), d.index!)
			expect(before).toMatch(/forgetShells\(sid\)/)
		}
	})
})
