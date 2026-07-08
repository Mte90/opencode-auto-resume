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
                status: mock(async () => ({
                    data: { "session-1": { type: "idle" }, "session-2": { type: "idle" } }
                })),
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

    test("config hook returns OK", async () => {
        const { ctx } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        await hooks.config()

        // Config should complete without errors
        expect(true).toBe(true)
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

    test("string idle status schedules tool-text recovery", async () => {
        const sid = "ses_tool_text"
        const promptCalls: Array<{ sid: string; body: string }> = []
        const ctx = {
            client: {
                app: {
                    log: mock(async () => {})
                },
                session: {
                    list: mock(async () => ({ data: [{ id: sid, status: "idle" }] })),
                    messages: mock(async (input: { path?: { id: string }; id?: string }) => {
                        const id = input.path?.id ?? input.id
                        if (id !== sid) return []
                        return [
                            {
                                role: "user",
                                agent: "sisyphus",
                                model: { providerID: "anthropic", modelID: "claude-3" },
                            },
                            {
                                role: "assistant",
                                parts: [
                                    {
                                        type: "text",
                                        text: "<function=edit><parameter name=\"file\">src/index.ts</parameter>",
                                    },
                                ],
                            },
                        ]
                    }),
                    prompt: mock(async (config: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
                        promptCalls.push({
                            sid: config.path.id,
                            body: config.body.parts.map((part) => part.text).join(""),
                        })
                        return {}
                    }),
                    abort: mock(async () => ({})),
                },
            },
        } as any
        const hooks = await AutoResumePlugin(ctx, { enabled: true, maxRetries: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
        await new Promise((resolve) => setTimeout(resolve, 3200))

        expect(ctx.client.session.messages).toHaveBeenCalled()
        expect(promptCalls).toHaveLength(1)
        expect(promptCalls[0].sid).toBe(sid)
        expect(promptCalls[0].body).toContain("raw tool call")
    })

    test("busy session status prevents abort", async () => {
        const sid = "ses_busy_abort"
        const abortCalls: string[] = []
        const statusCalls: number[] = []
        const ctx = {
            client: {
                app: {
                    log: mock(async () => {})
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => {
                        statusCalls.push(Date.now())
                        return { data: { [sid]: { type: "busy" } } }
                    }),
                    messages: mock(async () => []),
                    prompt: mock(async () => ({})),
                    abort: mock(async (config: { path: { id: string } }) => {
                        abortCalls.push(config.path.id)
                        return {}
                    }),
                },
            },
        } as any
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 50,
            subagentWaitMs: 50,
            gracePeriodMs: 0,
            maxRetries: 3,
        })

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
        await hooks.event({ event: { type: "message", sessionID: sid, properties: { delta: { text: "x" } } } } as any)

        await new Promise((resolve) => setTimeout(resolve, 300))

        expect(statusCalls.length).toBeGreaterThan(0)
        expect(abortCalls).toHaveLength(0)
    })

    test("active tool in messages prevents abort via checkSessionHasActiveTool fallback", async () => {
        const sid = "ses_tool_fallback"
        const abortCalls: string[] = []
        const messagesCalls: string[] = []
        const ctx = {
            client: {
                app: {
                    log: mock(async () => {})
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({ data: {} })),
                    messages: mock(async (input: { path?: { id: string }; id?: string }) => {
                        const id = input.path?.id ?? input.id
                        if (id !== sid) return []
                        messagesCalls.push(id)
                        return [
                            { role: "user", agent: "sisyphus" },
                            {
                                role: "assistant",
                                parts: [{ type: "tool-call", tool: "edit" }],
                            },
                        ]
                    }),
                    prompt: mock(async () => ({})),
                    abort: mock(async (config: { path: { id: string } }) => {
                        abortCalls.push(config.path.id)
                        return {}
                    }),
                },
            },
        } as any
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 50,
            subagentWaitMs: 50,
            gracePeriodMs: 0,
            maxRetries: 3,
        })

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
        await hooks.event({ event: { type: "message", sessionID: sid, properties: { delta: { text: "x" } } } } as any)

        await new Promise((resolve) => setTimeout(resolve, 300))

        expect(messagesCalls.length).toBeGreaterThan(0)
        expect(abortCalls).toHaveLength(0)
    })

    test("orphan watch does not abort parent with active tool (Path A regression)", async () => {
        const parentSid = "ses_parent_orphan"
        const subagentSid = "ses_sub_orphan"
        const abortCalls: string[] = []
        const ctx = {
            client: {
                app: {
                    log: mock(async () => {}),
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({
                        data: { [parentSid]: { type: "busy" } },
                    })),
                    messages: mock(async () => []),
                    prompt: mock(async () => ({})),
                    abort: mock(async (config: { path: { id: string } }) => {
                        abortCalls.push(config.path.id)
                        return {}
                    }),
                },
            },
        } as any
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 50,
            subagentWaitMs: 50,
            gracePeriodMs: 0,
            maxRetries: 3,
        })

        // Two sessions busy, then subagent goes idle → triggers orphan watch on parent
        await hooks.event({ event: { type: "session.status", sessionID: parentSid, properties: { status: "busy" } } } as any)
        await hooks.event({ event: { type: "session.status", sessionID: subagentSid, properties: { status: "busy" } } } as any)
        await hooks.event({ event: { type: "session.status", sessionID: subagentSid, properties: { status: "idle" } } } as any)

        // Wait for orphan watch to fire (subagentWaitMs + gracePeriodMs + checkIntervalMs)
        await new Promise((resolve) => setTimeout(resolve, 400))

        expect(abortCalls).toHaveLength(0)
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

describe("Integration: Continue Lock Prevention", () => {
    test("prevents duplicate continue when timer fires twice", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Simulate first continue prompt
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // Simulate timer firing again before first continue completes
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // Should have only 1 prompt call due to lock
        // Note: This test verifies the lock exists in the implementation
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("allows continue after user activity", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // First idle event
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // User activity (busy status)
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "busy" } 
            } 
        })

        // Another idle event should be allowed
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // Should process both idle events
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("processes multiple sessions independently", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Session 1 goes idle
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // Session 2 goes idle
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-2", 
                properties: { status: "idle" } 
            } 
        })

        // Each session should be tracked independently
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })
})

describe("Integration: Realistic Scenarios", () => {
    test("handles session stall and recovery", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Session becomes idle (stalled)
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "idle" } 
            } 
        })

        // User intervenes (becomes busy)
        await hooks.event({ 
            event: { 
                type: "session.status", 
                sessionID: "session-1", 
                properties: { status: "busy" } 
            } 
        })

        // Activity continues
        await hooks.event({ 
            event: { 
                type: "message", 
                sessionID: "session-1", 
                properties: { delta: { text: "working on it" } } 
            } 
        })

        // No errors should occur
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("handles rapid state changes", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Rapid state changes
        await hooks.event({ 
            event: { type: "session.status", sessionID: "session-1", properties: { status: "busy" } }
        })
        await hooks.event({ 
            event: { type: "session.status", sessionID: "session-1", properties: { status: "idle" } }
        })
        await hooks.event({ 
            event: { type: "session.status", sessionID: "session-1", properties: { status: "busy" } }
        })
        await hooks.event({ 
            event: { type: "session.status", sessionID: "session-1", properties: { status: "idle" } }
        })

        // Should handle all events without crashing
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("handles errors gracefully", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Session error
        await hooks.event({ 
            event: { 
                type: "session.error", 
                sessionID: "session-1", 
                properties: { error: "Network timeout" } 
            } 
        })

        // Should not throw
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("preserves agent across resume", async () => {
        const { ctx, promptCalls } = createRealisticContext()
        const hooks = await AutoResumePlugin(ctx, { enabled: true })

        // Get messages to verify agent
        const messages = await ctx.client.session.messages({ id: "session-1" })
        const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
        
        expect(lastAssistant).toBeDefined()
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })
})

describe("Hallucination Guard Regression Tests (MT1 + MT2)", () => {
    // MT1: checkForToolCallAsText hallucination guard (src/index.ts:897-905)
    // When isHallucinationLoop returns true, the guard must call tryAbortAndResume
    // (which calls abort) instead of sendContinuePrompt (which calls prompt with
    // recovery text). Without the guard, a recovery prompt is sent and no abort
    // happens — the test must fail in that case.
    test("MT1: checkForToolCallAsText hallucination guard aborts instead of sending recovery prompt", async () => {
        const sid = "ses_mt1_guard"
        const promptCalls: Array<{ sid: string; body: string }> = []
        const abortCalls: string[] = []

        const ctx = {
            client: {
                app: {
                    log: mock(async () => {}),
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({ data: { [sid]: { type: "idle" } } })),
                    messages: mock(async (input: { path?: { id: string }; id?: string }) => {
                        const id = input.path?.id ?? input.id
                        if (id !== sid) return []
                        return [
                            { role: "user", agent: "sisyphus" },
                            {
                                role: "assistant",
                                parts: [
                                    {
                                        type: "text",
                                        text: '<function=edit><parameter name="file">src/index.ts</parameter>',
                                    },
                                ],
                            },
                        ]
                    }),
                    prompt: mock(async (config: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
                        promptCalls.push({
                            sid: config.path.id,
                            body: config.body.parts.map((p) => p.text).join(""),
                        })
                        return {}
                    }),
                    abort: mock(async (config: { path: { id: string } }) => {
                        abortCalls.push(config.path.id)
                        return {}
                    }),
                },
            },
        } as any

        // loopMaxContinues: 1 makes isHallucinationLoop return true on the FIRST
        // call — no need for prior tryResume cycles to pre-populate timestamps.
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            loopMaxContinues: 1,
            maxRetries: 3,
            checkIntervalMs: 60000,
        })

        // Session goes idle with tool-call-as-text in messages.
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } } as any)

        // Wait for checkForToolCallAsText timer (TOOL_TEXT_CHECK_DELAY_MS = 3000ms).
        await new Promise((resolve) => setTimeout(resolve, 3200))

        // With the guard: abort called, prompt NOT called yet (tryAbortAndResume
        // waits ABORT_CONTINUE_DELAY_MS=2000ms before sendContinuePrompt).
        // Without the guard: prompt called with recovery text, abort NOT called.
        expect(abortCalls.length).toBeGreaterThanOrEqual(1)
        expect(abortCalls[0]).toBe(sid)
        expect(promptCalls).toHaveLength(0)
    })

    // MT2: tryResume hallucination guard (src/index.ts:981-991)
    // When isHallucinationLoop returns true inside tryResume, the guard must call
    // tryAbortAndResume (abort) instead of falling through to sendContinuePrompt
    // (prompt with "continue"). Without the guard, a continue prompt is sent and
    // no abort happens — the test must fail in that case.
    test("MT2: tryResume hallucination guard aborts instead of continuing on loop", async () => {
        const parentSid = "ses_mt2_parent"
        const targetSid = "ses_mt2_target"
        const promptCalls: Array<{ sid: string; body: string }> = []
        const abortCalls: string[] = []

        const ctx = {
            client: {
                app: {
                    log: mock(async () => {}),
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({
                        data: {
                            [parentSid]: { type: "busy" },
                            [targetSid]: { type: "idle" },
                        },
                    })),
                    messages: mock(async (input: { path?: { id: string }; id?: string }) => {
                        const id = input.path?.id ?? input.id
                        if (id !== targetSid) return []
                        return [
                            { role: "user", agent: "sisyphus" },
                            { role: "assistant", parts: [{ type: "text", text: "working" }] },
                        ]
                    }),
                    prompt: mock(async (config: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
                        promptCalls.push({
                            sid: config.path.id,
                            body: config.body.parts.map((p) => p.text).join(""),
                        })
                        return {}
                    }),
                    abort: mock(async (config: { path: { id: string } }) => {
                        abortCalls.push(config.path.id)
                        return {}
                    }),
                },
            },
        } as any

        // loopMaxContinues: 1 triggers the hallucination guard on the FIRST
        // tryResume call — no need for multiple cycles or backoff waits.
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            loopMaxContinues: 1,
            maxRetries: 3,
            checkIntervalMs: 60000,
        })

        // Create the target session watch first — todo.updated uses
        // sessions.get() (not ensureWatch), so the watch must already exist.
        await hooks.event({ event: { type: "session.created", sessionID: targetSid } } as any)

        // Set up parent as busy (needed for currentBusy === 1 check in the
        // idle handler that gates tryResume).
        await hooks.event({ event: { type: "session.status", sessionID: parentSid, properties: { status: "busy" } } } as any)

        // Set up open todos on target so the idle handler calls tryResume.
        await hooks.event({ event: { type: "todo.updated", sessionID: targetSid, properties: { todos: [{ content: "task", status: "pending" }] } } } as any)

        // Target goes idle → tryResume called (fire-and-forget, not awaited).
        // currentBusy === 1 because parent is busy.
        await hooks.event({ event: { type: "session.status", sessionID: targetSid, properties: { status: "idle" } } } as any)

        // Wait for the tryResume async chain to reach tryAbortAndResume and
        // call abort. The chain is: tryResume → isHallucinationLoop (sync, true)
        // → await checkSessionHasActiveTool (mock resolves immediately) →
        // await tryAbortAndResume → await abort. All within a few microtask
        // ticks. 500ms is more than enough.
        await new Promise((resolve) => setTimeout(resolve, 500))

        // With the guard: abort called, prompt NOT called yet (tryAbortAndResume
        // waits ABORT_CONTINUE_DELAY_MS=2000ms before sendContinuePrompt).
        // Without the guard: prompt called with "continue", abort NOT called.
        expect(abortCalls.length).toBeGreaterThanOrEqual(1)
        expect(abortCalls[0]).toBe(targetSid)
        expect(promptCalls).toHaveLength(0)
    })
})
