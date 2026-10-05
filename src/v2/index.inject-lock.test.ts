import { describe, test, expect } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_lock"
let counter = 0

/**
 * A private log file. Without `logFile` the plugin writes to its DEFAULT path,
 * which is the LIVE server's log — test sessions then show up interleaved with
 * real ones and the live log stops being usable as forensics.
 */
function privateLog(tag: string): string {
	const f = join(tmpdir(), `auto-resume-${tag}-${process.pid}-${counter++}.log`)
	rmSync(f, { force: true })
	return f
}

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

const FAST = {
	chunkTimeoutMs: 50,
	gracePeriodMs: 0,
	checkIntervalMs: 20,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	loopMaxContinues: 99,
	injectIntervalMs: 0,
	visibleContinue: true,
}

/**
 * A ctx whose `session.prompt` takes `slowMs` to resolve. Every caller that has
 * passed its guards is then sitting in that await at the same time, which is
 * exactly the window the mutex has to close.
 */
async function run(slowMs: number) {
	const injected: any[] = []
	const stream = makeEventStream()
	const logFile = privateLog("lock")
	const ctx: any = {
		event: stream,
		options: { ...FAST, maxRetries: 1, debug: true, logFile },
		session: {
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ kind: "synthetic", text: a?.text }), {}),
			prompt: async (a: any) => {
				// Record the send FIRST, then stall: the send is what must not repeat.
				injected.push({ kind: "prompt", text: a?.text })
				await wait(slowMs)
				return {}
			},
		},
		client: {
			session: { get: async () => ({ data: {} }), message: { list: async () => ({ data: [], cursor: null }) } },
		},
		storage: { get: async () => ({ todos: [], updatedAt: Date.now() }), set: async () => {}, remove: async () => {} },
	}
	const cleanup = await (plugin as any).setup(ctx)
	stream.push(ev("session.execution.started"))
	await wait(800)
	;(cleanup as (() => void) | undefined)?.()
	rmSync(logFile, { force: true })
	return injected
}

describe("v2: injectOnce is serialized per session", () => {
	test("CONTROL: one stalled turn still injects exactly once", async () => {
		expect((await run(0)).length).toBe(1)
	}, 20_000)

	// Same-ms volleys survived the cross-instance log check because it is
	// check-then-act: `recentOwnProdInLog` read the log, then awaited, then sent.
	// Six interleaved callers all read the same empty log. The mutex closes that
	// window — it is why the duplicate guard alone was not enough.
	test("a SLOW send must not let a concurrent caller through", async () => {
		expect((await run(250)).length).toBe(1)
	}, 25_000)

	test("structural: the mutex wraps injectOnce, and is per-session keyed", () => {
		expect(SOURCE).toContain("const injectLocks = new Map<string, Promise<void>>()")
		// injectOnce must be a thin wrapper that takes the lock; the body must not.
		expect(SOURCE).toContain("return withInjectLock(sid, () =>")
		expect(SOURCE).toContain("async function injectOnceLocked(")
		// The lock must be released in a finally, or one failed send wedges the session.
		expect(SOURCE).toMatch(/finally \{[\s\S]{0,200}release\(\)/)
	})
})