import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * Behavioural coverage for the STALL WATCHDOG's shell guard.
 *
 * Why this file exists (audit of ses_ed726872, 2026-10-11):
 *
 * `index.open-shell.test.ts` behaviourally covers the shell guard on the IDLE
 * nudge path (targetedRecovery) — `shell open -> no injection`, `two shells
 * open, one exits`, `shell.deleted cannot close an open shell` — all asserting
 * on `injected`. The STALL watchdog path (checkActiveSessions, the `openShellCount`
 * at the busy-stall decision) had NO behavioural coverage; it was covered only
 * by source-text regexes:
 *
 *     expect(body).toMatch(/openShellCount\(sid\) > 0\) continue\)/)
 *
 * That proves the guard is SPELLED correctly, never that it ENGAGES. Production
 * on 2026-10-11 19:00-19:07 showed both outcomes inside one window on one
 * session running a 400s `bun test`:
 *
 *     …2yItTZB1 silent with 1 shell(s) still running — waiting      (guard held)
 *     …2yItTZB1 stall detected (no activity for 197s) — resume 1/3  (guard lost)
 *
 * These tests drive the watchdog directly, so a regression in that branch fails
 * a behavioural assertion instead of passing a regex.
 */
const LOG_SALT = "IndexStallShellGuard"
const SID = "ses_parent"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
setDefaultTimeout(30_000)

let counter = 77_000

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
const shellCreated = (id: string) => ({
	type: "shell.created",
	data: { info: { id, command: "bun test", status: "running", metadata: { sessionID: SID } } },
})
const shellExited = (id: string) => ({ type: "shell.exited", data: { id, status: "exited", exit: 0 } })

const userMessage = (at: number) => ({ type: "user", id: "msg_u", time: { created: at }, content: [{ type: "text", text: "run the suite" }] })

type SetupOpts = { chunkTimeoutMs?: number; checkIntervalMs?: number; history?: unknown[]; activeUserWindowMs?: number }

const assistantWithTool = (name: string, status: string, at: number, id = `call_${at}`) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [
		{ type: "text", text: "working on it" },
		{ type: "tool", id, name, time: { created: at }, state: { status, input: {} } },
	],
})

async function setup(opts: SetupOpts = {}): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// A SHORT stall window so the watchdog crosses it inside the test budget.
	// This is the production shape: a busy session, a long shell, and a stall
	// window the watchdog reaches while the shell is still alive.
	const ctx: any = {
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: opts.chunkTimeoutMs ?? 60,
			checkIntervalMs: opts.checkIntervalMs ?? 20,
			activeUserWindowMs: opts.activeUserWindowMs ?? 5 * 60_000,
			gracePeriodMs: 0,
			warmupMs: 0,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			logFile,
			debug: true,
		},
		session: {
			context: async () => opts.history ?? [userMessage(Date.now() - 600_000)],
			active: async () => ({}),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, interrupted, streamRef: stream, logFile, cleanup }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const logs = (h: any) => (existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : "")

const assistantWith = (at: number, text: string) => ({
	type: "assistant",
	id: `msg_a_${at}`,
	time: { created: at },
	content: [{ type: "text", text }],
})

describe("v2: the STALL WATCHDOG defers while a shell is running", () => {
	test("CONTROL: a busy session with no shell DOES get the stall recovery", async () => {
		// Without this, a green run proves nothing: if the watchdog never fires
		// in this harness, every test below would pass vacuously.
		const h = await setup()
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
	})

	test("the same session does NOT get stalled while a shell is open", async () => {
		// The exact production shape: busy, a long shell running, and the stall
		// window crossed underneath it. Issue 4 saw this escalate.
		const h = await setup()
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(10)
		h.streamRef.push(shellCreated("sh_long_1"))
		await wait(1600)
		await teardown(h)
		expect(h.injected).toEqual([])
	})

	test("once the shell exits, the stall may fire again", async () => {
		const h = await setup()
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(10)
		h.streamRef.push(shellCreated("sh_long_2"))
		await wait(200)
		h.streamRef.push(shellExited("sh_long_2"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
	})
})

/**
 * The history half of the same guard.
 *
 * `openShells` and `inflightTools` are per-instance event derivations. A plugin
 * reload — or any missed event — empties them while work is still running, and
 * the stall ladder then fires on a live session. Observed 2026-10-11: sixteen
 * consecutive `silent with 1 shell(s) still running` deferrals on a live
 * `bun test`, then a reload adopted the watch without the shell registry and
 * the ladder fired `stall detected (no activity for 186s)`.
 *
 * Message history survives reloads, so an unfinished tool part there is the
 * durable form of the same signal. These tests push NO shell/tool events at
 * all — simulating the reload having wiped the event-derived state — and assert
 * on what history alone can prove.
 */
describe("v2: the STALL WATCHDOG defers on unfinished work in history", () => {
	test("a young unfinished tool part suppresses the stall with no events at all", async () => {
		// The reload-loss shape: no shell.created, no tool.called ever arrived,
		// but history shows a running call from the current turn.
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWithTool("shell", "running", now)],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected).toEqual([])
	})

	test("a completed tool part does not suppress the stall", async () => {
		// Without this, a green run above proves nothing about the history read:
		// if history were never consulted, both would pass vacuously.
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWithTool("shell", "completed", now)],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
	})

	test("an OLD unfinished part does not suppress the stall (stuck-tool owns it)", async () => {
		// The age gate matters: a part older than the stuck-tool window belongs
		// to the stuck-tool pass, which already nudged the model to proceed
		// without it. Letting the stall answer there is the designed backstop.
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWithTool("shell", "running", now - 120_000)],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
	})

	test("an exempt tool inside its stale TTL suppresses the stall", async () => {
		// compress is exempt by default with a 30-minute stale TTL: a long
		// compression past the 60s stuck gate is still work, not wedged.
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWithTool("compress", "running", now - 120_000)],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected).toEqual([])
	})
})

/**
 * The busy stall ladder must latch a completion claim instead of firing on it.
 *
 * ses_ed33c0da5ffe2ENcPETjG4aTuo, 2026-10-11: a scheduled check ended with an
 * explicit "TASK COMPLETE", and the ladder fired resume attempts 2/3 and 3/3
 * plus an abort+resume escalation on the completed turn. The idle path had
 * stood down on recent activity without latching, and the busy path — which
 * DOES check turnEndsWithCompletionClaim — missed it too, with no latch line
 * anywhere in the log.
 *
 * These tests drive the busy path with the production tail shape and assert
 * the LATCH (log line), not merely the absence of an injection — absence alone
 * would pass vacuously via the hand-off skip or any other early return.
 */
/**
 * The busy stall ladder must latch a completion claim instead of firing on it.
 *
 * ses_ed33c0da5ffe2ENcPETjG4aTuo, 2026-10-11: a scheduled check ended with an
 * explicit "TASK COMPLETE", and the ladder fired resume attempts 2/3 and 3/3
 * plus an abort+resume escalation on the completed turn. The idle path had
 * stood down on recent activity without latching. The busy path — which DOES
 * check turnEndsWithCompletionClaim — never logged a latch, a hand-off skip,
 * or a nudge for that session either. The histText block was skipped silently,
 * which happens exactly when the completion text is unreadable at evaluation
 * time (empty history read). Nothing was recorded anywhere, so the ladder
 * fired on a finished turn.
 *
 * The first test below documents that the busy path latches when it CAN read
 * the claim (predicates work — that was never the defect). The second drives
 * the production sequence: readable at idle, unreadable by stall time. Only
 * an idle-set latch survives that; the busy path alone cannot. Both assert the
 * LATCH (log line), not merely absence — absence alone passes vacuously.
 */
describe("v2: the busy stall ladder latches completion claims", () => {
	// Faithful tail of the production message: prose, then the claim. What
	// matters is the ending shape the end-anchored patterns judge.
	const doneTail = (claim: string) =>
		[
			"Per the no-action branch:",
			"- Logged one line to the findings file",
			"- Schedule kept; the check will run again tomorrow",
			"- If action is taken before then: the pre-approved resubmit, schedule deletion, log, and notify",
			"",
			"All todos are done; findings file and todo list are in sync.",
			"",
			claim,
			"",
		].join("\n")

	test("a turn ending in TASK COMPLETE latches instead of stalling", async () => {
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWith(now - 300_000, doneTail("TASK COMPLETE"))],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		const said = logs(h)
		await teardown(h)
		expect(h.injected).toEqual([])
		expect(said).toContain("latching completion")
	})

	test("a completion latched at idle survives an unreadable history at stall time", async () => {
		// The production sequence: the claim was readable at the idle
		// evaluation and unreadable when the busy watchdog evaluated (~3 min
		// later). Emptying history here simulates exactly that observed
		// condition — it is not rigging, it is what the log shows (no latch
		// line, no hand-off line, no nudge: the histText block skipped
		// silently). Only an idle-set latch survives it.
		const now = Date.now()
		const history: unknown[] = [
			userMessage(now - 2000),
			assistantWith(now - 1000, doneTail("TASK COMPLETE")),
		]
		const h = await setup({ history, chunkTimeoutMs: 60, activeUserWindowMs: 120_000 })
		// idle evaluation with fresh activity: stand down (+ latch post-fix).
		// The 121s deferred re-check cannot intervene in this window.
		for (const e of ["session.execution.started", "session.step.started", "session.step.ended", "session.idle"]) {
			h.streamRef.push(ev(e))
			await wait(10)
		}
		await wait(400)
		// By stall time the completion text is unreadable.
		history.length = 0
		// Busy again with no new user input; the 60ms stall window passes long
		// before the deferred re-check could run.
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(10)
		await wait(1600)
		const said = logs(h)
		await teardown(h)
		expect(h.injected).toEqual([])
		expect(said).toContain("latching completion")
	})

	test("CONTROL: the same shape without the claim still stalls", async () => {
		// Without this, a green run above proves nothing: a harness in which
		// the ladder never fires would pass the latch test vacuously.
		const now = Date.now()
		const h = await setup({
			history: [
				userMessage(now - 600_000),
				assistantWith(now - 300_000, doneTail("Still working on it.")),
			],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
	})
})

/**
 * REVERTED 2026-10-11: the stall timer briefly delegated to the stuck prompt
 * ("proceed without it") when history showed an old unfinished tool (a08b674).
 * Reverted same day: age cannot distinguish a wedged call from a legitimately
 * long one. It fired twice on a live 437s `bun test` shell — a working call
 * older than the 60s gate — and told the user to abandon work that was still
 * running, asserting "the turn went idle" while the session was busy. The
 * correct discriminator is completion state (tool.execute.before/after callID,
 * Context.progress), which the plugin does not yet track; until it does, the
 * stall sends the generic continue and the stuck pass stays idle-path-owned.
 * The CONTROL below pins the surviving behavior.
 */
describe("v2: a stalled turn parked on a wedged tool gets the stuck prompt", () => {
	test("CONTROL: no unfinished tool -> generic stall text", async () => {
		// Without this, the test above could pass by the stall never firing at
		// all and some other path injecting. This proves the generic path is
		// intact when there is nothing stuck to delegate to.
		const now = Date.now()
		const h = await setup({
			history: [userMessage(now - 600_000), assistantWith(now - 300_000, "still working")],
		})
		h.streamRef.push(ev("session.execution.started"))
		await wait(10)
		h.streamRef.push(ev("session.step.started"))
		await wait(1600)
		await teardown(h)
		expect(h.injected.length).toBeGreaterThan(0)
		expect(h.injected[0]?.text ?? "").toMatch(/stalled \(attempt/)
	})
})