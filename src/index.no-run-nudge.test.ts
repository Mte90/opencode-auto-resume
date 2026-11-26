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
    const logMessages: string[] = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: {
                log: mock(async (cfg: any) => {
                    logMessages.push(String(cfg?.body?.message ?? ""))
                }),
            },
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
    return { ctx, promptCalls, abortCalls, logMessages }
}

function options(extra: Record<string, unknown> = {}) {
    return {
        enabled: true,
        chunkTimeoutMs: 10,
        gracePeriodMs: 5,
        toolTextCheckDelayMs: 10,
        noRunCheckDelayMs: 30,
        maxRecoveryRetries: 2,
        baseBackoffMs: 1,
        maxRetries: 2,
        maxBackoffMs: 10,
        checkIntervalMs: 10,
        ...extra,
    } as any
}

// ============================================================================
// BEHAVIORAL TESTS — a nudge the host accepts but never runs must not burn the
// budget in silence: the plugin escalates via abort+resume, and every
// suppression on the open-todos path names its reason in the log.
// ============================================================================

describe("open-todos nudge: accepted-but-not-run prompts", () => {
    test("no model run after the send escalates via abort+resume", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext({})

        const plugin = await AutoResumePlugin(ctx, options())
        const sendContinuePrompt = (plugin as any).__sendContinuePromptForTest as (sid: string, text: string, w: SessionWatch) => Promise<void>
        const sessions = (plugin as any).__sessionsForTest as Map<string, SessionWatch>

        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_norun", properties: { status: "idle" } },
        } as any)

        const w = sessions.get("ses_norun")
        if (!w) throw new Error("Session watch not found")

        await sendContinuePrompt("ses_norun", "continue", w)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(0)

        // toolTextCheckDelayMs (10ms) → no-run check (30ms) → abort
        await wait(200)

        expect(abortCalls.length).toBe(1)
        expect(w.recoveryAttempts).toBe(1)
        expect(w.gaveUp).toBe(false)
    })

    test("model activity after the send does NOT abort", async () => {
        const { ctx, abortCalls } = createMockContext({})

        const plugin = await AutoResumePlugin(ctx, options())
        const sendContinuePrompt = (plugin as any).__sendContinuePromptForTest as (sid: string, text: string, w: SessionWatch) => Promise<void>
        const sessions = (plugin as any).__sessionsForTest as Map<string, SessionWatch>

        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_ran", properties: { status: "idle" } },
        } as any)

        const w = sessions.get("ses_ran")
        if (!w) throw new Error("Session watch not found")

        await sendContinuePrompt("ses_ran", "continue", w)
        // The model picked the prompt up: activity is newer than the send.
        w.lastActivityAt = Date.now() + 1_000_000

        await wait(200)

        expect(abortCalls.length).toBe(0)
        expect(w.recoveryAttempts).toBe(0)
    })

    test("exhausted nudge budget logs the gate once instead of going silent", async () => {
        const { ctx, logMessages } = createMockContext({
            sessions: [{ id: "ses_gate", status: "idle" }],
            todos: { ses_gate: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] },
        })

        const plugin = await AutoResumePlugin(ctx, options())

        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_gate", properties: { status: "idle" } },
        } as any)

        const sessions = (plugin as any).__sessionsForTest as Map<string, SessionWatch>
        const w = sessions.get("ses_gate")
        if (!w) throw new Error("Session watch not found")
        w.todoNudgeAttempts = 2
        w.lastUserMessageAt = 0

        // Several periodic ticks must produce exactly one gate line.
        await wait(120)

        const gateLines = logMessages.filter((m) => m.includes("open-todos nudge suppressed: todo nudge budget exhausted"))
        expect(gateLines.length).toBe(1)
    })

    test("busy sibling session logs the stand-down once instead of skipping silently", async () => {
        const { ctx, logMessages } = createMockContext({
            sessions: [
                { id: "ses_busy", status: "busy" },
                { id: "ses_idle", status: "idle" },
            ],
            todos: { ses_idle: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] },
        })

        const plugin = await AutoResumePlugin(ctx, options())

        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_busy", properties: { status: "busy" } },
        } as any)
        await plugin.event!({
            event: { type: "session.status", sessionID: "ses_idle", properties: { status: "idle" } },
        } as any)

        await wait(120)

        const busyLines = logMessages.filter((m) => m.includes("open-todos nudge suppressed: another session is busy"))
        expect(busyLines.length).toBe(1)
    })
})
