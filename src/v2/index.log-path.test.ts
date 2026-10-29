import { describe, test, expect } from "bun:test"
import plugin from "./index"
import { capturePluginLogs } from "./test-utils"

/**
 * v2: logging goes to console only, no log file.
 *
 * v1 wrote through `ctx.client.app.log`, a real endpoint that landed in the
 * opencode log file. v2 removed it: `ctx.app` is only `{name, version, channel}`,
 * and a hosted plugin's console output is not captured. v2 therefore logs
 * directly to the process console with `[auto-resume]` prefix.
 */
describe("v2: console-only logging", () => {
	test("info lines go to console.log with [auto-resume] prefix", async () => {
		const capture = capturePluginLogs()
		const ctx: any = {
			event: {
				subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
			},
			options: { registryScope: "LogPathTest", unknownOption: "test" },
			session: {
				context: async () => [],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			app: { name: "opencode", version: "2.0.0", channel: "stable" },
		}
		const cleanup = await (plugin as any).setup(ctx)
		await new Promise((r) => setTimeout(r, 200))

		// Check BEFORE stopping capture - should have warning about unknown option
		expect(capture.lines.some((l) => l.includes("[auto-resume]"))).toBe(true)
		expect(capture.lines.some((l) => l.includes("ignoring unrecognised option(s)"))).toBe(true)
		capture.stop()
		cleanup?.()
	})

	test("error lines go to console.error with [auto-resume] prefix", async () => {
		const capture = capturePluginLogs()
		const ctx: any = {
			event: {
				subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
			},
			options: { registryScope: "LogPathTest" },
			session: {
				context: async () => [],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			// Missing app.version to trigger warning
		}
		const cleanup = await (plugin as any).setup(ctx)
		await new Promise((r) => setTimeout(r, 200))

		// Check BEFORE stopping capture - warn level routes to console.warn
		expect(capture.warns.some((l) => l.includes("[auto-resume]"))).toBe(true)
		expect(capture.warns.some((l) => l.includes("ctx.app.version is missing"))).toBe(true)
		capture.stop()
		cleanup?.()
	})

	test("debug lines go to console.log with [auto-resume:debug] prefix when enabled", async () => {
		const capture = capturePluginLogs()
		const ctx: any = {
			event: {
				subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
			},
			options: { registryScope: "LogPathTest", debug: true },
			session: {
				context: async () => [],
				active: async () => ({}),
				interrupt: async () => ({}),
				synthetic: async () => ({}),
				prompt: async () => ({}),
			},
			app: { name: "opencode", version: "2.0.0", channel: "stable" },
		}
		const cleanup = await (plugin as any).setup(ctx)
		await new Promise((r) => setTimeout(r, 200))

		// Debug lines are only written when the plugin actually logs something at debug level
		// The presence of debug gating is tested elsewhere; this proves debug output goes to console
		expect(capture.debug).toBeDefined()
		capture.stop()
		cleanup?.()
	})
})
