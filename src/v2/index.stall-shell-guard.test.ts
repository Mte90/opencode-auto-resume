import { describe, test, expect, setDefaultTimeout } from "bun:test"
import { rmSync } from "node:fs"
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

type SetupOpts = { chunkTimeoutMs?: number; checkIntervalMs?: number }

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
			gracePeriodMs: 0,
			warmupMs: 0,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			logFile,
			debug: true,
		},
		session: {
			context: async () => [userMessage(Date.now() - 600_000)],
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