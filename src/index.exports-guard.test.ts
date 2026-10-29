import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

describe("REGRESSION: non-Plugin exports crash OpenCode host", () => {
    test("plugin source must NOT export isStreamingFailure as a top-level export", () => {
        expect(
            SOURCE,
            "isStreamingFailure must not be a top-level export — OpenCode's plugin loader calls every export as a Plugin entrypoint, and non-Plugin functions return non-Hooks values that crash Provider.list with 'null is not an object (evaluating N.config)'",
        ).not.toMatch(/^export\s+(function|const)\s+isStreamingFailure/m)
    })

    test("plugin source must NOT export getLastAssistantError as a top-level export", () => {
        expect(
            SOURCE,
            "getLastAssistantError must not be a top-level export — it returns null when called with (ctx, options) instead of (messages), and null.config throws",
        ).not.toMatch(/^export\s+(function|const)\s+getLastAssistantError/m)
    })

    test("plugin source must NOT export backoffMs as a top-level export", () => {
        expect(
            SOURCE,
            "backoffMs must not be a top-level export — it returns a number when called as a Plugin, not a Hooks object",
        ).not.toMatch(/^export\s+(function|const)\s+backoffMs/m)
    })

    test("plugin source must NOT export buildOpenTodosReminder as a top-level export", () => {
        expect(
            SOURCE,
            "buildOpenTodosReminder must not be a top-level export — it returns a string when called as a Plugin, not a Hooks object",
        ).not.toMatch(/^export\s+(function|const)\s+buildOpenTodosReminder/m)
    })

    test("plugin source must export AutoResumePlugin (the real Plugin)", () => {
        expect(SOURCE).toMatch(/^export\s+const\s+AutoResumePlugin/m)
    })

    test("plugin source must have a default export", () => {
        expect(SOURCE).toMatch(/^export\s+default\s+AutoResumePlugin/m)
    })
})

describe("REGRESSION: bundled dist must export dual-shape dispatcher (id, server, setup)", () => {
    test("built dist default export has id, callable server, and callable setup; server returns hooks with callable event", async () => {
        // Import the BUILT dist/index.js (same as the main entry point)
        const mod = await import("../dist/index.js")
        
        // Assert default export is an object with the required shape
        expect(typeof mod.default).toBe("object")
        expect(typeof mod.default.id).toBe("string")
        expect(mod.default.id).toBe("auto-resume.v2")
        expect(typeof mod.default.server).toBe("function")
        expect(typeof mod.default.setup).toBe("function")

        // Assert .server returns hooks with callable event
        const minimalCtx: any = {
            client: {
                app: { log: async () => {} },
                session: {
                    list: async () => ({ data: [] }),
                    status: async () => ({ data: {} }),
                    todo: async () => ({ data: [] }),
                    messages: async () => [],
                    prompt: async () => ({}),
                    abort: async () => ({}),
                },
            },
            ui: { toast: async () => {} },
        }

        const options = {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 10_000_000,
            maxRetries: 3,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0,
            activeUserWindowMs: 0
        }

        const hooks = await (mod.default.server as Function)(minimalCtx, options)
        expect(hooks).toBeDefined()
        expect(typeof hooks.event).toBe("function")
    })
})
