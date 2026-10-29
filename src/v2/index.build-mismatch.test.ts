import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/** Unique per test FILE: bun runs every file in one process, so two files
 *  starting their counters at 0 derive the SAME tmpdir log path and read each
 *  other's writes. Discovered 2026-10-10 while chasing suite flakiness. */
const LOG_SALT = "BuildMismatchTest"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_bmm"



const textPart = (t: string) => ({ type: "text", text: t })

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

type Harness = {
	cleanup: (() => void) | undefined
	capture: ReturnType<typeof capturePluginLogs>
	logs: string[]
}

/** Set up a test context and run setup(). */
async function setupTest(app?: { name?: string; version?: string; channel?: string }): Promise<Harness> {
	const capture = capturePluginLogs()

	const stream = makeEventStream()
	const ctx: any = {
		event: stream,
		options: { toolTextCheckDelayMs: 0, registryScope: LOG_SALT },
		session: {
			context: async () => [
				{
					type: "user",
					id: "msg_u0",
					time: { created: Date.now() - 60 * 60_000 },
					content: [textPart("go ahead")],
				},
				{
					type: "assistant",
					id: "msg_a1",
					time: { created: Date.now() - 60_000 },
					content: [textPart("Ready to continue")],
				},
			],
			active: async () => ({}),
			interrupt: async () => ({}),
			synthetic: async () => ({ kind: "synthetic" }),
			prompt: async () => ({ kind: "prompt" }),
		},
	}
	if (app !== undefined) {
		ctx.app = app
	}

	const cleanup = await (plugin as any).setup(ctx)
	await wait(100) // Allow setup to complete

	const logs = capture.lines
	return { cleanup, capture, logs }
}

describe("build/server mismatch guard", () => {
	test("a ctx without app.version warns about the build/server mismatch", async () => {
		const { cleanup, capture, logs } = await setupTest(undefined)
		try {
			// setup should NOT throw
			expect(logs).toBeDefined()

			// Find the warning line
			const warnLines = logs.filter((l) =>
				l.includes("build/server mismatch") || l.includes("ctx.app.version"),
			)
			expect(warnLines.length).toBe(1)
			expect(warnLines[0]).toContain("ctx.app.version is missing")
			expect(warnLines[0]).toContain("The v2 bundle requires opencode v2")
		} finally {
			capture.stop()
			cleanup?.()
		}
	})

	test("a proper v2 app context does not warn", async () => {
		const { cleanup, capture, logs } = await setupTest({
			name: "opencode",
			version: "2.0.27",
			channel: "stable",
		})
		try {
			// setup should NOT throw
			expect(logs).toBeDefined()

			// No warning about mismatch
			const warnLines = logs.filter((l) =>
				l.includes("build/server mismatch") || l.includes("ctx.app.version"),
			)
			expect(warnLines.length).toBe(0)
		} finally {
			capture.stop()
			cleanup?.()
		}
	})
})
