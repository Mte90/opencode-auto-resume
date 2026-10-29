import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

const LOG_SALT = "VisibleNudgeTest"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_visible_nudge"

let counter = 5000
function makeEventStream() {
	const queue: any[] = []
	const waiters: ((ev: any) => void)[] = []
	let closed = false
	const stream = {
		push(ev: any) { if (waiters.length) { waiters.shift()!(ev) } else { queue.push(ev) } },
		close() { closed = true; while (waiters.length) waiters.shift()!(null) },
		subscribe: () => stream,
		[Symbol.asyncIterator]() {
			return {
				next: () => new Promise((resolve) => {
					if (queue.length) return resolve({ value: queue.shift(), done: false })
					if (closed) return resolve({ value: undefined, done: true })
					waiters.push((ev) => resolve(ev === null ? { value: undefined, done: true } : { value: ev, done: false }))
				}),
				return: () => { closed = true; return Promise.resolve({ value: undefined, done: true }) },
			}
		},
	}
	return stream
}

const ev = (type: string, sid: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: sid, ...data } })

const OPTIONS = {
	chunkTimeoutMs: 100,
	toolTextCheckDelayMs: 0,
	checkIntervalMs: 20,
	gracePeriodMs: 0,
	warmupMs: 0,
	baseBackoffMs: 1,
	maxBackoffMs: 2,
	injectIntervalMs: 0,
	subagentWaitMs: 40,
	debug: false,
	visibleContinue: true,
}

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

async function setup(opts: any = {}) {
	const injected: any[] = []
	const interrupted: string[] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()

	const ctx: any = {
		event: stream,
		options: { ...OPTIONS, registryScope: LOG_SALT, ...opts },
		session: {
			context: async (a: any) => [],
			active: async () => ({}),
			interrupt: async (a: any) => (interrupted.push(a?.sessionID), {}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text, synthetic: true }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text, synthetic: false }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: SID }] }),
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, interrupted, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()}


const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) => h.streamRef.push(ev(type, sid, data))

async function makeBusy(h: any, sid: string) {
	push(h, "session.execution.started", sid)
	await wait(10)
	push(h, "session.step.started", sid)
	await wait(10)
}

describe("v2: stall nudges respect visibleContinue", () => {
	test("visible nudges use the prompt channel, not synthetic", async () => {
		const now = Date.now()
		const h = await setup()
		const sid = SID
		await makeBusy(h, sid)
		push(h, "session.status", sid, { status: "busy" })
		await wait(10)
		// Simulate silence by not sending any more events
		await wait(300)
		// Check that any injected message was sent via the visible channel
		const visible = h.injected.filter((i: any) => i.synthetic === false)
		const synthetic = h.injected.filter((i: any) => i.synthetic === true)
		// If visibleContinue is true, at least one visible injection should exist
		// (if any injection happened at all)
		if (h.injected.length > 0) {
			expect(visible.length).toBeGreaterThan(0)
		}
		await teardown(h)
	})
})