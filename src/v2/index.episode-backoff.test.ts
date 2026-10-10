import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

/**
 * v2: consecutive progress-restarted refires back the fuse off.
 *
 * ses_ed975114 (2026-10-10): "progress since last prod — restarting the
 * stall ladder" + "resume attempt 1/3" every ~3.5min, four in a row. Any
 * assistant-text growth or tool/shell success restarts the ladder, so a
 * slow-trickling session reads 1/3 forever and the 3-per-10min loop budget
 * (sliding window) never trips. Each refire without genuine user input now
 * doubles the silence fuse (cap x8); a genuine user message resets it.
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_parent"

let counter = 9800

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
	chunkTimeoutMs: 150,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	maxRetries: 9,
	loopMaxContinues: 99,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
}

const userMsg = (text: string, at: number, id: string) => ({
	// Prod shape: role, not type.
	role: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})
const assistantMsg = (text: string) => ({
	role: "assistant",
	id: "msg_a",
	time: { created: Date.now() - 60_000 },
	content: [{ type: "text", text }],
})
const toolOk = () => ({ type: "session.tool.success", sid: SID, data: { sessionID: SID } })

async function setup(msgs: unknown[]) {
	const injected: Array<{ sid?: string; text?: string; t?: number }> = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-episode-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, logFile },
		session: {
			context: async () => msgs,
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text, t: Date.now() }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text, t: Date.now() }), {}),
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

describe("v2: refire backoff across one episode", () => {
	test("fuse doubles per refire without user input", async () => {
		const msgs: unknown[] = [userMsg("go", Date.now() - 60_000, "msg_u0"), assistantMsg("Working through the list.")]
		const h = await setup(msgs)
		const t0 = Date.now()
		push(h, "session.execution.started", SID)
		// Eight stall cycles, each restarted by one tool success. Early gaps
		// ride the base fuse (~150ms); the episode counter doubles it per
		// refire (300/600/1200, cap x8), so late gaps run several times wider.
		for (let i = 0; i < 8; i++) {
			await wait(60)
			push(h, "session.tool.success", SID)
			await wait(900)
		}
		const times = h.injected.filter((x: any) => x.sid === SID).map((x: any) => x.t as number)
		await teardown(h)
		expect(times.length).toBeGreaterThanOrEqual(6)
		// Base fuse intact on the first fire (~150ms scale).
		expect(times[0] - t0).toBeLessThan(450)
		// Backed-off late gap dwarfs the early one (nominal ~160 vs ~600+).
		const early = times[1] - times[0]
		const late = times[times.length - 1] - times[times.length - 2]
		expect(late).toBeGreaterThan(early * 2)
	}, 30000)

	test("genuine user message resets the fuse to base", async () => {		const msgs: unknown[] = [userMsg("go", Date.now() - 60_000, "msg_u0"), assistantMsg("Working through the list.")]
		const h = await setup(msgs)
		push(h, "session.execution.started", SID)
		await wait(60)
		push(h, "session.tool.success", SID)
		await wait(500)
		push(h, "session.tool.success", SID)
		await wait(700)
		const before = h.injected.filter((x: any) => x.sid === SID).length
		expect(before).toBeGreaterThanOrEqual(2)
		// Forged +35s ahead so the own-prompt time guard (30s) cannot
		// misread it: must register as a genuine takeover, clearing the
		// episode count.
		msgs.push(userMsg("new ask", Date.now() + 35_000, "msg_u9"))
		push(h, "session.idle", SID)
		await wait(200)
		push(h, "session.execution.started", SID)
		push(h, "session.step.started", SID)
		await wait(60)
		push(h, "session.tool.success", SID)
		const t1 = Date.now()
		await wait(900)
		const after = h.injected.filter((x: any) => x.sid === SID && (x.t as number) >= t1)
		await teardown(h)
		// Base fuse again (~150ms), not the backed-off one.
		expect(after.length).toBeGreaterThan(0)
		expect((after[0].t as number) - t1).toBeLessThan(450)
	}, 20000)

	test("every ladder reset is logged (no silent branches)", async () => {
		const msgs: unknown[] = [userMsg("go", Date.now() - 60_000, "msg_u0"), assistantMsg("Working through the list.")]
		const h = await setup(msgs)
		push(h, "session.execution.started", SID)
		await wait(60)
		push(h, "session.tool.success", SID)
		await wait(1200)
		const logs = existsSync(h.logFile) ? readFileSync(h.logFile, "utf8") : ""
		await teardown(h)
		expect(logs).toMatch(/restarting the stall ladder/)
	}, 20000)
})
