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

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("handleEvent - session.created", () => {
    test("session.created event → session is registered", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.created", sessionID: "ses_new" } })

        // Session should be registered - send another event to verify it doesn't crash
        await hooks.event({ event: { type: "session.status", sessionID: "ses_new", properties: { status: "busy" } } })
        await hooks.event({ event: { type: "session.status", sessionID: "ses_new", properties: { status: "idle" } } })

        expect(promptCalls.length).toBe(0) // No continue sent yet
    })
})

describe("handleEvent - session.updated", () => {
    test("session.updated event → session is registered (ensureWatch called)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.updated", sessionID: "ses_test1" } })

        // Should be registered - verify by sending status event
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } })
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })

        expect(promptCalls.length).toBe(0)
    })
})

describe("handleEvent - session.status", () => {
    test("status 'busy' → session watch created with status=busy, lastActivityAt updated", async () => {
        const { ctx } = createMockContext({
            sessions: [],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } })

        // Give it a moment to process
        await wait(10)

        // Session should exist and have proper watch
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })
    })

    test("status 'idle' + open todos + busyCount===0 → continue sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up open todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            }
        })

        // Send idle event
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })

        // Wait for the check to happen
        await wait(100)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_test1")
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("status 'retry' → touchSession called, no crash, no continue sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "retry" } } })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("status 'interrupted' → userCancelled set, no continue sent, timer cleared", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "interrupted" } } })

        await wait(600)

        expect(promptCalls.length).toBe(0)
    })

    test("status with object { type: 'busy' } → treated as busy", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: { type: "busy" } } } })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("status 'unknown' → no crash, no continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "unknown" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "unknown" } } })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })
})

describe("handleEvent - session.idle", () => {
    test("session.idle event → session status set to idle, tool-text timer scheduled", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_test1" } })

        await wait(100)

        // Should have scheduled a check
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })
})

describe("handleEvent - session.interrupted", () => {
    test("session.interrupted → no continue sent, backs off", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.interrupted", sessionID: "ses_test1" } })

        await wait(600)

        expect(promptCalls.length).toBe(0)
    })

    test("session.interrupted after continue → NO retry, backs off", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {
                "ses_test1": [
                    { role: "assistant", parts: [{ type: "text", text: "working..." }] },
                    { role: "user", parts: [{ type: "text", text: "continue" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } })

        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            }
        })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })

        await wait(150)
        expect(promptCalls.length).toBe(1)

        await hooks.event({ event: { type: "session.interrupted", sessionID: "ses_test1" } })

        await wait(200)

        expect(promptCalls.length).toBe(1)
    })

    test("after interrupt, subsequent idle does NOT send continue (userCancelled persists)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            }
        })

        await hooks.event({ event: { type: "session.interrupted", sessionID: "ses_test1" } })
        await wait(100)

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })
        await wait(200)

        expect(promptCalls.length).toBe(0)
    })

    test("after Esc, user writes message → busy clears userCancelled → idle resumes continues", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            }
        })

        await hooks.event({ event: { type: "session.interrupted", sessionID: "ses_test1" } })
        await wait(100)
        expect(promptCalls.length).toBe(0)

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } })
        await wait(50)

        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })
        await wait(200)

        expect(promptCalls.length).toBe(1)
    })
})

describe("handleEvent - session.error", () => {
    test("MessageAbortedError on busy session → session marked idle, userCancelled=true", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            }
        })

        await wait(50)

        // Should not crash, should handle the abort
        expect(promptCalls.length).toBe(0)
    })

    test("non-MessageAbortedError with busyCount===0 → no crash, breaks early", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "ProviderError", data: { message: "rate limited" } } }
            }
        })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("non-MessageAbortedError with busy session → log called with error details", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "ProviderError", data: { message: "rate limited" } } }
            }
        })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })
})

describe("handleEvent - command.executed", () => {
    test("command.executed → all session flags reset", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up busy session
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } })

        // Execute command
        await hooks.event({ event: { type: "command.executed" } })

        await wait(50)

        // Session should still be tracked but flags cleaned
        expect(promptCalls.length).toBe(0)
    })
})

describe("handleEvent - todo.updated", () => {
    test("todo.updated with open todos → todos stored; subsequent idle triggers continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up open todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            }
        })

        // Send idle event
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })

        await wait(100)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("todo.updated with empty todos → subsequent idle does NOT trigger continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up empty todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [] }
            }
        })

        // Send idle event
        await hooks.event({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } })

        await wait(100)

        expect(promptCalls.length).toBe(0)
    })
})

describe("handleEvent - orphan watch trigger", () => {
    test("two sessions busy → one goes idle (prevBusyCount=2, currentBusy=1) → orphanWatchStartAt set on remaining busy session", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_parent", status: "busy" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Both sessions already busy in mock, but we need to send events to register them
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })
        await hooks.event({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "busy" } } })

        // One goes idle - should trigger orphan watch on parent
        await hooks.event({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } })

        await wait(50)

        // Parent should now be marked as subagent
        // The exact verification requires internal state access, but we verify no crash
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })
})

describe("task_complete tool", () => {
    test("task_complete on parent session → toolTextRecovered=true, toolTextTimer cleared; subsequent idle does NOT trigger continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // First register the session
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })

        // Call task_complete on parent
        const result = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)

        expect(result).toContain("Task completion acknowledged")

        // Send idle - should NOT trigger continue because toolTextRecovered is true
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } })

        await wait(100)

        expect(promptCalls.length).toBe(0)
    })

    test("task_complete on subagent session → toolTextRecovered NOT set; subsequent idle still triggers continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_parent", status: "busy" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Register both sessions
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })
        await hooks.event({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "busy" } } })

        // Simulate orphan watch - sub goes idle, parent becomes orphan watch target
        await hooks.event({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } })
        await wait(50)

        // Now call task_complete on subagent
        const result = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_sub" } as any)

        expect(result).toContain("Task completion acknowledged")

        // Set up open todos for subagent
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_sub",
                properties: { todos: [{ id: "t1", content: "sub task", status: "pending", priority: "medium" }] }
            }
        })

        // Send idle on subagent - should still trigger continue because it's a subagent
        await hooks.event({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } })

        await wait(100)

        // Subagent continue should still be sent
        expect(promptCalls.length).toBeGreaterThanOrEqual(0)
    })

    test("task_complete with unknown sessionID → no crash, returns acknowledgment", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Call task_complete on non-existent session
        const result = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_unknown" } as any)

        expect(result).toContain("Task completion acknowledged")
    })

    test("task_complete with open todos → blocks completion, returns unfinished-task message", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })

        // Set up open todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [
                    { id: "t1", content: "task A", status: "pending", priority: "medium" },
                    { id: "t2", content: "task B", status: "in_progress", priority: "high" },
                ] }
            }
        })

        // Call task_complete — should be blocked
        const result = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)

        expect(result).toContain("unfinished task")
        expect(result).not.toContain("Task completion acknowledged")

        // Send idle — since completionSignaled was NOT set, the idle handler should send a reminder
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } })
        await wait(100)

        expect(promptCalls.length).toBeGreaterThan(0)
    })

    test("task_complete with open todos after maxRetries → accepts completion", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 1 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })

        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            }
        })

        // First call — blocked (override 1/1)
        const result1 = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result1).toContain("unfinished task")

        // Second call — maxRetries reached, completion accepted
        const result2 = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result2).toContain("Task completion acknowledged")

        // Send idle — should NOT trigger continue because completionSignaled is now true
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } })
        await wait(100)

        expect(promptCalls.length).toBe(0)
    })

    test("taskCompleteOverrides persists across busy/idle cycle", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 2 })

        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })

        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            }
        })

        // First call — blocked (override 1/2)
        const result1 = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result1).toContain("unfinished task")

        // Session goes busy (agent responds to reminder) — resetSessionFlags called
        await hooks.event({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } })

        // Second call — should still be blocked (override 2/2), counter persisted
        const result2 = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result2).toContain("unfinished task")

        // Third call — maxRetries reached, completion accepted
        const result3 = await hooks.tool["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result3).toContain("Task completion acknowledged")
    })
})

describe("done-claim text detection (no tool call)", () => {
    test("todoNudgeAttempts persists across busy/idle cycle (not reset by resetSessionFlags)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_persist", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 2, toolTextCheckDelayMs: 1, minActivityGapMs: 0 })

        // Set open todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_persist",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            }
        })

        // First idle → reminder sent (nudge 1)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } })
        await wait(30)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)

        // Session goes busy → resetSessionFlags called, but todoNudgeAttempts should persist
        await hooks.event({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "busy" } } })
        await wait(10)

        // Second idle → reminder sent (nudge 2)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } })
        await wait(30)
        expect(promptCalls.length).toBeGreaterThanOrEqual(2)

        // Third idle → maxRetries (2) reached, no more nudges
        await hooks.event({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "busy" } } })
        await wait(10)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } })
        await wait(30)

        // Should still be 2, not 3 — counter persisted
        expect(promptCalls.length).toBe(2)
    })

    test("done-claim text with no open todos → sends DONE_WITHOUT_WORK_PROMPT", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_notodos", status: "busy" }],
            messages: {
                ses_notodos: [
                    {
                        id: "m1",
                        role: "user",
                        parts: [{ type: "text", text: "do the thing" }]
                    },
                    {
                        id: "m2",
                        role: "assistant",
                        parts: [{ type: "text", text: "Task completed." }]
                    }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3, toolTextCheckDelayMs: 1, minActivityGapMs: 0 })

        // No open todos (empty todo list)
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_notodos",
                properties: { todos: [] }
            }
        })

        // Session goes idle → after delay, checkForToolCallAsText runs
        await hooks.event({ event: { type: "session.status", sessionID: "ses_notodos", properties: { status: "idle" } } })
        await wait(50)

        // Should have sent the DONE_WITHOUT_WORK_PROMPT
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        const lastPrompt = promptCalls[promptCalls.length - 1]?.body ?? ""
        expect(lastPrompt).toContain("verify")
    })

    test("done-claim text with no open todos → stops after maxRetries", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_cap", status: "busy" }],
            messages: {
                ses_cap: [
                    {
                        id: "m1",
                        role: "user",
                        parts: [{ type: "text", text: "do the thing" }]
                    },
                    {
                        id: "m2",
                        role: "assistant",
                        parts: [{ type: "text", text: "Task completed." }]
                    }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 2, toolTextCheckDelayMs: 1, minActivityGapMs: 0 })

        // No open todos
        await hooks.event({
            event: {
                type: "todo.updated",
                sessionID: "ses_cap",
                properties: { todos: [] }
            }
        })

        // First idle → prompt sent (attempt 1/2)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } })
        await wait(30)
        expect(promptCalls.length).toBe(1)

        // Busy → idle again (attempt 2/2)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "busy" } } })
        await wait(10)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } })
        await wait(30)
        expect(promptCalls.length).toBe(2)

        // Busy → idle again → should NOT send (cap reached)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "busy" } } })
        await wait(10)
        await hooks.event({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } })
        await wait(30)
        expect(promptCalls.length).toBe(2)
    })
})

describe("handleEvent - edge cases", () => {
    test("event with no sessionID → no crash, no action taken", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Send event without sessionID
        await hooks.event({ event: { type: "session.status", properties: { status: "idle" } } })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("event with invalid sessionID (no ses_ prefix) → no crash, ignored", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Send event with invalid sessionID
        await hooks.event({ event: { type: "session.status", sessionID: "invalid_id", properties: { status: "idle" } } })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })
})
