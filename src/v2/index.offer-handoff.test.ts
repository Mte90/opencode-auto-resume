import { describe, test, expect } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "IndexOfferHandoffTest"

/**
 * v2: offer-shaped turns are hand-offs on the busy path too.
 *
 * ses_ed9e2ef9 (2026-10-10): "I can delete all the stopped containers on
 * docknas if you want me to, just let me know." A nudge landing behind an
 * offer reads as approval, and the model may execute a destructive action
 * the user never approved. The idle path already skips hand-offs; the
 * busy-stall watchdog judged only event silence, so a quiet-busy offer
 * still fired. Now the busy path reads the history tail past the silence
 * gate and stands down on hand-off text (without latching: no completion
 * claimed, and the next turn re-arms by clearing).
 *
 * Deliberate boundary: a bare capability statement with no ask ("I can
 * delete all the stopped containers.") is NOT a hand-off — ambiguous, and
 * the scoped continue text is what protects those. The CONTROL pins that.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 9700

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

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: sid, ...data } })

const OPTIONS = {
	chunkTimeoutMs: 300,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	maxRetries: 3,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
}

async function setup(text: string): Promise<any> {
	const injected: Array<{ sid?: string; text?: string }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-${LOG_SALT}-offer-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			// Prod shape: role, not type.
			context: async () => [
				{
					role: "assistant",
					id: "msg_a",
					time: { created: Date.now() - 60_000 },
					content: [{ type: "text", text }],
				},
			],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
				message: { list: async () => [] },
			},
		},
		storage: {
			get: async () => ({ todos: [] }),
			set: async () => {},
			remove: async () => {},
		},
		tool: {
			transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }),
			list: async () => [],
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, cleanup, logFile, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	rmSync(h.logFile, { force: true })
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function quietBusy(text: string) {
	const h = await setup(text)
	push(h, "session.execution.started", SID)
	await wait(1200)
	const n = h.injected.filter((i: any) => i.sid === SID).length
	await teardown(h)
	return n
}

describe("v2: offer-shaped turns stand down the busy stall", () => {
	test("reported case stays quiet", async () => {
		expect(
			await quietBusy("I can delete all the stopped containers on docknas if you want me to, just let me know."),
		).toBe(0)
	})

	test("say-the-word stays quiet", async () => {
		expect(await quietBusy("Say the word and I'll delete them.")).toBe(0)
	})

	test("go-ahead stays quiet", async () => {
		expect(await quietBusy("Give the go-ahead and I'll proceed.")).toBe(0)
	})

	test("if-you-like stays quiet", async () => {
		expect(await quietBusy("Happy to remove them if you'd like.")).toBe(0)
	})

	test("CONTROL: bare capability with no ask still recovers", async () => {
		expect(await quietBusy("I can delete all the stopped containers.")).toBeGreaterThan(0)
	})
})
