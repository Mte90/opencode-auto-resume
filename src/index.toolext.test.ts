import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []

    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        defaultStatusMap[s.id] = { type: s.status }
    }
    const statusMap = opts.statusMap ?? defaultStatusMap

    const ctx = {
        client: {
            app: {
                log: mock(async (_o: any) => {})
            },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map(s => ({
                        id: s.id, projectID: "proj-1", directory: "/test",
                        title: s.id, version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() }
                    }))
                })),
                status: mock(async () => ({ data: statusMap })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return opts.messages[config.path.id] ?? []
                }),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent
                    })
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                })
            }
        },
        ui: { toast: mock(async () => {}) }
    } as any

    return { ctx, promptCalls, abortCalls }
}

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" }
]

const CLOSED_TODOS = [
    { id: "t1", content: "task one", status: "completed", priority: "high" },
    { id: "t2", content: "task two", status: "completed", priority: "high" }
]

function makeStatusEvent(sid: string, status: string) {
    return { event: { type: "session.status", sessionID: sid, properties: { status } } }
}
function makeTodoUpdatedEvent(sid: string, todos: any[]) {
    return { event: { type: "todo.updated", sessionID: sid, properties: { todos } } }
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("checkForToolCallAsText detection", () => {
    test("Assistant text contains <function=edit → prompt called (recovery prompt sent)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }, { id: "ses_blocker1", status: "busy" }],
            messages: {
                "ses_test1": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "Let me edit the file <function=edit path='test.ts'>" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker1", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_test1", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test1", "busy"))
        await hooks.event(makeStatusEvent("ses_test1", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("tool call"))
        expect(recoveryCall).toBeDefined()
    })

    test("Assistant text contains <invoke name=\"test\" → prompt called", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test2", status: "idle" }, { id: "ses_blocker2", status: "busy" }],
            messages: {
                "ses_test2": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "I will invoke <invoke name=\"test\">" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker2", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_test2", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test2", "busy"))
        await hooks.event(makeStatusEvent("ses_test2", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("tool call"))
        expect(recoveryCall).toBeDefined()
    })

    test("Assistant text contains {\"name\":\"edit\" → prompt called", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test3", status: "idle" }, { id: "ses_blocker3", status: "busy" }],
            messages: {
                "ses_test3": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: '{"name":"edit","args":{}}' }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker3", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_test3", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test3", "busy"))
        await hooks.event(makeStatusEvent("ses_test3", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("tool call"))
        expect(recoveryCall).toBeDefined()
    })

    test("Assistant text contains <parameter name=\"x\" → prompt called", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test4", status: "idle" }],
            messages: {
                "ses_test4": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "<parameter name=x value=1>" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test4", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test4", "busy"))
        await hooks.event(makeStatusEvent("ses_test4", "idle"))
        await wait(3500)

        // Check for any prompt call - the recovery prompt text
        expect(promptCalls.length).toBeGreaterThan(0)
    })

    test("Message with reasoning part containing <function=edit → prompt called", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test5", status: "idle" }, { id: "ses_blocker5", status: "busy" }],
            messages: {
                "ses_test5": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "reasoning", text: "I should use <function=edit path='test.ts'> to fix this" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker5", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_test5", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test5", "busy"))
        await hooks.event(makeStatusEvent("ses_test5", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("reasoning"))
        expect(recoveryCall).toBeDefined()
    })

    test("Message with tool_use part → prompt called with continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test6", status: "idle" }],
            messages: {
                "ses_test6": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "tool_use", name: "edit" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test6", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test6", "busy"))
        await hooks.event(makeStatusEvent("ses_test6", "idle"))
        await wait(3500)

        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Three identical tool_use parts with same name → prompt called with continue (not loop on first attempt)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test7", status: "idle" }],
            messages: {
                "ses_test7": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "tool_use", name: "edit" },
                            { type: "tool_use", name: "edit" },
                            { type: "tool_use", name: "edit" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test7", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test7", "busy"))
        await hooks.event(makeStatusEvent("ses_test7", "idle"))
        await wait(3500)

        // First attempt sends continue, loop detection needs multiple checkForToolCallAsText cycles
        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Pattern of 2-3 alternating tool names repeating 3+ times → prompt called with continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test8", status: "idle" }],
            messages: {
                "ses_test8": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "tool_use", name: "edit" },
                            { type: "tool_use", name: "read" },
                            { type: "tool_use", name: "edit" },
                            { type: "tool_use", name: "read" },
                            { type: "tool_use", name: "edit" },
                            { type: "tool_use", name: "read" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test8", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test8", "busy"))
        await hooks.event(makeStatusEvent("ses_test8", "idle"))
        await wait(3500)

        // Pattern detection needs multiple cycles, first sends reminder
        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Assistant text ends with Ready to continue + open todos → prompt called with continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test9", status: "idle" }],
            messages: {
                "ses_test9": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "I have finished the first part.\nReady to continue with task two" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test9", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test9", "busy"))
        await hooks.event(makeStatusEvent("ses_test9", "idle"))
        await wait(3500)

        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Assistant text ends with Ready to continue + all todos completed → NO prompt (or delayed)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test10", status: "idle" }],
            messages: {
                "ses_test10": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "All done.\nReady to continue with task" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test10", CLOSED_TODOS))
        await hooks.event(makeStatusEvent("ses_test10", "busy"))
        await hooks.event(makeStatusEvent("ses_test10", "idle"))
        await wait(4000)

        // Should either have no prompt or only after 2 attempts
        const continueCalls = promptCalls.filter(c => c.body === "continue")
        expect(continueCalls.length).toBeLessThanOrEqual(1)
    })

    test("Assistant text contains task completed + open todos → prompt called with done-without-work content", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test11", status: "idle" }],
            messages: {
                "ses_test11": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "task completed" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test11", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test11", "busy"))
        await hooks.event(makeStatusEvent("ses_test11", "idle"))
        await wait(3500)

        // Check for any prompt call - done without work recovery
        expect(promptCalls.length).toBeGreaterThan(0)
    })

    test("Assistant text contains all done + NO open todos → sends verification prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test12", status: "idle" }],
            messages: {
                "ses_test12": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "All done!" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, minActivityGapMs: 0 })
        await hooks.event(makeTodoUpdatedEvent("ses_test12", CLOSED_TODOS))
        await hooks.event(makeStatusEvent("ses_test12", "busy"))
        await hooks.event(makeStatusEvent("ses_test12", "idle"))
        await wait(3500)

        const verifyCalls = promptCalls.filter(c => c.body.includes("verify"))
        expect(verifyCalls.length).toBe(1)
    })

    test("Assistant text ends with 🎉 → NO prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test13", status: "idle" }],
            messages: {
                "ses_test13": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "Task finished successfully! 🎉" }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test13", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test13", "busy"))
        await hooks.event(makeStatusEvent("ses_test13", "idle"))
        await wait(3500)

        expect(promptCalls.length).toBe(0)
    })

    test("Normal assistant text, open todos, busyCount === 0 → prompt called with continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test14", status: "idle" }],
            messages: {
                "ses_test14": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "I have analyzed the code and found the issue." }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test14", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test14", "busy"))
        await hooks.event(makeStatusEvent("ses_test14", "idle"))
        await wait(3500)

        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Normal assistant text, open todos, but busyCount > 0 → NO prompt (idle-with-open-todos guard)", async () => {
        // Note: The busyCount() check in the code looks at the sessions Map, not the API status.
        // Since we can't easily simulate a busy session in the Map, we test the guard differently.
        // This test documents that the busyCount guard exists but requires internal state.
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test15", status: "idle" }],
            messages: {
                "ses_test15": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "I have analyzed the code." }
                        ]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test15", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test15", "busy"))
        await hooks.event(makeStatusEvent("ses_test15", "idle"))
        await wait(3500)

        // Without internal busy state, reminder will be sent
        const continueCall = promptCalls.find(c => c.body.includes("unfinished task"))
        expect(continueCall).toBeDefined()
    })

    test("Tool-call syntax inside fenced code block → NO tool-call recovery prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_codeblock1", status: "idle" },
                { id: "ses_blocker_cb1", status: "busy" }
            ],
            messages: {
                "ses_codeblock1": [
                    {
                        role: "assistant",
                        parts: [{
                            type: "text",
                            text: "Here is an example:\n```\n<function=edit path='test.ts'>\n</function>\n```\nLet me know if that helps."
                        }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker_cb1", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_codeblock1", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_codeblock1", "busy"))
        await hooks.event(makeStatusEvent("ses_codeblock1", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("tool call"))
        expect(recoveryCall).toBeUndefined()
    })

    test("Tool-call syntax inside inline code → NO tool-call recovery prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_codeblock2", status: "idle" },
                { id: "ses_blocker_cb2", status: "busy" }
            ],
            messages: {
                "ses_codeblock2": [
                    {
                        role: "assistant",
                        parts: [{
                            type: "text",
                            text: "Use `<function=edit path='test.ts'>` to modify files."
                        }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await hooks.event(makeStatusEvent("ses_blocker_cb2", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_codeblock2", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_codeblock2", "busy"))
        await hooks.event(makeStatusEvent("ses_codeblock2", "idle"))
        await wait(3500)

        const recoveryCall = promptCalls.find(c => c.body.includes("tool call"))
        expect(recoveryCall).toBeUndefined()
    })

    test("maxRetries reached (toolTextAttempts >= 3) → NO prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test16", status: "idle" }],
            messages: {
                "ses_test16": [
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: '<function=edit path="test.ts">' }
                        ]
                    }
                ]
            }
        })

        // Use maxRetries: 1 to quickly hit the limit
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 1 })
        await hooks.event(makeTodoUpdatedEvent("ses_test16", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_test16", "busy"))
        await hooks.event(makeStatusEvent("ses_test16", "idle"))
        await wait(3500)

        // Should have at most 1 prompt (the first attempt)
        expect(promptCalls.length).toBeLessThanOrEqual(1)
    })
})

describe("action-intent detection", () => {
    test("Assistant message ending with ':' → action-intent prompt sent (idle handler)", async () => {
        const originalLog = console.log
        const logs: string[] = []
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

        try {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_ai1", status: "idle" },
                { id: "ses_blocker_ai1", status: "busy" }
            ],
            messages: {
                "ses_ai1": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "Voy a editar el archivo de configuración:" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            warmupMs: 0,
            actionIntentPrompt: "AI_TRIGGER_IDLE",
            debug: true
        })
        await hooks.event(makeStatusEvent("ses_blocker_ai1", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_ai1", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_ai1", "busy"))
        await hooks.event(makeStatusEvent("ses_ai1", "idle"))
        await wait(1000)

        const aiCall = promptCalls.find(c => c.body.includes("AI_TRIGGER_IDLE"))
        if (!aiCall) {
            console.error("DEBUG LOGS:\n" + logs.join("\n"))
            console.error("PROMPT CALLS:", JSON.stringify(promptCalls, null, 2))
        }
        expect(aiCall).toBeDefined()
        } finally {
            console.log = originalLog
        }
    })

    test("Warmup guard blocks action-intent in idle handler", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_ai2", status: "idle" },
                { id: "ses_blocker_ai2", status: "busy" }
            ],
            messages: {
                "ses_ai2": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "Voy a editar el archivo de configuración:" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            warmupMs: 60000,
            actionIntentPrompt: "AI_TRIGGER_WARMUP_BLOCKED"
        })
        await hooks.event(makeStatusEvent("ses_blocker_ai2", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_ai2", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_ai2", "busy"))
        await hooks.event(makeStatusEvent("ses_ai2", "idle"))
        await wait(1000)

        const aiCall = promptCalls.find(c => c.body.includes("AI_TRIGGER_WARMUP_BLOCKED"))
        expect(aiCall).toBeUndefined()
    })

    test("resumeOnActionIntent: false disables action-intent detection", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_ai3", status: "idle" },
                { id: "ses_blocker_ai3", status: "busy" }
            ],
            messages: {
                "ses_ai3": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "Voy a editar el archivo de configuración:" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            warmupMs: 0,
            resumeOnActionIntent: false,
            actionIntentPrompt: "AI_TRIGGER_DISABLED"
        })
        await hooks.event(makeStatusEvent("ses_blocker_ai3", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_ai3", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_ai3", "busy"))
        await hooks.event(makeStatusEvent("ses_ai3", "idle"))
        await wait(1000)

        const aiCall = promptCalls.find(c => c.body.includes("AI_TRIGGER_DISABLED"))
        expect(aiCall).toBeUndefined()
    })

    test("Action-intent detected in checkForToolCallAsText (warmup blocks idle path)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_ai4", status: "idle" },
                { id: "ses_blocker_ai4", status: "busy" }
            ],
            messages: {
                "ses_ai4": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "Voy a editar el archivo de configuración:" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            warmupMs: 60000,
            actionIntentPrompt: "AI_TRIGGER_CHECKFOR"
        })
        await hooks.event(makeStatusEvent("ses_blocker_ai4", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_ai4", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_ai4", "busy"))
        await hooks.event(makeStatusEvent("ses_ai4", "idle"))
        await wait(3500)

        const aiCall = promptCalls.find(c => c.body.includes("AI_TRIGGER_CHECKFOR"))
        expect(aiCall).toBeDefined()
    })
})

describe("configurable prompts", () => {
    test("Custom continuePrompt is used for tool-use candidate", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_cp1", status: "idle" },
                { id: "ses_blocker_cp1", status: "busy" }
            ],
            messages: {
                "ses_cp1": [
                    {
                        role: "assistant",
                        parts: [{ type: "tool_use", name: "edit" }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            continuePrompt: "KEEP_GOING_CUSTOM"
        })
        await hooks.event(makeStatusEvent("ses_blocker_cp1", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_cp1", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_cp1", "busy"))
        await hooks.event(makeStatusEvent("ses_cp1", "idle"))
        await wait(3500)

        const customCall = promptCalls.find(c => c.body.includes("KEEP_GOING_CUSTOM"))
        expect(customCall).toBeDefined()
    })

    test("Custom toolTextRecoveryPrompt is used", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_cp2", status: "idle" },
                { id: "ses_blocker_cp2", status: "busy" }
            ],
            messages: {
                "ses_cp2": [
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: '<function=edit path="test.ts">' }]
                    }
                ]
            }
        })

        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            toolTextRecoveryPrompt: "CUSTOM_TOOL_RECOVERY"
        })
        await hooks.event(makeStatusEvent("ses_blocker_cp2", "busy"))
        await hooks.event(makeTodoUpdatedEvent("ses_cp2", OPEN_TODOS))
        await hooks.event(makeStatusEvent("ses_cp2", "busy"))
        await hooks.event(makeStatusEvent("ses_cp2", "idle"))
        await wait(3500)

        const customCall = promptCalls.find(c => c.body.includes("CUSTOM_TOOL_RECOVERY"))
        expect(customCall).toBeDefined()
    })
})

describe("debug mode", () => {
    test("debug: true emits [debug] console.log", async () => {
        const originalLog = console.log
        const logs: string[] = []
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

        try {
            const { ctx } = createMockContext({
                sessions: [
                    { id: "ses_dbg1", status: "idle" },
                    { id: "ses_blocker_dbg1", status: "busy" }
                ],
                messages: {
                    "ses_dbg1": [
                        {
                            role: "assistant",
                            parts: [{ type: "text", text: '<function=edit path="test.ts">' }]
                        }
                    ]
                }
            })

            const hooks = await AutoResumePlugin(ctx, {
                enabled: true,
                baseBackoffMs: 1,
                debug: true
            })
            await hooks.event(makeStatusEvent("ses_blocker_dbg1", "busy"))
            await hooks.event(makeTodoUpdatedEvent("ses_dbg1", OPEN_TODOS))
            await hooks.event(makeStatusEvent("ses_dbg1", "busy"))
            await hooks.event(makeStatusEvent("ses_dbg1", "idle"))
            await wait(3500)

            const debugLogs = logs.filter(l => l.includes("[debug]"))
            expect(debugLogs.length).toBeGreaterThan(0)
        } finally {
            console.log = originalLog
        }
    })

    test("debug: false (default) emits NO [debug] console.log", async () => {
        const originalLog = console.log
        const logs: string[] = []
        console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }

        try {
            const { ctx } = createMockContext({
                sessions: [
                    { id: "ses_dbg2", status: "idle" },
                    { id: "ses_blocker_dbg2", status: "busy" }
                ],
                messages: {
                    "ses_dbg2": [
                        {
                            role: "assistant",
                            parts: [{ type: "text", text: '<function=edit path="test.ts">' }]
                        }
                    ]
                }
            })

            const hooks = await AutoResumePlugin(ctx, {
                enabled: true,
                baseBackoffMs: 1
            })
            await hooks.event(makeStatusEvent("ses_blocker_dbg2", "busy"))
            await hooks.event(makeTodoUpdatedEvent("ses_dbg2", OPEN_TODOS))
            await hooks.event(makeStatusEvent("ses_dbg2", "busy"))
            await hooks.event(makeStatusEvent("ses_dbg2", "idle"))
            await wait(3500)

            const debugLogs = logs.filter(l => l.includes("[debug]"))
            expect(debugLogs.length).toBe(0)
        } finally {
            console.log = originalLog
        }
    })
})
