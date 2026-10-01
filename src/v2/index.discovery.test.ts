import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Scratch log path per case, so parallel tests cannot read each other's lines. */
let counter = 0
function scratchLog(): string {
	const p = join(tmpdir(), `auto-resume-discovery-${process.pid}-${counter++}.log`)
	rmSync(p, { force: true })
	return p
}
function readLogs(p: string): string[] {
	const logs = existsSync(p) ? readFileSync(p, "utf8").split("\n") : []
	rmSync(p, { force: true })
	return logs
}

/**
 * Discovery sweep tests.
 *
 * The sweep is what makes a session that was ALREADY running when the plugin
 * loaded visible to the watchdog. Without it, a session that started before
 * attach never emits `session.execution.started` to us, so nothing is marked
 * busy and the stall watchdog has nothing to inspect.
 *
 * Two shapes are exercised, because v2's plugin `session` domain is a narrowed
 * Pick that may or may not carry `list`/`active`:
 *   - onDomain: the methods hang off ctx.session (what this build prefers)
 *   - onClient:  they are absent there and only reachable via ctx.client
 *
 * Every group carries a CONTROL that fails if discovery silently no-ops, which
 * is the failure mode this whole feature has.
 */

type ApiShape = "onDomain" | "onClient" | "neither"

type Harness = {
	logs: string[]
	calls: string[]
	listRows: Array<Record<string, unknown>>
	activeIDs: string[]
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

/** A session already mid-turn at attach time: `list` knows it, `active` says busy. */
const RUNNING = "ses_running_before_attach"

async function run(
	shape: ApiShape,
	opts: Record<string, unknown> = {},
	overrides: { listThrows?: boolean } = {},
): Promise<Harness> {
	const calls: string[] = []
	const stream = makeEventStream()
	const logFile = scratchLog()

	const listRows = [{ id: RUNNING, title: "already running" }]
	const activeIDs = [RUNNING]

	const list = async () => {
		calls.push("list")
		if (overrides.listThrows) throw new Error("list unavailable")
		return listRows
	}
	const active = async () => {
		calls.push("active")
		return Object.fromEntries(activeIDs.map((id) => [id, { type: "running" }]))
	}

	const session: Record<string, unknown> = {
		context: async () => [],
		interrupt: async () => ({}),
		synthetic: async () => ({}),
		prompt: async () => ({}),
	}
	if (shape === "onDomain") {
		session.list = list
		session.active = active
	}

	const client: Record<string, unknown> | undefined =
		shape === "onClient" ? { session: { list, active } } : shape === "onDomain" ? undefined : {}

	const ctx: any = {
		event: stream,
		options: { warmupMs: 0, discoveryDelayMs: 20, logFile, ...opts },
		session,
	}
	if (client) ctx.client = client

	const cleanup = await (plugin as any).setup(ctx)
	await wait(220) // initial sweep is discoveryDelayMs out
	;(cleanup as (() => void) | undefined)?.()
	return { logs: readLogs(logFile), calls, listRows, activeIDs }
}

const discoveryLine = (logs: string[]) => logs.find((l) => l.includes("discovery:"))

describe("v2: session discovery sweep", () => {
	test("CONTROL (list on the session domain): an already-running session is adopted as busy", async () => {
		const { logs, calls } = await run("onDomain")
		expect(calls).toContain("list")
		expect(calls).toContain("active")
		const line = discoveryLine(logs)
		expect(line).toBeDefined()
		expect(line).toContain("adopted 1 already running")
	})

	test("list on the session domain seeds a session the plugin has never seen", async () => {
		const { logs } = await run("onDomain")
		// Seeded and adopted are separate counts; a session that exists but is
		// not running must still be seeded so revert/cleanup know about it.
		expect(discoveryLine(logs)).toContain("seeded 1 session(s)")
	})

	test("CONTROL (list only on ctx.client): the sweep still works via the client fallback", async () => {
		const { logs, calls } = await run("onClient")
		expect(calls).toContain("list")
		expect(discoveryLine(logs)).toContain("adopted 1 already running")
	})

	test("a host exposing neither degrades quietly instead of throwing", async () => {
		// No `list`, no `client`. The sweep must not raise; the plugin falls back
		// to the event-derived busy set, which is what it did before this feature.
		const { logs, calls } = await run("neither")
		expect(calls).toEqual([])
		expect(logs.filter((l) => l.includes("discovery failed"))).toEqual([])
	})

	test("a throwing list() is contained and reported at debug level, not as a crash", async () => {
		const { logs } = await run("onDomain", {}, { listThrows: true })
		expect(logs.filter((l) => l.includes("session discovery failed"))).toEqual([])
		// The sweep still completed — it simply had nothing to adopt.
		expect(logs.filter((l) => l.includes("watchdog failed"))).toEqual([])
	})

	test("rows without a usable id are skipped, not treated as sessions", async () => {
		const logFile = scratchLog()
		const stream = makeEventStream()
		const rows = [{ id: "not-a-session" }, { id: 42 }, {}, null]
		const ctx: any = {
			event: stream,
			options: { warmupMs: 0, discoveryDelayMs: 20, logFile },
			session: {
				context: async () => [],
				active: async () => ({}),
				list: async () => rows,
			},
		}
		const cleanup = await (plugin as any).setup(ctx)
		await wait(220)
		;(cleanup as (() => void) | undefined)?.()
		const logs = readLogs(logFile)
		expect(discoveryLine(logs)).not.toBeDefined()
		expect(logs.filter((l) => l.includes("discovery failed"))).toEqual([])
	})

	test("a { data } envelope is unwrapped, matching the client's response shape", async () => {
		const logFile = scratchLog()
		const stream = makeEventStream()
		const ctx: any = {
			event: stream,
			options: { warmupMs: 0, discoveryDelayMs: 20, logFile },
			session: {
				context: async () => [],
				active: async () => ({ [RUNNING]: { type: "running" } }),
				list: async () => ({ data: [{ id: RUNNING }] }),
			},
		}
		const cleanup = await (plugin as any).setup(ctx)
		await wait(220)
		;(cleanup as (() => void) | undefined)?.()
		expect(discoveryLine(readLogs(logFile))).toContain("adopted 1 already running")
	})

	test("cleanup stops every timer — no API calls after teardown", async () => {
		const calls: string[] = []
		const stream = makeEventStream()
		const logFile = scratchLog()
		const ctx: any = {
			event: stream,
			// Tight watchdog so a leaked interval is visible inside the wait.
			options: { warmupMs: 0, discoveryDelayMs: 20, checkIntervalMs: 20, chunkTimeoutMs: 10_000, logFile },
			session: {
				context: async () => [],
				active: async () => {
					calls.push("active")
					return {}
				},
				list: async () => {
					calls.push("list")
					return [{ id: RUNNING }]
				},
			},
		}
		const cleanup = (await (plugin as any).setup(ctx)) as () => void
		await wait(120)
		// Precondition: the watchdog really is running, so a zero afterwards is
		// the result of teardown rather than of a plugin that never started.
		expect(calls.filter((c) => c === "active").length).toBeGreaterThan(0)

		cleanup()
		const atTeardown = calls.length
		await wait(200)
		expect(calls.length).toBe(atTeardown)
		rmSync(logFile, { force: true })
	})
})