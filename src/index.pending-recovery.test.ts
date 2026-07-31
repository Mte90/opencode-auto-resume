import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    failFirstPrompts?: number
    blockPrompt?: boolean
} = {}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const release: Array<() => void> = []
    let callIndex = 0
    const ctx = {
        client: {
            app: {
                log: mock(async (o: { body: { level: string; message: string } }) => {
                    logCalls.push({ level: o.body.level, message: o.body.message })
                }),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => []),
                prompt: mock(async (config: any) => {
                    callIndex++
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    if (opts.failFirstPrompts && callIndex <= opts.failFirstPrompts) {
                        throw new Error("simulated prompt failure")
                    }
                    if (opts.blockPrompt) {
                        return new Promise<void>((resolve) => release.push(resolve))
                    }
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls, abortCalls, release }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

const FAST = {
    enabled: true,
    checkIntervalMs: 20,
    chunkTimeoutMs: 100_000,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 3,
    baseBackoffMs: 200,
    maxBackoffMs: 400,
    loopMaxContinues: 99,
    toolTextCheckDelayMs: 50_000,
    maxRecoveryRetries: 3,
    warmupMs: 60_000,
}

async function setup(extra: Record<string, unknown> = {}, mockOpts: { failFirstPrompts?: number; blockPrompt?: boolean } = {}) {
    const { ctx, logCalls, promptCalls, abortCalls, release } = createMockContext(mockOpts)
    const hooks = await AutoResumePlugin(ctx, { ...FAST, ...extra } as any)
    return { hooks, logCalls, promptCalls, abortCalls, release }
}

async function busy(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function idle(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
}

async function interrupted(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "interrupted" } } })
}

async function streamError(hooks: any, sid: string) {
    await hooks.event({
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ProviderError", data: { message: "stream failed" } } },
        },
    })
}

function triggeredLogs(logCalls: LogCall[]): LogCall[] {
    return logCalls.filter((l) => l.level === "info" && l.message.includes("Pending recovery triggered"))
}

describe("Pending recovery timer loop", () => {
    describe("guard conditions", () => {
        test("skips when session is not idle", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_guard_notidle"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("skips when user cancelled", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_guard_cancel"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await interrupted(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("skips while a prompt is already in flight (continuing guard)", async () => {
            const { hooks, promptCalls, release } = await setup({}, { blockPrompt: true })
            const sid = "ses_guard_cont"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            await wait(350)
            expect(promptCalls.length).toBe(1)
            for (const resolve of release) resolve()
        })

        test("skips when gaveUp is set (stall recovery exhausted)", async () => {
            const { hooks, promptCalls } = await setup({
                chunkTimeoutMs: 50,
                maxRetries: 1,
            })
            const sid = "ses_guard_gaveup"
            await busy(hooks, sid)
            const stalled = await waitFor(() => promptCalls.length >= 1)
            expect(stalled).toBe(true)
            await wait(200)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(1)
        })

        test("skips when no pendingRecovery is set", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_guard_none"
            await busy(hooks, sid)
            await idle(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("skips while recoveryAttempts > 0 (watchdog owns the counter)", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_guard_attempts"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            await wait(400)
            expect(promptCalls.length).toBe(1)
            expect(triggeredLogs(logCalls).length).toBe(1)
        })
    })

    describe("backoff calculation", () => {
        test("does not trigger before backoff elapses", async () => {
            const { hooks, logCalls, promptCalls } = await setup({ baseBackoffMs: 1000, maxBackoffMs: 1000 })
            const sid = "ses_backoff_wait"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            await wait(200)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("triggers once the backoff window elapses", async () => {
            const { hooks, logCalls, promptCalls } = await setup({ baseBackoffMs: 1000, maxBackoffMs: 1000 })
            const sid = "ses_backoff_pass"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1, 3000)
            expect(sent).toBe(true)
            expect(triggeredLogs(logCalls).length).toBe(1)
        })

        test("fast backoff triggers quickly on the next timer tick", async () => {
            const { hooks, promptCalls } = await setup()
            const sid = "ses_backoff_fast"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1, 2000)
            expect(sent).toBe(true)
        })
    })

    describe("recovery triggered", () => {
        test("logs pending recovery triggered with reason, attempt, maxRetries", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_trigger_log"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            const log = triggeredLogs(logCalls).find((l) => l.message.includes("Pending recovery triggered"))
            expect(log).toBeDefined()
            expect(log!.message).toContain("reason=ProviderError")
            expect(log!.message).toContain("attempt=1")
            expect(log!.message).toContain("maxRetries=3")
        })

        test("increments recoveryAttempts and arms continuing during the send", async () => {
            const { hooks, promptCalls, release } = await setup({}, { blockPrompt: true })
            const sid = "ses_trigger_armed"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            await wait(200)
            expect(promptCalls.length).toBe(1)
            for (const resolve of release) resolve()
            await wait(200)
            expect(promptCalls.length).toBe(1)
        })
    })

    describe("recovery not triggered - backoff", () => {
        test("no prompt and no trigger log while the backoff window is open", async () => {
            const { hooks, logCalls, promptCalls } = await setup({ baseBackoffMs: 1000, maxBackoffMs: 1000 })
            const sid = "ses_nottriggered"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            await wait(300)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
            expect(logCalls.some((l) => l.level === "info" && l.message.includes("Pending recovery triggered"))).toBe(false)
        })

        test("backoff state does not leak to other sessions", async () => {
            const { hooks, logCalls, promptCalls } = await setup({ baseBackoffMs: 1000, maxBackoffMs: 1000 })
            const sidA = "ses_other_a"
            const sidB = "ses_other_b"
            await busy(hooks, sidA)
            await streamError(hooks, sidA)
            await idle(hooks, sidA)
            await busy(hooks, sidB)
            await idle(hooks, sidB)
            await wait(250)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })
    })

    describe("pending recovery cleared paths", () => {
        test("cleared when the session goes busy", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_clear_busy"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            await busy(hooks, sid)
            await idle(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(1)
            expect(triggeredLogs(logCalls).length).toBe(1)
        })

        test("cleared on command.executed", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_clear_cmd"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            await hooks.event({ event: { type: "command.executed", sessionID: sid, properties: { sessionID: sid } } } as any)
            await wait(350)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("cleared on escalation after max recovery retries", async () => {
            const { hooks, promptCalls, abortCalls } = await setup({
                toolTextCheckDelayMs: 60,
                maxRecoveryRetries: 1,
            })
            const sid = "ses_clear_escalate"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const sent = await waitFor(() => promptCalls.length >= 1)
            expect(sent).toBe(true)
            const aborted = await waitFor(() => abortCalls.length >= 1, 3000)
            expect(aborted).toBe(true)
            await wait(2600)
            expect(promptCalls.length).toBe(2)
            expect(abortCalls.length).toBe(1)
            await wait(300)
            expect(promptCalls.length).toBe(2)
        })
    })

    describe("concurrent session busy protection", () => {
        test("busy event during the backoff window cancels pending recovery", async () => {
            const { hooks, logCalls, promptCalls } = await setup({ baseBackoffMs: 1000, maxBackoffMs: 1000 })
            const sid = "ses_conc_window"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            await wait(150)
            await busy(hooks, sid)
            await idle(hooks, sid)
            await wait(400)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })

        test("stale recovery never fires after busy clears the flags", async () => {
            const { hooks, logCalls, promptCalls } = await setup()
            const sid = "ses_conc_stale"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await busy(hooks, sid)
            await idle(hooks, sid)
            await wait(350)
            expect(promptCalls.length).toBe(0)
            expect(triggeredLogs(logCalls).length).toBe(0)
        })
    })

    describe("prompt failure handling", () => {
        test("failed recovery send resets recoveryAttempts and retries next cycle", async () => {
            const { hooks, logCalls, promptCalls } = await setup({}, { failFirstPrompts: 2 })
            const sid = "ses_fail_retry"
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            const retried = await waitFor(() => promptCalls.length >= 3, 3000)
            expect(retried).toBe(true)
            expect(promptCalls.length).toBe(3)
            expect(logCalls.some((l) => l.level === "warn" && l.message.includes("prompt failed"))).toBe(true)
            expect(logCalls.some((l) => l.level === "error" && l.message.includes("prompt retry also failed"))).toBe(true)
            expect(logCalls.some((l) => l.level === "warn" && l.message.includes("pending recovery failed"))).toBe(true)
            expect(triggeredLogs(logCalls).length).toBe(2)
        })
    })
})
