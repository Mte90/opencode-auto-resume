import { describe, test, expect } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexSingletonRegistryTest"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_registry"
let counter = 0

/**
 * A private log file. Without `logFile` the plugin writes to its DEFAULT path,
 * which is the LIVE server's log — test sessions then show up interleaved with
 * real ones and the live log stops being usable as forensics.
 */
function privateLog(tag: string): string {
	const f = join(tmpdir(), `auto-resume-${LOG_SALT}-${tag}-${process.pid}-${counter++}.log`)
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

type Boot = { injected: any[]; registryLive: unknown; registryKey: string }

async function boot(instances: number): Promise<Boot> {
	const injected: any[] = []
	const streams = Array.from({ length: instances }, () => makeEventStream())
	const logFile = privateLog("registry")
	let next = 0
	const ctx: any = {
		event: {
			subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
				const s = streams[next++] ?? streams[streams.length - 1]
				signal?.addEventListener("abort", () => s.close())
				return s
			},
		},
		options: { ...FAST, maxRetries: 1, logFile, registryScope: LOG_SALT },
		session: {
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ kind: "synthetic", text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ kind: "prompt", text: a?.text }), {}),
		},
		client: {
			session: { get: async () => ({ data: {} }), message: { list: async () => ({ data: [], cursor: null }) } },
		},
		storage: { get: async () => ({ todos: [], updatedAt: Date.now() }), set: async () => {}, remove: async () => {} },
	}
	const cleanups: Array<(() => void) | undefined> = []
	for (let i = 0; i < instances; i++) cleanups.push(await (plugin as any).setup(ctx))

	// The harness scopes its instances (see the cross-scope test below), so the
	// slot to inspect is the scoped one. The pid-wide prefix is unchanged —
	// scoping only appends to it.
	const key = `__auto_resume_singleton__:${process.pid}:${LOG_SALT}`
	const afterSetup = (globalThis as any)[key]?.live

	streams.forEach((s) => s.push(ev("session.execution.started")))
	await wait(700)
	const duringStall = (globalThis as any)[key]?.live
	for (const c of cleanups) (c as (() => void) | undefined)?.()
	rmSync(logFile, { force: true })

	return { injected, registryLive: duringStall ?? afterSetup, registryKey: key }
}

describe("v2: the singleton lives on globalThis, so re-evaluations share it", () => {
	test("CONTROL: one setup on a stalled turn injects once", async () => {
		const { injected } = await boot(1)
		expect(injected.length).toBe(1)
	}, 20_000)

	test("six setups in one process -> ONE registry entry, ONE injection", async () => {
		const { injected, registryLive } = await boot(6)
		// The registry must name exactly one live instance...
		expect(registryLive).toBeDefined()
		expect(typeof (registryLive as any).dispose).toBe("function")
		// ...and only that one may inject.
		expect(injected.length).toBe(1)
	}, 25_000)

	test("the registry key is process-scoped, not module-scoped", async () => {
		const { registryKey } = await boot(1)
		// Process-scoped: keyed by pid on globalThis, so every module evaluation
		// in the process finds the same slot. The scope is appended to that
		// prefix, never a substitute for it.
		expect(registryKey).toBe(`__auto_resume_singleton__:${process.pid}:${LOG_SALT}`)
		expect(registryKey.startsWith(`__auto_resume_singleton__:${process.pid}`)).toBe(true)
	})

	// The bug this scopes out (2026-10-11): with a pid-wide key and no scope,
	// `bun test` running all 79 files in ONE process meant file A's setup
	// disposed file B's in-flight instance. B's plugin was dead — event pump
	// aborted, watchdog cleared — so its assertions waited for events nothing
	// would ever deliver again, and each one failed under load while passing
	// alone. Two scopes must therefore keep two independent live instances.
	test("differently scoped instances do NOT dispose each other", async () => {
		const mk = () => makeEventStream()
		const logFile = privateLog("scoped")
		const streams = [mk(), mk()]
		let next = 0
		const makeCtx = (registryScope: string): any => ({
			event: {
				subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
					const s = streams[next++] ?? streams[streams.length - 1]
					signal?.addEventListener("abort", () => s.close())
					return s
				},
			},
			options: { ...FAST, maxRetries: 1, logFile, registryScope },
			session: {
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			client: {
				session: { get: async () => ({ data: {} }), message: { list: async () => ({ data: [], cursor: null }) } },
			},
			storage: { get: async () => ({ todos: [], updatedAt: Date.now() }), set: async () => {}, remove: async () => {} },
		})

		const disposeA = await (plugin as any).setup(makeCtx("scope-a"))
		const disposeB = await (plugin as any).setup(makeCtx("scope-b"))

		// Both slots still hold their own live instance: B did not evict A.
		const g = globalThis as any
		expect(g[`__auto_resume_singleton__:${process.pid}:scope-a`]?.live).toBeDefined()
		expect(g[`__auto_resume_singleton__:${process.pid}:scope-b`]?.live).toBeDefined()

		disposeA()
		// A's teardown must not clear B's slot — different scope, different owner.
		expect(g[`__auto_resume_singleton__:${process.pid}:scope-b`]?.live).toBeDefined()
		disposeB()
		rmSync(logFile, { force: true })
	}, 20_000)

	// The shipped bug: `let activeInstance` in module scope. Six evaluations of
	// the bundle each hold their own, so each believes it is the only live one and
	// the storms continued (8 lines, same millisecond, 19:54:19).
	test("structural: the singleton is reached THROUGH globalThis", () => {
		expect(SOURCE).toContain("globalThis as unknown as Record<string, SingletonRegistry | undefined>")
		// Takes the scope that selects the slot, and reaches globalThis through
		// the scoped key — never module scope. The signature gained its parameter
		// when registryScope landed; what this pins is that the lookup still goes
		// through the process-global object under a key derived from the scope.
		expect(SOURCE).toContain("function singletonRegistry(scope?: string)")
		expect(SOURCE).toContain("const key = registryKeyFor(scope)")
		expect(SOURCE).toContain("let reg = g[key]")
		// No module-scope `activeInstance` may remain: it cannot see other copies.
		expect(SOURCE).not.toMatch(/^let activeInstance/m)
		// The teardown must go through the registry too, and must clear the slot
		// only when it still holds OUR disposer — otherwise a late teardown from a
		// superseded copy unregisters the live one.
		expect(SOURCE).toMatch(/if \(reg\.live\?\.dispose === dispose\) reg\.live = undefined/)
		// The slot is set through the registry, and now carries the identity the
		// reload forensics read (mod + start time) so a superseding instance can
		// name its predecessor instead of merely stepping on it.
		expect(SOURCE).toContain("registry.live = { dispose, mod: MODULE_INSTANCE, startedAt: Date.now() }")
	})
})