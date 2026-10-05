import { describe, test, expect } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_dupinst"
let counter = 0

/** The real v2 seam: `event.subscribe` returns an async iterable. */
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
 * Boot the plugin `instances` times against ONE host ctx, exactly as the loader
 * does — the live log shows six `ready` lines per server start, all from a
 * single entrypoint and a single server process. Then let ONE stalled turn
 * elapse and report every injection produced.
 */
async function bootStormed(instances: number, opts: Record<string, unknown> = {}): Promise<{ injected: any[]; logs: string[] }> {
	const injected: any[] = []
	const streams = Array.from({ length: instances }, () => makeEventStream())
	let next = 0
	const logFile = join(tmpdir(), `auto-resume-dup-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		// ONE event source shared by every setup: `subscribe` hands out a fresh
		// async iterable per caller, which is what the host does.
		event: {
			subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
				const s = streams[next++] ?? streams[streams.length - 1]
				signal?.addEventListener("abort", () => s.close())
				return s
			},
		},
		options: { ...FAST, ...opts, logFile, debug: true },
		session: {
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ kind: "synthetic", text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ kind: "prompt", text: a?.text }), {}),
		},
		client: {
			session: {
				get: async () => ({ data: {} }),
				message: { list: async () => ({ data: [], cursor: null }) },
			},
		},
		storage: { get: async () => ({ todos: [], updatedAt: Date.now() }), set: async () => {}, remove: async () => {} },
	}

	const cleanups: Array<(() => void) | undefined> = []
	for (let i = 0; i < instances; i++) cleanups.push(await (plugin as any).setup(ctx))

	// ONE turn that starts and then goes silent. Every live instance subscribes to
	// the same host stream, so all of them see it — that fan-out IS the storm.
	streams.forEach((s) => s.push(ev("session.execution.started")))
	await wait(700)
	for (const c of cleanups) (c as (() => void) | undefined)?.()

	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, logs }
}

describe("v2: N live setups must not become N identical injections", () => {
	test("CONTROL: ONE setup on a stalled turn injects exactly once", async () => {
		const { injected } = await bootStormed(1, { maxRetries: 1 })
		expect(injected.length).toBe(1)
	}, 20_000)

	// The storm. setup() re-runs on every config reload; the log shows six `ready`
	// lines with no `stopped` between them. Each setup built a private `sessions`
	// map, so each owned a private resumeAttempts counter: six watchdogs, six
	// "attempt 1/3" lines in the same millisecond, six identical continues with
	// no wait between them.
	test("SIX live setups -> ONE injection, not six", async () => {
		const { injected } = await bootStormed(6, { maxRetries: 1 })
		expect(injected.length).toBe(1)
	}, 25_000)

	// The behavioural test above is the real proof. These two pin the MECHANISM so
	// the fix cannot be undone by a refactor that keeps the symptom away by luck.
	test("MECHANISM: only the LAST ready is left running, and only it stalls", async () => {
		const { logs } = await bootStormed(6, { maxRetries: 1 })
		const ready = logs.filter((l) => l.includes("ready (opencode v2)")).length
		const stopped = logs.filter((l) => l.includes("[auto-resume] stopped")).length
		const stalls = logs.filter((l) => l.includes("stall detected")).length
		// Six setups still each announce themselves (the loader asked for six)...
		expect(ready).toBe(6)
		// ...but five are torn down on arrival, leaving one watchdog.
		expect(stopped).toBeGreaterThanOrEqual(5)
		// One live instance, therefore one counter, therefore one injection.
		expect(stalls).toBe(1)
	}, 25_000)
})