import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: the `shell` tool is annotated with its v1 name.
 *
 * The unknown-tool suggester has been correcting this for 20 logged events and
 * the correction works — every one reported exactly "called 2x", so the model
 * stops after being told. But the tax is per request: one wasted call every time
 * the model invents `bash`, indefinitely.
 *
 * A plugin cannot fix that by rewriting the call. Read from the shipped
 * `@opencode/plugin` types: `ToolEditor` exposes list/get/namespace/add/update/
 * remove, `update` mutates a tool's Info and never its id, `tool.execute.before`
 * types `tool` as readonly, and there is no message-level hook that rewrites an
 * emitted call. opencode ships no bash alias either. So these tests pin the one
 * move the API does allow — annotate the real tool so the model stops inventing
 * the name — plus the three cases where it must NOT fire.
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

/** Build a tool editor over a fixed registry, recording every update(). */
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
	return { editor, updates }
}

async function setup(tools: Registered[] | null, opts: { toolRegistry?: false } = {}): Promise<any> {
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-alias-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })
	const { editor, updates } = tools ? makeEditor(tools) : { editor: null, updates: [] as never[] }

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
		// In v1 `bash` IS the tool. Renaming the hint the other way would be wrong,
		// and this plugin also ships a v1 build.
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

	test("the hint is not doubled when the transform runs again", async () => {
		// Reloads re-run the transform. Run the same registry through a second
		// setup and assert the description still carries exactly one hint.
		const tools: Registered[] = [{ id: "shell", description: "Run a shell command." }]
		const first = await setup(tools)
		expect(first.updates).toHaveLength(1)
		await teardown(first)
		// Second setup, same registry object — the hint is already present.
		const second = await setup(tools)
		expect(second.updates).toHaveLength(0)
		// Same substring the plugin guards on — asserted here so the two cannot
		// drift apart, which is exactly the bug this test was written after.
		expect(tools[0].description.match(/was called `bash`/g)).toHaveLength(1)
		await teardown(second)
	})
})