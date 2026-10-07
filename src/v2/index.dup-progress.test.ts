import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: silent tool completions defeat the exact-duplicate skip.
 *
 * The in-memory skip promises "identical text and zero model progress" but
 * measured only assistant-text growth plus in-flight tools: a tool that
 * RAN SILENTLY (completed, no text) left no trace, so the second identical
 * prod was suppressed and the only recovery never fired. Tool completions
 * (success/failed) and shell exits since the last prod now count as
 * progress — the skip requires all three quiet.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 10000

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

async function setup(extraEvents: Array<{ at: number; event: any }>, waitMs: number): Promise<any> {
	const injected: Array<{ text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-dupprog-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 50,
			gracePeriodMs: 0,
			checkIntervalMs: 20,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 12,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
			continuePrompt: "go",
			logFile,
			debug: false,
		},
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
				message: { list: async () => [] },
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	const started = Date.now()
	let extraIdx = 0
	stream.push(ev("session.execution.started"))
	await wait(10)
	while (Date.now() - started < waitMs) {
		while (extraIdx < extraEvents.length && Date.now() - started >= extraEvents[extraIdx].at) {
			stream.push(extraEvents[extraIdx].event)
			extraIdx++
		}
		await wait(10)
	}
	await wait(50)
	;(cleanup as (() => void) | undefined)?.()
	rmSync(logFile, { force: true })
	return { injected }
}

describe("v2: silent tool completions defeat the exact-duplicate skip", () => {
	test("a tool that ran silently between prods re-arms the stall prod", async () => {
		// Attempt 1 sends "go". A tool COMPLETES with no text — modelled as
		// success-without-called (the start predates plugin load, so no
		// in-flight window ever opens and the duplicate check is the only
		// thing standing between the next stall and its prod). Pre-fix the
		// next identical prod was suppressed as no-progress and recovery
		// died after one shot; post-fix the completion counts as progress.
		const { injected } = await setup(
			[{ at: 300, event: ev("session.tool.success", { tool: "read", id: "c1" }) }],
			900,
		)
		expect(injected.length).toBeGreaterThanOrEqual(2)
		expect(injected.every((i: any) => i.text === "go")).toBe(true)
	})

	test("CONTROL: no intervening work stays suppressed", async () => {
		// Nothing happens between attempts: identical text, zero progress —
		// exactly one prod, as before.
		const { injected } = await setup([], 900)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toBe("go")
	})
})
