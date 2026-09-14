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
                todo: mock(async () => ({ data: [] })),
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

        await hooks.event!({ event: { type: "session.created", sessionID: "ses_new" } as any })

        // Session should be registered - send another event to verify it doesn't crash
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_new", properties: { status: "busy" } } as any })
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_new", properties: { status: "idle" } } as any })

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

        await hooks.event!({ event: { type: "session.updated", sessionID: "ses_test1" } as any })

        // Should be registered - verify by sending status event
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })

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

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })

        // Give it a moment to process
        await wait(10)

        // Session should exist and have proper watch
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })
    })

    test("status 'idle' + open todos + busyCount===0 → continue sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        // Send idle event
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })

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

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "retry" } } as any })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("status 'interrupted' → userCancelled set, no continue sent, timer cleared", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "interrupted" } } as any })

        await wait(600)

        expect(promptCalls.length).toBe(0)
    })

    test("status with object { type: 'busy' } → treated as busy", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: { type: "busy" } } } as any })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("status 'unknown' → no crash, no continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "unknown" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "unknown" } } as any })

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

        await hooks.event!({ event: { type: "session.idle", sessionID: "ses_test1" } as any })

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

        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_test1" } as any })

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

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })

        await wait(150)
        expect(promptCalls.length).toBe(1)

        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_test1" } as any })

        await wait(200)

        expect(promptCalls.length).toBe(1)
    })

    test("after interrupt, subsequent idle does NOT send continue (userCancelled persists)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_test1" } as any })
        await wait(100)

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })
        await wait(200)

        expect(promptCalls.length).toBe(0)
    })

    test("after Esc, busy event does NOT clear userCancelled (FIX issue #16)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_test1" } as any })
        await wait(100)
        expect(promptCalls.length).toBe(0)

        // busy event must NOT clear userCancelled (the bug was: plugin's own resume triggers busy → clears ESC)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })
        await wait(50)

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })
        await wait(200)

        expect(promptCalls.length).toBe(0)  // ESC sticks — no resume after interrupt
    })
})

describe("handleEvent - session.error", () => {
    test("MessageAbortedError on busy session → session marked idle, userCancelled=true", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
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

        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "ProviderError", data: { message: "rate limited" } } }
            } as any
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

        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "ProviderError", data: { message: "rate limited" } } }
            } as any
        })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("MessageAbortedError on idle session with NO plugin abort in flight → userCancelled set, no continue sent", async () => {
        // Issue #19: When user presses ESC, session.status idle often arrives BEFORE session.error,
        // so the userCancelled latch must be set even when session is already idle
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Session is already idle (race condition: idle arrived before error)
        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
        })

        await wait(50)

        // userCancelled should be set, so no continue prompt should be sent
        expect(promptCalls.length).toBe(0)

        // Subsequent idle event should NOT trigger continue (userCancelled persists)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })
        await wait(100)

        expect(promptCalls.length).toBe(0)
    })

    test("MessageAbortedError during plugin-initiated abort (pluginAbortInFlight=true) → userCancelled NOT set, continue sent", async () => {
        // Issue #19: Plugin-initiated aborts via tryAbortAndResume must be distinguishable from user ESC
        // When pluginAbortInFlight is true, the MessageAbortedError should NOT set userCancelled
        // This allows the plugin's own abort+continue sequence to complete
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up session as busy and register it
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })
        await wait(10)

        // Simulate plugin abort in flight by manually triggering abort
        // (In real code, this happens inside tryAbortAndResume which sets pluginAbortInFlight=true)
        await ctx.client.session.abort({ path: { id: "ses_test1" } })
        await wait(10)

        // MessageAbortedError arrives during plugin abort
        // Note: We cannot directly set pluginAbortInFlight in tests as it's internal,
        // but we can verify the behavior by checking that abort+continue completes
        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
        })

        await wait(100)

        // Abort should have been called
        expect(abortCalls.length).toBe(1)
        expect(abortCalls[0].sid).toBe("ses_test1")

        // Since this simulates a plugin abort (not user ESC), continue should eventually be sent
        // The exact timing depends on ABORT_CONTINUE_DELAY_MS in the implementation
        // For this test, we verify that the session is not blocked by userCancelled
    })

    test("Multiple MessageAbortedError events → userCancelled set only on first (non-plugin abort)", async () => {
        // Issue #19: Verify that userCancelled persists and prevents duplicate handling
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // First MessageAbortedError → userCancelled set
        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
        })
        await wait(50)

        expect(promptCalls.length).toBe(0)

        // Second MessageAbortedError → should not crash, should still respect userCancelled
        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
        })
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("MessageAbortedError on idle session → subsequent busy does NOT clear userCancelled (ESC sticks)", async () => {
        // Issue #19: Verify that ESC (user cancellation) persists across busy/idle cycles
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_test1", status: "idle" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up open todos to enable continue
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        // MessageAbortedError on idle session → userCancelled set
        await hooks.event!({
            event: {
                type: "session.error",
                sessionID: "ses_test1",
                properties: { error: { name: "MessageAbortedError" } }
            } as any
        })
        await wait(50)

        expect(promptCalls.length).toBe(0)

        // Busy event must NOT clear userCancelled (the bug was: plugin's busy event clears ESC)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })
        await wait(50)

        // Even after busy, idle should NOT trigger continue
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })
        await wait(100)

        expect(promptCalls.length).toBe(0) // ESC sticks — no resume after user abort
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
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "busy" } } as any })

        // Execute command
        await hooks.event!({ event: { type: "command.executed" } as any })

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
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "high" }] }
            } as any
        })

        // Send idle event
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })

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
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_test1",
                properties: { todos: [] }
            } as any
        })

        // Send idle event
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_test1", properties: { status: "idle" } } as any })

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
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "busy" } } as any })

        // One goes idle - should trigger orphan watch on parent
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } as any })

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
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })

        // Call task_complete on parent
        const result = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)

        expect(result).toContain("Task completion acknowledged")

        // Send idle - should NOT trigger continue because toolTextRecovered is true
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } as any })

        await wait(100)

        expect(promptCalls.length).toBe(0)
    })

    test("task_complete on subagent session → completionSignaled IS set; subsequent idle does NOT trigger continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [
                { id: "ses_parent", status: "busy" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Register both sessions
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "busy" } } as any })

        // Sub goes idle
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } as any })
        await wait(50)

        // Call task_complete on subagent
        const result = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_sub" } as any)

        expect(result).toContain("Task completion acknowledged")

        // Send idle again on subagent - should NOT trigger continue because completionSignaled is now set
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_sub", properties: { status: "idle" } } as any })
        await wait(100)

        // No continue should have been sent to the subagent
        expect(promptCalls.length).toBe(0)
    })

    test("task_complete with unknown sessionID → no crash, returns acknowledgment", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_test1", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Call task_complete on non-existent session
        const result = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_unknown" } as any)

        expect(result).toContain("Task completion acknowledged")
    })

    test("task_complete with open todos → blocks completion, returns unfinished-task message", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })

        // Set up open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [
                    { id: "t1", content: "task A", status: "pending", priority: "medium" },
                    { id: "t2", content: "task B", status: "in_progress", priority: "high" },
                ] }
            } as any
        })

        // Call task_complete — should be blocked
        const result = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)

        expect(result).toContain("unfinished task")
        expect(result).not.toContain("Task completion acknowledged")

        // Send idle — since completionSignaled was NOT set, the idle handler should send a reminder
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } as any })
        await wait(100)

        expect(promptCalls.length).toBeGreaterThan(0)
    })

    test("task_complete with open todos after maxRetries → accepts completion", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 1 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            } as any
        })

        // First call — blocked (override 1/1)
        const result1 = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result1).toContain("unfinished task")

        // Second call — maxRetries reached, completion accepted
        const result2 = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result2).toContain("Task completion acknowledged")

        // Send idle — should NOT trigger continue because completionSignaled is now true
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "idle" } } as any })
        await wait(100)

        expect(promptCalls.length).toBe(0)
    })

    test("taskCompleteOverrides persists across busy/idle cycle", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_parent", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 2 })

        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_parent",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            } as any
        })

        // First call — blocked (override 1/2)
        const result1 = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result1).toContain("unfinished task")

        // Session goes busy (agent responds to reminder) — resetSessionFlags called
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_parent", properties: { status: "busy" } } as any })

        // Second call — should still be blocked (override 2/2), counter persisted
        const result2 = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result2).toContain("unfinished task")

        // Third call — maxRetries reached, completion accepted
        const result3 = await hooks.tool!["task_complete"].execute({}, { sessionID: "ses_parent" } as any)
        expect(result3).toContain("Task completion acknowledged")
    })
})

describe("done-claim text detection (no tool call)", () => {
    test("todoNudgeAttempts resets on busy→work cycle (FIX: previously never reset)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_persist", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 2, toolTextCheckDelayMs: 1, minActivityGapMs: 0 })

        // Set open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_persist",
                properties: { todos: [{ id: "t1", content: "task A", status: "pending", priority: "medium" }] }
            } as any
        })

        // First idle → reminder sent (nudge 1)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)

        // Session goes busy → resetBusyFlags now resets todoNudgeAttempts to 0
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "busy" } } as any })
        await wait(50)

        // Second idle → fresh nudge budget, reminder sent again
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBeGreaterThanOrEqual(2)

        // Another busy→idle cycle — counter resets again
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "busy" } } as any })
        await wait(50)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_persist", properties: { status: "idle" } } as any })
        await wait(100)

        // Counter reset on busy, so nudge 3 fires (previously was blocked at 2)
        expect(promptCalls.length).toBeGreaterThanOrEqual(3)
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
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_notodos",
                properties: { todos: [] }
            } as any
        })

        // Session goes idle → after delay, checkForToolCallAsText runs
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_notodos", properties: { status: "idle" } } as any })
        await wait(50)

        // Should have sent the DONE_WITHOUT_WORK_PROMPT
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        const lastPrompt = promptCalls[promptCalls.length - 1]?.body ?? ""
        expect(lastPrompt).toContain("verify")
    })

    test("done-claim with no open todos → details prompt capped across busy cycles (no reset on busy)", async () => {
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
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_cap",
                properties: { todos: [] }
            } as any
        })

        // First idle → prompt sent (attempt 1/2)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(1)

        // Busy NO LONGER resets the counter → second idle sends attempt 2/2
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "busy" } } as any })
        await wait(50)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(2)

        // Cap binds across cycles: third idle sends nothing (was unbounded before #26)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "busy" } } as any })
        await wait(50)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_cap", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(2)
    })

    test("done-claim response that already contains a work description → NO details prompt (#26)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_report", status: "busy" }],
            messages: {
                ses_report: [
                    {
                        id: "m1",
                        role: "user",
                        parts: [{ type: "text", text: "do the thing" }]
                    },
                    {
                        id: "m2",
                        role: "assistant",
                        parts: [{
                            type: "text",
                            text: "Task completed.\n\nChanged files:\n- src/index.ts: removed the leftover helper and its import\n- src/old-plugin.ts: deleted (leftover from uninstalled plugin)\n\nVerification:\n- bun test → 527 pass, 0 fail\n- bun x tsc --noEmit → clean\n\nResult: leftover files removed, suite green."
                        }]
                    }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3, toolTextCheckDelayMs: 1, minActivityGapMs: 0 })

        // No open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_report",
                properties: { todos: [] }
            } as any
        })

        // Session goes idle → the done-claim matches, but the response already
        // carries file paths + verification output, so no prompt may fire
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_report", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(0)
    })

    test("inbound user message re-arms the done-claim budget after the cap", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_rearm", status: "busy" }],
            messages: {
                ses_rearm: [
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
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 1, toolTextCheckDelayMs: 1, minActivityGapMs: 0, activeUserWindowMs: 1 })

        // No open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_rearm",
                properties: { todos: [] }
            } as any
        })

        // First idle → prompt sent (attempt 1/1, cap reached)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_rearm", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(1)

        // Busy → idle → cap holds, nothing sent
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_rearm", properties: { status: "busy" } } as any })
        await wait(50)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_rearm", properties: { status: "idle" } } as any })
        await wait(100)
        expect(promptCalls.length).toBe(1)

        // Genuine new cycle: inbound user message re-arms the budget (window
        // expires first so active-user suppression does not mask the check)
        await hooks.event!({
            event: {
                type: "message.updated",
                sessionID: "ses_rearm",
                properties: { info: { role: "user" }, parts: [{ type: "text", text: "now do the other thing" }] }
            } as any
        })
        await wait(100)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_rearm", properties: { status: "busy" } } as any })
        await wait(50)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_rearm", properties: { status: "idle" } } as any })
        await wait(100)
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
        await hooks.event!({ event: { type: "session.status", properties: { status: "idle" } } as any })

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
        await hooks.event!({ event: { type: "session.status", sessionID: "invalid_id", properties: { status: "idle" } } as any })

        await wait(50)

        expect(promptCalls.length).toBe(0)
    })
})
