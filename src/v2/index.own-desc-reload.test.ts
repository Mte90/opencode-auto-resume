import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/**
 * Behavioral counterpart to index.own-injected.test.ts (fix A, PR #56).
 *
 * The durable-description check (ownByDesc) reads latest.description, and the
 * persisted counter record is the observable: a genuine user turn wipes it
 * (storage.remove of "resume-counters/<sid>"), an own injection must not.
 * Seeding the record and reloading proves the full chain — restore at setup,
 * described injection recognised as own, budget untouched.
 *
 * Regression note: the original merged test asserted a tautology, and the
 * ownByDesc branch was dead code (latest never captured description) until
 * the capture was fixed. This file pins the live behavior.
 */

const LOG_SALT = "IndexOwnDescReloadTest"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeStream() {
	const q: any[] = []
	const ws: ((e: any) => void)[] = []
	const s: any = {
		push(e: any) {
			if (ws.length) ws.shift()!(e)
			else q.push(e)
		},
		subscribe: () => s,
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((res) => {
						if (q.length) return res({ value: q.shift(), done: false })
						ws.push((e) => res({ value: e, done: false }))
					}),
			}
		},
	}
	return s
}

function counterRecord(workRetries: number) {
	return { v: 2, at: Date.now(), workRetries, resumeAttempts: 0, lifetimeContinues: 0, episodeRefires: 0 }
}

async function setup(sid: string, messages: any[]) {
	const stream = makeStream()
	const capture = capturePluginLogs()
	const counterKey = `resume-counters/${sid}`
	const seeded = counterRecord(2)
	const removeCalls: string[] = []
	const injected: string[] = []
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: {
			registryScope: LOG_SALT,
			chunkTimeoutMs: 150,
			toolTextCheckDelayMs: 0,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			baseBackoffMs: 1,
			maxBackoffMs: 2,
			maxRetries: 3,
			injectIntervalMs: 0,
			subagentWaitMs: 40,
			debug: true,
		},
		session: {
			context: async (a: any) => messages,
			active: async () => ({ [sid]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push(String(a?.text ?? "")), {}),
			prompt: async (a: any) => (injected.push(String(a?.text ?? "")), {}),
		},
		client: { session: { get: async () => ({ data: {} }), list: async () => ({ data: [{ id: sid }] }) } },
		storage: {
			get: async (key: string) => (key === counterKey ? seeded : { todos: [] }),
			set: async () => {},
			remove: async (key: string) => {
				removeCalls.push(String(key))
			},
		},
		tool: { transform: async () => ({ dispose() {} }), list: async () => [] },
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(80)
	return { cleanup, stream, capture, removeCalls, injected, counterKey }
}

describe("v2: durable auto-resume description survives a reload", () => {
	test("a described injection does not wipe the persisted counter record", async () => {
		const SID = "ses_own_desc"
		const now = Date.now()
		const messages: any[] = [
			{ type: "user", id: "u1", time: { created: now - 900_000 }, text: "do the work" },
			{ type: "assistant", id: "a1", time: { created: now - 500_000 }, content: [] },
			// Newest user message: our own injection — body redacted, description ours.
			{ type: "user", id: "u2", time: { created: now - 1_000 }, description: "auto-resume: stalled — retrying", content: [] },
		]
		const h = await setup(SID, messages)
		// Idle inspection only: execution.started would trip the busy-handler
		// counter wipe (a separate site from the genuine-user block under test).
		h.stream.push({ type: "session.idle", data: { sessionID: SID } })
		await wait(200)
		const logs = h.capture.lines.join("\n")
		await h.cleanup()
		h.capture.stop()
		// Precondition: the seeded counter was restored at setup, so the
		// in-memory budget (workRetries=2) existed when the injection arrived.
		expect(logs).toContain("counters restored: workRetries=2")
		expect(logs).toContain("newest user message is our own prompt")
		// The genuine-user path removes the persisted record; the own-injection
		// path must not reach it.
		expect(h.removeCalls).not.toContain(h.counterKey)
	})

	test("control: a genuine user message wipes the persisted counter record", async () => {
		const SID = "ses_own_desc_ctrl"
		const now = Date.now()
		const messages: any[] = [
			{ type: "user", id: "u1", time: { created: now - 900_000 }, text: "do the work" },
			{ type: "assistant", id: "a1", time: { created: now - 500_000 }, content: [] },
			// Newest message is genuine: readable body, no description.
			{ type: "user", id: "u_real_new", time: { created: now - 1_000 }, text: "switch to a different approach" },
		]
		const h = await setup(SID, messages)
		h.stream.push({ type: "session.idle", data: { sessionID: SID } })
		await wait(200)
		const logs = h.capture.lines.join("\n")
		await h.cleanup()
		h.capture.stop()
		expect(logs).toContain("counters restored: workRetries=2")
		// Same trigger, opposite verdict: the genuine turn resets budgets and
		// drops the persisted record. Without this control the first test would
		// pass even if the genuine path never ran at all.
		expect(h.removeCalls).toContain(h.counterKey)
		expect(logs).not.toContain("newest user message is our own prompt")
	})
})
