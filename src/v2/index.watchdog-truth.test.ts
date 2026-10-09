import { describe, test, expect } from "bun:test"
import { rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: the watchdog sees server-reported running sessions, not just ones it
 * observed events for.
 *
 * ses_edf403f5 (2026-10-09): running server-side 7+ minutes with two user
 * messages unanswered while the watchdog saw nothing. Production has no
 * `ctx.session.active` (verified 2026-10-06), so `getActiveSessions()` fell
 * back to the event-derived busy set — empty for any session that went quiet
 * across a reload — and the stall path never fired. The HTTP loopback
 * (`/api/session/active`, same auth as subagent discovery) restores server
 * truth; any failure still falls open to the event-derived set.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 19000

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

async function setup(): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-watchtruth-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	// Prod shape: NO session.active, NO client. The only server truth available
	// is the HTTP loopback (stubbed fetch here).
	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 50,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 3,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			logFile,
			debug: true,
		},
		session: {
			context: async () => [],
			active: undefined,
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const attemptOf = (text: string | undefined): string | null => {
	const m = /attempt (\d)\/3/.exec(text ?? "")
	return m ? m[1] : null
}

describe("v2: watchdog adopts server-reported running sessions", () => {
	test("a session the server reports running gets a stall nudge with zero events", async () => {
		const realFetch = globalThis.fetch
		const realPort = process.env.OPENCODE_SERVER_PORT
		process.env.OPENCODE_SERVER_PORT = "1"
		;(globalThis as any).fetch = async (url: unknown) => {
			if (String(url).includes("/api/session/active")) {
				return { ok: true, json: async () => ({ data: { [SID]: { type: "running" } } }) }
			}
			return { ok: false, json: async () => ({}) }
		}
		try {
			const h = await setup()
			// No events pushed at all: post-reload silence. Server truth alone
			// must adopt the session, mark it busy, and stall it.
			await wait(500)
			const attempts = h.injected.map((i: any) => attemptOf(i.text))
			await teardown(h)
			expect(h.injected.length).toBeGreaterThanOrEqual(1)
			expect(attempts[0]).toBe("1")
		} finally {
			;(globalThis as any).fetch = realFetch
			if (realPort === undefined) delete process.env.OPENCODE_SERVER_PORT
			else process.env.OPENCODE_SERVER_PORT = realPort
		}
	})

	test("CONTROL: unreachable server fails open to event flags (no adoption, no crash)", async () => {
		const realFetch = globalThis.fetch
		const realPort = process.env.OPENCODE_SERVER_PORT
		process.env.OPENCODE_SERVER_PORT = "1"
		;(globalThis as any).fetch = async () => {
			throw new Error("no server")
		}
		try {
			const h = await setup()
			await wait(400)
			const n = h.injected.length
			await teardown(h)
			expect(n).toBe(0)
		} finally {
			;(globalThis as any).fetch = realFetch
			if (realPort === undefined) delete process.env.OPENCODE_SERVER_PORT
			else process.env.OPENCODE_SERVER_PORT = realPort
		}
	})
})
