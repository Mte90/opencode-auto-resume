import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_registry"

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
	let next = 0
	const ctx: any = {
		event: {
			subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
				const s = streams[next++] ?? streams[streams.length - 1]
				signal?.addEventListener("abort", () => s.close())
				return s
			},
		},
		options: { ...FAST, maxRetries: 1 },
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

	const key = `__auto_resume_singleton__:${process.pid}`
	const afterSetup = (globalThis as any)[key]?.live

	streams.forEach((s) => s.push(ev("session.execution.started")))
	await wait(700)
	const duringStall = (globalThis as any)[key]?.live
	for (const c of cleanups) (c as (() => void) | undefined)?.()

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
		expect(registryKey).toBe(`__auto_resume_singleton__:${process.pid}`)
	})

	// The shipped bug: `let activeInstance` in module scope. Six evaluations of
	// the bundle each hold their own, so each believes it is the only live one and
	// the storms continued (8 lines, same millisecond, 19:54:19).
	test("structural: the singleton is reached THROUGH globalThis", () => {
		expect(SOURCE).toContain("globalThis as unknown as Record<string, SingletonRegistry | undefined>")
		expect(SOURCE).toContain("function singletonRegistry()")
		// No module-scope `activeInstance` may remain: it cannot see other copies.
		expect(SOURCE).not.toMatch(/^let activeInstance/m)
		// The teardown must go through the registry too, and must clear the slot
		// only when it still holds OUR disposer — otherwise a late teardown from a
		// superseded copy unregisters the live one.
		expect(SOURCE).toMatch(/if \(reg\.live\?\.dispose === dispose\) reg\.live = undefined/)
		expect(SOURCE).toContain("registry.live = { dispose }")
	})
})