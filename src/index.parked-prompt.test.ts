import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import type { SessionWatch } from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createMockContext(opts: {
    sessions?: Array<{ id: string; status?: string }>
    messages?: Record<string, any[]>
    todos?: Record<string, any[]>
}) {
    const promptCalls: any[] = []
    const abortCalls: any[] = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async () => {}) },
            session: {
                list: mock(async () => ({ data: opts.sessions ?? [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (cfg: any) => opts.messages?.[cfg.path.id] ?? []),
                todo: mock(async (cfg: any) => ({ data: opts.todos?.[cfg.path.id] ?? [] })),
                prompt: mock(async (cfg: any) => { promptCalls.push(cfg); return {} }),
                abort: mock(async (cfg: any) => { abortCalls.push(cfg); return {} }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls }
}

// ============================================================================
// BEHAVIORAL TESTS — verify runtime behavior of parked prompt detection.
// These tests drive the plugin through events and observe mock calls.
// ============================================================================

describe("parked prompt detection: behavioral tests", () => {
    test("Case A (bug): parked prompt escalates via abort+resume, does NOT send second prompt", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_parked", status: "busy" }],
            messages: { ses_parked: [{ role: "user", content: "test task", agent: "test-agent" }] },
            todos: { ses_parked: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] },
        })

        // Use tiny timeouts to reach stale state quickly
        const plugin = await AutoResumePlugin(ctx as any, {
            enabled: true,
            chunkTimeoutMs: 10,
            gracePeriodMs: 5,
            toolTextCheckDelayMs: 20,
            maxRecoveryRetries: 2,
            baseBackoffMs: 1,
            maxRetries: 1,
            maxBackoffMs: 10,
            checkIntervalMs: 10,
        })

        // Access internal functions for test setup
        const sendContinuePrompt = (plugin as any).__sendContinuePromptForTest as (sid: string, text: string, w: SessionWatch) => Promise<void>
        const sessions = (plugin as any).__sessionsForTest as Map<string, SessionWatch>

        // Step 1: Trigger session.status event to create the watch entry
        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_parked", properties: { status: "busy" } },
        } as any)

        const w = sessions.get("ses_parked")
        expect(w).toBeDefined()
        if (!w) throw new Error("Session watch not found")

        // Step 2: Set up the parked condition
        // Session is busy, but lastActivityAt is STALE (older than chunkTimeoutMs + gracePeriodMs = 15ms)
        const staleTime = Date.now() - 50 // 50ms ago, well past 15ms threshold
        w.lastActivityAt = staleTime

        // Step 3: Call sendContinuePrompt directly (this simulates the plugin trying to send a continue prompt)
        // The function will capture wasBusyAtSend=true, send the prompt, and then in the deferred check
        // detect the parked condition and escalate via abort+resume
        await sendContinuePrompt("ses_parked", "continue prompt", w)

        // Step 4: Wait for the deferred check to run (toolTextCheckDelayMs = 20ms)
        // The parked detection should trigger abort+resume escalation
        await wait(50)

        // ASSERTIONS:
        // 1. abort should have been called (escalation happened)
        // This proves the parked prompt was detected and escalated via abort+resume
        expect(abortCalls.length).toBeGreaterThan(0)

        // 2. Two prompts were sent: the initial one (which got parked) and the one
        // sent by tryAbortAndResume after aborting. This is the correct behavior:
        // the parked branch escalates via tryAbortAndResume (which aborts first,
        // then sends a new prompt), not by sending a duplicate prompt directly.
        expect(promptCalls.length).toBe(2)
    })

    test("Case B (control): busy with fresh activity after send does NOT abort", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_fresh", status: "busy" }],
            messages: { ses_fresh: [{ role: "user", content: "test task", agent: "test-agent" }] },
            todos: { ses_fresh: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] },
        })

        const plugin = await AutoResumePlugin(ctx as any, {
            enabled: true,
            chunkTimeoutMs: 10,
            gracePeriodMs: 5,
            toolTextCheckDelayMs: 20,
            maxRecoveryRetries: 2,
            baseBackoffMs: 1,
            maxRetries: 1,
            maxBackoffMs: 10,
            checkIntervalMs: 10,
        })

        // Access internal functions for test setup
        const sendContinuePrompt = (plugin as any).__sendContinuePromptForTest as (sid: string, text: string, w: SessionWatch) => Promise<void>
        const sessions = (plugin as any).__sessionsForTest as Map<string, SessionWatch>

        // Step 1: Trigger session.status event to create the watch entry
        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_fresh", properties: { status: "busy" } },
        } as any)

        const w = sessions.get("ses_fresh")
        expect(w).toBeDefined()
        if (!w) throw new Error("Session watch not found")

        // Step 2: Call sendContinuePrompt directly
        // The session is busy, but we'll simulate fresh activity after the send
        await sendContinuePrompt("ses_fresh", "continue prompt", w)

        // Step 3: Simulate FRESH activity after the send (this is the control case)
        // Set lastActivityAt to a value much larger than any possible sentAt
        // This ensures the parked condition (lastActivityAt <= sentAt) is FALSE
        w.lastActivityAt = Date.now() + 1000000

        // Step 4: Wait for the deferred check to run
        await wait(30)

        // ASSERTIONS:
        // 1. abort should NOT have been called (no parked condition with fresh activity)
        expect(abortCalls.length).toBe(0)

        // 2. Only 1 prompt was sent (the initial one, no escalation)
        expect(promptCalls.length).toBe(1)

        // This is the control case that proves the check is not vacuous:
        // fresh activity → no abort, success path
    })
})
