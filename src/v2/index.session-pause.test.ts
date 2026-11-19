import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capturePluginLogs } from "./test-utils"

// The pause marker path is computed from HOME at module load. Bind this suite to
// a temp HOME *before* importing the plugin so tests never touch the real
// ~/.config/opencode/auto-resume.paused. The query makes this a fresh module
// instance even when other test files imported ./index earlier in the process.
const tempHome = mkdtempSync(join(tmpdir(), "oc-ar-pause-"))
const prevHome = process.env.HOME
process.env.HOME = tempHome
const MARKER = join(tempHome, ".config", "opencode", "auto-resume.paused")
const { default: plugin } = await import(`./index?session-pause=${process.pid}`)

afterAll(() => {
	if (prevHome === undefined) delete process.env.HOME
	else process.env.HOME = prevHome
	rmSync(tempHome, { recursive: true, force: true })
})

const A = "ses_pause_a"
const B = "ses_pause_b"

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeEventStream() {
	const queue: any[] = []
	const waiters: Array<(ev: any) => void> = []
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

const OPTIONS = {
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
}

const userMessage = (text: string, at: number, id = "msg_u") => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

async function setup(scope: string) {
	const injected: Array<{ sid?: string; text?: string }> = []
	const commands: Record<string, any> = {}
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	const history: Record<string, unknown[]> = {
		[A]: [userMessage("go", Date.now() - 60_000, "msg_a")],
		[B]: [userMessage("go", Date.now() - 60_000, "msg_b")],
	}
	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { ...OPTIONS, registryScope: scope },
		session: {
			context: async (a: any) => history[a?.sessionID ?? A] ?? [],
			active: async () => ({ [A]: {}, [B]: {} }),
			interrupt: async () => ({}),
			synthetic: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
			prompt: async (a: any) => (injected.push({ sid: a?.sessionID, text: a?.text }), {}),
		},
		client: {
			session: {
				get: async ({ path }: any) => ({ data: { id: path?.id } }),
				list: async () => ({ data: [{ id: A }, { id: B }] }),
			},
		},
		storage: { get: async () => ({ todos: [] }), set: async () => {}, remove: async () => {} },
		tool: { transform: async (cb: any) => (cb({ add: () => {} }), { dispose() {} }), list: async () => [] },
		command: {
			transform: async (cb: any) => {
				cb({ add: (c: any) => (commands[c.name] = c) })
				return { dispose() {} }
			},
		},
	}
	const cleanup = await (plugin as any).setup(ctx)
	await wait(60)
	return { injected, commands, cleanup, capture, streamRef: stream }
}

async function teardown(h: any) {
	;(h.cleanup as (() => void) | undefined)?.()
	h.capture.stop()
}

const push = (h: any, type: string, sid: string, data: Record<string, unknown> = {}) =>
	h.streamRef.push({ type, data: { sessionID: sid, ...data } })

async function waitFor(what: () => boolean, budgetMs = 4000): Promise<boolean> {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (what()) return true
		await wait(10)
	}
	return what()
}

async function command(h: any, sid: string, args: string) {
	await h.commands["auto-resume"]?.execute({ sessionID: sid, args })
}

// The command's own replies go through session.prompt too — exclude them so we
// only count actual stall nudges.
const nudges = (h: any, sid: string) =>
	h.injected.filter((i: any) => i.sid === sid && !String(i.text ?? "").startsWith("auto-resume ")).length

describe("per-session /auto-resume pause", () => {
	test("off pauses only the target session; another session still recovers", async () => {
		const h = await setup("pause-only-target")
		await command(h, A, "off")
		expect(existsSync(MARKER)).toBe(true)
		expect(readFileSync(MARKER, "utf8")).toContain(A)
		expect(readFileSync(MARKER, "utf8")).not.toContain("*")

		push(h, "session.execution.started", A)
		await wait(700)
		expect(nudges(h, A)).toBe(0)

		push(h, "session.execution.started", B)
		expect(await waitFor(() => nudges(h, B) >= 1)).toBe(true)
		await teardown(h)
	})

	test("a global '*' wildcard and non-session ids never pause a session", async () => {
		const h = await setup("pause-no-wildcard")
		writeFileSync(MARKER, "*\n", "utf8")
		await command(h, "*", "off")
		await command(h, "", "off")
		await command(h, "all", "off")
		expect(readFileSync(MARKER, "utf8")).not.toContain("ses_")

		push(h, "session.execution.started", A)
		expect(await waitFor(() => nudges(h, A) >= 1)).toBe(true)
		await teardown(h)
	})

	test("on resumes the session without touching the marker of another", async () => {
		const h = await setup("pause-resume")
		await command(h, A, "off")
		await command(h, B, "off")
		await command(h, A, "on")
		const marker = readFileSync(MARKER, "utf8")
		expect(marker).not.toContain(A)
		expect(marker).toContain(B)
		await teardown(h)
	})

	test("restart deletes the marker and re-arms every session", async () => {
		const first = await setup("pause-restart-1")
		await command(first, A, "off")
		expect(existsSync(MARKER)).toBe(true)
		await teardown(first)

		const second = await setup("pause-restart-2")
		expect(existsSync(MARKER)).toBe(false)

		push(second, "session.execution.started", A)
		expect(await waitFor(() => nudges(second, A) >= 1)).toBe(true)
		await teardown(second)
	})
})
