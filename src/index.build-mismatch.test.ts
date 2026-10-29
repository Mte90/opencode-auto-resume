import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
    todos?: Record<string, Array<any>>
    serverUrl?: string
}) {
    const promptCalls: PromptCall[] = []
    const statusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        statusMap[s.id] = { type: s.status }
    }

    const ctx: any = {
        client: {
            app: {
                log: mock(async (_o: { body: { level: string; message: string } }) => {})
            },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map(s => ({
                        id: s.id,
                        projectID: "proj-1",
                        directory: "/test",
                        title: s.id,
                        version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() }
                    }))
                })),
                status: mock(async () => ({ data: statusMap })),
                todo: mock(async (config: { path: { id: string } }) => ({
                    data: opts.todos?.[config.path.id] ?? []
                })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return { data: opts.messages[config.path.id] ?? [] }
                }),
                prompt: mock(async (config: {
                    path: { id: string }
                    body: { parts: Array<{ type: string; text: string }> }
                }) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map(p => p.text).join("")
                    })
                    return {}
                }),
                abort: mock(async () => ({}))
            }
        },
        ui: { toast: mock(async () => {}) }
    }

    // Optionally add serverUrl for v1-compatible contexts
    if (opts.serverUrl) {
        ctx.serverUrl = opts.serverUrl
    }

    return { ctx, promptCalls }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("build/server mismatch guard", () => {
    test("a ctx without serverUrl warns about the build/server mismatch and still loads", async () => {
        const warns: string[] = []
        const originalWarn = console.warn
        console.warn = mock((msg: string) => {
            warns.push(msg)
        })

        try {
            const { ctx } = createMockContext({
                sessions: [{ id: "ses_test", status: "idle" }],
                messages: {
                    ses_test: [
                        { role: "user", parts: [{ type: "text", text: "do work" }] },
                        { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                    ]
                }
            })

            // ctx.serverUrl is NOT set, simulating opencode v2 server

            const hooks = await AutoResumePlugin(ctx, {
                enabled: true,
                baseBackoffMs: 1,
                checkIntervalMs: 10_000_000,
                maxRetries: 3,
                loopMaxContinues: 10,
                minActivityGapMs: 0,
                toolTextCheckDelayMs: 10,
                warmupMs: 0,
                activeUserWindowMs: 0
            })

            // Assert the warning was emitted with the exact substring
            expect(warns.length).toBe(1)
            expect(warns[0]).toContain("ctx.serverUrl is missing")
            expect(warns[0]).toContain("opencode v1")
            expect(warns[0]).toContain("migration.md")

            // Assert the plugin still loaded successfully
            expect(hooks).toBeDefined()
            expect(typeof hooks.event).toBe("function")
        } finally {
            console.warn = originalWarn
        }
    })

    test("a proper v1 server context does not warn", async () => {
        const warns: string[] = []
        const originalWarn = console.warn
        console.warn = mock((msg: string) => {
            warns.push(msg)
        })

        try {
            const { ctx } = createMockContext({
                sessions: [{ id: "ses_test", status: "idle" }],
                messages: {
                    ses_test: [
                        { role: "user", parts: [{ type: "text", text: "do work" }] },
                        { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                    ]
                },
                serverUrl: "http://localhost:4096"
            })

            const hooks = await AutoResumePlugin(ctx, {
                enabled: true,
                baseBackoffMs: 1,
                checkIntervalMs: 10_000_000,
                maxRetries: 3,
                loopMaxContinues: 10,
                minActivityGapMs: 0,
                toolTextCheckDelayMs: 10,
                warmupMs: 0,
                activeUserWindowMs: 0
            })

            // Assert no warning about missing serverUrl was emitted
            const serverUrlWarnings = warns.filter(w => w.includes("ctx.serverUrl is missing"))
            expect(serverUrlWarnings.length).toBe(0)

            // Assert the plugin loaded successfully
            expect(hooks).toBeDefined()
            expect(typeof hooks.event).toBe("function")
        } finally {
            console.warn = originalWarn
        }
    })
})
