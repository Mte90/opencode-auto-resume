import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "AutoResumePauseTest"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_pause"

type Harness = {
	injected: Array<{ kind: string; text?: string }>
	interrupts: string[]
	logs: string[]
	capture: ReturnType<typeof capturePluginLogs>
	commandExecute: ((input: any) => Promise<any>) | null
}

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

async function setupHarness(): Promise<Harness> {
	const injected: Harness["injected"] = []
	const interrupts: string[] = []
	const stream = makeEventStream()
	const capture = capturePluginLogs()
	let commandExecute: Harness["commandExecute"] = null

	const ctx: any = {
		app: { name: "opencode", version: "2.0.27", channel: "stable" },
		event: stream,
		options: { toolTextCheckDelayMs: 0, registryScope: LOG_SALT },
		session: {
			context: async () => [],
			active: async () => ({}),
			interrupt: async (a: any) => {
				interrupts.push(a?.sessionID)
				return {}
			},
			synthetic: async (a: any) => {
				injected.push({ kind: "synthetic", text: a?.text })
				return {}
			},
			prompt: async (a: any) => {
				injected.push({ kind: "prompt", text: a?.text })
				return {}
			},
		},
		command: {
			transform: async (fn: (cmd: any) => void) => {
				const mockCmd = {
					add: (c: any) => {
						if (c.name === "auto-resume") {
							commandExecute = c.execute
						}
					},
				}
				await fn(mockCmd)
			},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)

	return {
		injected,
		interrupts,
		logs: capture.lines,
		capture,
		commandExecute,
	}
}

describe("v2: pause/resume in-memory state", () => {
	test("disk-backed pause mechanism is removed", () => {
		expect(SOURCE).not.toContain("auto-resume.paused")
		expect(SOURCE).not.toContain("PAUSED_MARKER_FILE")
	})

	test("/auto-resume off sets paused state in memory", async () => {
		const { commandExecute, capture, injected } = await setupHarness()
		expect(commandExecute).toBeTruthy()

		await commandExecute!({ sessionID: SID, args: "off" })
		capture.stop()

		const promptText = injected.find((i) => i.kind === "prompt" && i.text?.includes("auto-resume paused"))
		expect(promptText).toBeTruthy()
	})

	test("/auto-resume status reports paused after off", async () => {
		const { commandExecute, capture, injected } = await setupHarness()
		expect(commandExecute).toBeTruthy()

		// First pause the session
		await commandExecute!({ sessionID: SID, args: "off" })

		// Check status
		injected.length = 0 // clear previous output
		await commandExecute!({ sessionID: SID, args: "status" })
		capture.stop()

		const statusLine = injected.find((i) => i.kind === "prompt" && i.text?.includes("auto-resume is"))
		expect(statusLine?.text).toContain("paused")
	})

	test("/auto-resume on clears paused state", async () => {
		const { commandExecute, capture, injected } = await setupHarness()
		expect(commandExecute).toBeTruthy()

		// First pause the session
		await commandExecute!({ sessionID: SID, args: "off" })
		injected.length = 0 // clear previous output

		// Resume
		await commandExecute!({ sessionID: SID, args: "on" })
		capture.stop()

		const promptText = injected.find((i) => i.kind === "prompt" && i.text?.includes("auto-resume resumed"))
		expect(promptText).toBeTruthy()
	})

	test("/auto-resume status reports active after on", async () => {
		const { commandExecute, capture, injected } = await setupHarness()
		expect(commandExecute).toBeTruthy()

		// Pause then resume
		await commandExecute!({ sessionID: SID, args: "off" })
		injected.length = 0 // clear previous output
		await commandExecute!({ sessionID: SID, args: "on" })
		injected.length = 0 // clear previous output

		// Check status
		await commandExecute!({ sessionID: SID, args: "status" })
		capture.stop()

		const statusLine = injected.find((i) => i.kind === "prompt" && i.text?.includes("auto-resume is"))
		expect(statusLine?.text).toContain("active")
	})

	test("pause state is process-lifetime only (no file writes)", async () => {
		const { capture, commandExecute } = await setupHarness()
		expect(commandExecute).toBeTruthy()

		// Perform pause/resume operations
		await commandExecute!({ sessionID: SID, args: "off" })
		await commandExecute!({ sessionID: SID, args: "on" })
		capture.stop()

		// Verify no file system operations related to pause marker
		// The plugin should not attempt to write any pause marker file
		const fsOps = capture.lines.filter((l) =>
			l.includes("pause") && (l.includes("failed") || l.includes("write"))
		)
		expect(fsOps.length).toBe(0)
	})
})
