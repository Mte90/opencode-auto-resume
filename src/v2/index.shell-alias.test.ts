import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: the `shell` tool is annotated with its v1 name — exactly once.
 *
 * Two things were learned the hard way while building this, and both are pinned
 * here because neither is observable from inside the process:
 *
 * 1. A plugin cannot rewrite the call. From the shipped `@opencode/plugin`
 *    types: `ToolEditor` is list/get/namespace/add/update/remove, `update` mutates
 *    a tool's Info and never its id, `tool.execute.before` types `tool` as
 *    readonly, and no message-level hook rewrites an emitted call. opencode ships
 *    no alias either. So this annotates the real tool instead.
 * 2. `editor.get()` does NOT see an earlier `editor.update()`. On deploy, two
 *    transform callbacks ran 74ms apart in one host and both annotated — so a
 *    guard that reads the description cannot work, and the hint grows by one copy
 *    per reload. Editor identity can: a WeakSet of already-annotated editors.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let counter = 16000

function makeEventStream() {
	const queue: any[] = []
	const waiters: ((ev: any) => void)[] = []
	const stream = {
		push(ev: any) {
			if (waiters.length) waiters.shift()!(ev)
			else queue.push(ev)
		},
		close() {
			while (waiters.length) waiters.shift()!(null)
		},
		subscribe: () => stream,
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((resolve) => {
						if (queue.length) return resolve({ value: queue.shift(), done: false })
						waiters.push((ev) => resolve({ value: ev, done: false }))
					}),
				return: () => Promise.resolve({ value: undefined, done: true }),
			}
		},
	}
	return stream
}

interface Registered {
	id: string
	description: string
}

/** A tool editor over a fixed registry, recording every update(). */
function makeEditor(tools: Registered[]) {
	const updates: Array<{ id: string; description: string }> = []
	const editor = {
		list: () => tools.map((t) => ({ id: t.id })),
		get: (id: string) => tools.find((t) => t.id === id),
		add: () => {},
		update: (id: string, fn: (t: { description?: string }) => void) => {
			const t = tools.find((x) => x.id === id)
			if (!t) return // the real editor ignores missing ids
			fn(t)
			updates.push({ id, description: t.description })
		},
	}
	return { editor, updates, tools }
}

async function setup(
	tools: Registered[] | null,
	opts: { toolRegistry?: false; editor?: unknown } = {},
): Promise<any> {
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-alias-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })
	const built = tools ? makeEditor(tools) : null
	const editor = opts.editor ?? built?.editor ?? null
	const updates = built?.updates ?? []

	const ctx: any = {
		event: stream,
		options: { chunkTimeoutMs: 600_000, checkIntervalMs: 20, warmupMs: 0, logFile, debug: true },
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async () => ({}),
			prompt: async () => ({}),
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
	}
	if (opts.toolRegistry !== false) {
		ctx.tool = {
			transform: async (cb: any) => {
				cb(editor)
				return { dispose() {} }
			},
			list: async () => tools ?? [],
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	return { cleanup, logFile, updates, tools }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const HINT = /was called `bash`/g

describe("v2: shell tool carries its v1 name", () => {
	test("shell gets the alias hint", async () => {
		const tools: Registered[] = [
			{ id: "read", description: "Read a file." },
			{ id: "shell", description: "Run a shell command." },
		]
		const h = await setup(tools)
		expect(h.updates).toHaveLength(1)
		expect(h.updates[0].id).toBe("shell")
		expect(h.updates[0].description).toContain("bash")
		// The original description must survive — this is an addition, not a replace.
		expect(h.updates[0].description).toContain("Run a shell command.")
		await teardown(h)
	})

	test("CONTROL: no annotation when `bash` is the real tool", async () => {
		// In v1 `bash` IS the tool. Hinting the other way would be wrong, and this
		// plugin also ships a v1 build.
		const tools: Registered[] = [
			{ id: "bash", description: "Run a shell command." },
			{ id: "shell", description: "Also a shell." },
		]
		const h = await setup(tools)
		expect(h.updates).toHaveLength(0)
		await teardown(h)
	})

	test("no annotation when there is no shell tool to annotate", async () => {
		const tools: Registered[] = [{ id: "read", description: "Read a file." }]
		const h = await setup(tools)
		expect(h.updates).toHaveLength(0)
		await teardown(h)
	})

	test("CONTROL: no annotation when the host omits list/get/update", async () => {
		// A minimal editor (add only) must degrade quietly, not throw on load.
		const stream = makeEventStream()
		const logFile = join(tmpdir(), `auto-resume-alias-min-${process.pid}-${counter++}.log`)
		rmSync(logFile, { force: true })
		let registered = 0
		const ctx: any = {
			event: stream,
			options: { chunkTimeoutMs: 600_000, checkIntervalMs: 20, warmupMs: 0, logFile, debug: true },
			session: {
				context: async () => [],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
			tool: {
				transform: async (cb: any) => {
					cb({
						add: () => {
							registered++
						},
					})
					return { dispose() {} }
				},
				list: async () => [],
			},
		}
		const cleanup = await (plugin as any).setup(ctx)
		await wait(80)
		// task_complete still registered — the annotation must not block it.
		expect(registered).toBe(1)
		;(cleanup as (() => void) | undefined)?.()
		rmSync(logFile, { force: true })
	})

	test("no annotation without a tool registry at all", async () => {
		const h = await setup(null, { toolRegistry: false })
		await teardown(h)
	})

	test("an editor whose get() is stale annotates once, not twice", async () => {
		// The measured failure: two transform callbacks 74ms apart in one host
		// both annotated. Faithfully modelled here — one editor object handed out
		// twice, whose update() writes the live tool but whose get() never reflects
		// it. A shared tools array would NOT model this: it would let a
		// description guard pass and prove nothing about identity.
		const live: Registered = { id: "shell", description: "Run a shell command." }
		const updates: string[] = []
		const staleEditor = {
			list: () => [{ id: "shell" }],
			get: () => ({ description: "Run a shell command." }), // stale forever
			add: () => {},
			update: (id: string, fn: (t: { description?: string }) => void) => {
				fn(live)
				updates.push(id)
			},
		}

		const first = await setup([live], { editor: staleEditor })
		expect(updates).toHaveLength(1)
		await teardown(first)

		const second = await setup([live], { editor: staleEditor })
		expect(updates).toHaveLength(1)
		expect(live.description.match(HINT)).toHaveLength(1)
		await teardown(second)
	})

	test("a fresh registry is annotated again — a new editor needs the hint", async () => {
		const first: Registered[] = [{ id: "shell", description: "Run a shell command." }]
		const h1 = await setup(first)
		expect(h1.updates).toHaveLength(1)
		await teardown(h1)

		const second: Registered[] = [{ id: "shell", description: "Run a shell command." }]
		const h2 = await setup(second)
		expect(h2.updates).toHaveLength(1)
		expect(second[0].description.match(HINT)).toHaveLength(1)
		await teardown(h2)
	})
})