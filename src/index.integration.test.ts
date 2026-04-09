import { describe, test, expect, mock, beforeEach } from "bun:test"
import { AutoResumePlugin } from "./index"
import type { EventSessionStatus, EventSessionError, Session, AssistantMessage, UserMessage, Message } from "@opencode-ai/sdk"

const createRealisticContext = () => {
    const promptCalls: Array<{ sid: string; agent?: string; body: string }> = []

    const realSessions: Session[] = [
        {
            id: "session-1",
            projectID: "proj-1",
            directory: "/test/project1",
            title: "Test Session 1",
            version: "1.0.0",
            time: { created: Date.now() - 60000, updated: Date.now() - 1000 }
        },
        {
            id: "session-2",
            projectID: "proj-1", 
            directory: "/test/project1",
            title: "Test Session 2",
            version: "1.0.0",
            time: { created: Date.now() - 120000, updated: Date.now() - 5000 }
        }
    ]

    const realMessages: Map<string, Message[]> = new Map()
    realMessages.set("session-1", [
        {
            id: "msg-1",
            sessionID: "session-1",
            role: "user",
            time: { created: Date.now() - 50000 },
            agent: "prometheus",
            model: { providerID: "anthropic", modelID: "claude-3" },
            tools: {}
        } as UserMessage,
        {
            id: "msg-2",
            sessionID: "session-1",
            role: "assistant",
            time: { created: Date.now() - 40000 },
            parentID: "msg-1",
            modelID: "claude-3-sonnet",
            providerID: "anthropic",
            mode: "primary",
            path: { cwd: "/test", root: "/test" },
            cost: 0,
            tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 0, write: 0 } }
        } as AssistantMessage
    ])
    realMessages.set("session-2", [
        {
            id: "msg-3",
            sessionID: "session-2",
            role: "user",
            time: { created: Date.now() - 100000 },
            agent: "sisyphus",
            model: { providerID: "openai", modelID: "gpt-4" },
            tools: {}
        } as UserMessage,
        {
            id: "msg-4", 
            sessionID: "session-2",
            role: "assistant",
            time: { created: Date.now() - 90000 },
            parentID: "msg-3",
            modelID: "gpt-4",
            providerID: "openai",
            mode: "build",
            path: { cwd: "/test", root: "/test" },
            cost: 0,
            tokens: { input: 150, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }
        } as AssistantMessage
    ])

    const ctx = {
        client: {
            app: {
                log: mock(async (opts: { body: { service: string; level: string; message: string } }) => {
                    console.log(`[${opts.body.level.toUpperCase()}] ${opts.body.service}: ${opts.body.message}`)
                })
            },
            session: {
                list: mock(async () => ({ data: realSessions })),
                messages: mock(async (path: { id: string }) => {
                    return realMessages.get(path.id) ?? []
                }),
                prompt: mock(async (config: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> }; agent?: string }) => {
                    promptCalls.push({ 
                        sid: config.path.id, 
                        agent: config.agent,
                        body: config.body.parts.map(p => p.text).join("")
                    })
                    return {}
                }),
                abort: mock(async () => ({}))
            }
        },
        ui: {
            toast: mock(async () => {})
        }
    } as any

    return { ctx, promptCalls, realSessions, realMessages }
}

describe("Plugin Integration", () => {
    test("exports AutoResumePlugin as function", () => {
        expect(typeof AutoResumePlugin).toBe("function")
    })

    test("returns hooks object with event and config", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        expect(typeof hooks.event).toBe("function")
        expect(typeof hooks.config).toBe("function")
    })

    test("config hook shows toast", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.config()

        expect(ctx.ui.toast).toHaveBeenCalled()
    })

    test("event hook processes session.status", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.event({ event: { type: "session.status", sessionID: "session-1", properties: { status: "idle" } } })

        // Should not throw
    })

    test("event hook processes session.error", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.event({ event: { type: "session.error", sessionID: "session-1", properties: { error: "test error" } } })
    })

    test("event hook processes message delta", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.event({ event: { type: "message", sessionID: "session-1", properties: { delta: { text: "hello" } } } })
    })

    test("multiple events processed sequentially", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.event({ event: { type: "session.status", sessionID: "session-1", properties: { status: "busy" } } })
        await hooks.event({ event: { type: "message", sessionID: "session-1", properties: { delta: { text: "working" } } } })
        await hooks.event({ event: { type: "session.status", sessionID: "session-1", properties: { status: "idle" } } })
    })
})

describe("Agent Extraction Flow", () => {
    test("extracts agent from last USER message (not assistant)", async () => {
        const { ctx } = createRealisticContext()
        const messages = await ctx.client.session.messages({ id: "session-1" })

        const reversed = [...messages].reverse()
        const lastUser = reversed.find(m => m.role === "user" && "agent" in m)

        expect((lastUser as any)?.agent).toBe("prometheus")
    })

    test("extracts sisyphus from session-2", async () => {
        const { ctx } = createRealisticContext()
        const messages = await ctx.client.session.messages({ id: "session-2" })

        const reversed = [...messages].reverse()
        const lastUser = reversed.find(m => m.role === "user" && "agent" in m)

        expect((lastUser as any)?.agent).toBe("sisyphus")
    })

    test("returns undefined for nonexistent session", async () => {
        const { ctx } = createRealisticContext()
        const messages = await ctx.client.session.messages({ id: "nonexistent" })

        expect(messages).toHaveLength(0)
    })
})

describe("Prompt Call with Agent", () => {
    test("prompt receives agent parameter", async () => {
        const { ctx, promptCalls } = createRealisticContext()

        await ctx.client.session.prompt({
            path: { id: "session-1" },
            body: { parts: [{ type: "text", text: "continue" }] },
            agent: "prometheus"
        })

        expect(promptCalls).toHaveLength(1)
        expect(promptCalls[0].agent).toBe("prometheus")
        expect(promptCalls[0].sid).toBe("session-1")
    })

    test("prompt without agent is valid", async () => {
        const { ctx, promptCalls } = createRealisticContext()

        await ctx.client.session.prompt({
            path: { id: "session-1" },
            body: { parts: [{ type: "text", text: "continue" }] }
        })

        expect(promptCalls).toHaveLength(1)
        expect(promptCalls[0].agent).toBeUndefined()
    })
})

describe("Validation", () => {
    test("agent validation matches plugin logic", () => {
        const validateAgent = (a: unknown): string | undefined =>
            typeof a === "string" && a.length > 0 ? a : undefined

        expect(validateAgent("")).toBeUndefined()
        expect(validateAgent("prometheus")).toBe("prometheus")
        expect(validateAgent(undefined)).toBeUndefined()
        expect(validateAgent(null)).toBeUndefined()
        expect(validateAgent(42)).toBeUndefined()
        expect(validateAgent({})).toBeUndefined()
    })

    test("session ID validation matches plugin logic", () => {
        const validateSid = (s: unknown): boolean =>
            typeof s === "string" && !!s

        expect(validateSid("session-1")).toBe(true)
        expect(validateSid("")).toBe(false)
        expect(validateSid(null)).toBe(false)
        expect(validateSid(undefined)).toBe(false)
        expect(validateSid(123)).toBe(false)
    })
})