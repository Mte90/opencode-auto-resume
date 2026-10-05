import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: visible stall continue (cattleprod-style) + rich prod text +
 * exact-duplicate anti-repeat.
 *
 * Every group carries a control. The harness drives a genuinely stalled busy
 * session (started, then silent) so the watchdog fires `recover()`, and tags
 * each delivery by channel (`synthetic` vs `prompt`) — the distinction the
 * feature exists to make.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_vis"
let counter = 0

const OPEN = [
	{ content: "Write the migration guide", status: "pending", priority: "high" },
	{ content: "Delete the temp fixtures", status: "in_progress", priority: "low" },
]

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

type Harness = {
	injected: Array<{ kind: string; text?: string }>
	logs: string[]
}

/** A turn that starts and then goes silent: a stall candidate. */
const busyStallEvents = [ev("session.execution.started")]

/** Timings small enough that the watchdog fires inside the harness wait. */
const FAST = {
	chunkTimeoutMs: 50,
	gracePeriodMs: 0,
	checkIntervalMs: 20,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	loopMaxContinues: 99,
	injectIntervalMs: 0,
}

async function replay(
	events: any[],
	opts: Record<string, unknown> = {},
	todos: unknown[] | undefined = undefined,
	extraEvents: Array<{ at: number; event: any }> = [],
	waitMs = 600,
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-vis-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...FAST, ...opts, logFile, debug: true },
		session: {
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ kind: "synthetic", text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ kind: "prompt", text: a?.text }), {}),
		},
		client: { session: { get: async () => ({ data: {} }) } },
		storage: {
			get: async () => ({ todos: todos ?? [], updatedAt: Date.now() }),
			set: async () => {},
			remove: async () => {},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	const started = Date.now()
	let extraIdx = 0
	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	// Interleave extra events at wall-clock offsets while the watchdog works.
	while (Date.now() - started < waitMs) {
		while (extraIdx < extraEvents.length && Date.now() - started >= extraEvents[extraIdx].at) {
			stream.push(extraEvents[extraIdx].event)
			extraIdx++
		}
		await wait(10)
	}
	for (; extraIdx < extraEvents.length; extraIdx++) stream.push(extraEvents[extraIdx].event)
	await wait(50)
	;(cleanup as (() => void) | undefined)?.()
	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, logs }
}

describe("v2: stall-continue channel", () => {
	test("CONTROL: default channel is hidden synthetic", async () => {
		const { injected } = await replay(busyStallEvents, { maxRetries: 1 })
		expect(injected.length).toBeGreaterThan(0)
		expect(injected.every((i) => i.kind === "synthetic")).toBe(true)
	})

	test("visibleContinue:true sends a real prompt message instead", async () => {
		const { injected } = await replay(busyStallEvents, { maxRetries: 1, visibleContinue: true })
		expect(injected.length).toBeGreaterThan(0)
		expect(injected.every((i) => i.kind === "prompt")).toBe(true)
	})

	test("AUTO_RESUME_VISIBLE_CONTINUE=1 enables the visible channel", async () => {
		process.env.AUTO_RESUME_VISIBLE_CONTINUE = "1"
		try {
			const { injected } = await replay(busyStallEvents, { maxRetries: 1 })
			expect(injected.length).toBeGreaterThan(0)
			expect(injected.every((i) => i.kind === "prompt")).toBe(true)
		} finally {
			delete process.env.AUTO_RESUME_VISIBLE_CONTINUE
		}
	})
})

describe("v2: rich stall-continue text", () => {
	test("CONTROL: default names the stall and the open todos", async () => {
		const { injected } = await replay(busyStallEvents, { maxRetries: 1 }, OPEN)
		expect(injected.length).toBeGreaterThan(0)
		expect(injected[0].text).toContain("continue — stalled")
		expect(injected[0].text).toContain("no activity for")
		expect(injected[0].text).toContain("Write the migration guide")
		expect(injected[0].text).toContain("Delete the temp fixtures")
	})

	test("richContinuePrompt:false restores bare 'continue'", async () => {
		const { injected } = await replay(busyStallEvents, { maxRetries: 1, richContinuePrompt: false }, OPEN)
		expect(injected.length).toBeGreaterThan(0)
		expect(injected[0].text).toBe("continue")
	})

	test("a custom continuePrompt always wins verbatim", async () => {
		const { injected } = await replay(busyStallEvents, { maxRetries: 1, continuePrompt: "go" }, OPEN)
		expect(injected.length).toBeGreaterThan(0)
		expect(injected[0].text).toBe("go")
	})
})

describe("v2: exact-duplicate anti-repeat", () => {
	test("an identical re-fire with zero progress is suppressed", async () => {
		// Verbatim custom text, so every attempt builds the same string; no
		// assistant text and no tool work ever lands, so attempts 2+ are dupes.
		const { injected, logs } = await replay(busyStallEvents, { maxRetries: 5, continuePrompt: "go" }, [], [], 900)
		expect(injected).toHaveLength(1)
		expect(injected[0].text).toBe("go")
		expect(logs.some((l) => l.includes("duplicate continue suppressed"))).toBe(true)
	})

	test("new model output re-arms it", async () => {
		// Fresh assistant text between windows is progress: the same prod text
		// must go out again instead of being swallowed. Headroom past the
		// progress event matters: attempts burn ~1/70ms, so maxRetries 5 would
		// be spent before the delta lands and the session gives up.
		const { injected } = await replay(
			busyStallEvents,
			{ maxRetries: 10, continuePrompt: "go" },
			[],
			[{ at: 250, event: ev("session.text.delta", { messageID: "msg_a1", delta: "still working" }) }],
			1200,
		)
		expect(injected.length).toBeGreaterThanOrEqual(2)
	})
})
