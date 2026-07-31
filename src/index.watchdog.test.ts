import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createWatchdogContext(opts: {
    statusMap: Record<string, string>
    messages?: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
    blockCall?: number
    slowFirstPromptMs?: number
    failFromCall?: number
    abortFails?: boolean
}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const statusMap = opts.statusMap
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
                status: mock(async () => ({ data: statusMap })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return (opts.messages ?? {})[config.path.id] ?? []
                }),
                prompt: mock(async (config: {
                    path: { id: string }
                    body: { parts: Array<{ type: string; text: string }> }
                }) => {
                    callIndex++
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map(p => p.text).join(""),
                    })
                    if (opts.failFromCall && callIndex >= opts.failFromCall) {
                        throw new Error("simulated prompt failure")
                    }
                    if (opts.blockCall === callIndex) {
                        return new Promise<void>((resolve) => release.push(resolve))
                    }
                    if (opts.slowFirstPromptMs && callIndex === 1) {
                        await wait(opts.slowFirstPromptMs)
                    }
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    if (opts.abortFails) {
                        throw new Error("simulated abort failure")
                    }
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any

    return { ctx, logCalls, promptCalls, abortCalls, statusMap, release }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status },
        },
    }
}

function makeErrorEvent(sid: string, name: string, message: string) {
    return {
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name, data: { message } } },
        },
    }
}

const ACTION_INTENT_MESSAGES = {
    ses_guard: [
        { role: "assistant", parts: [{ type: "text", text: "Voy a editar el archivo:" }] },
    ],
    ses_conc: [
        { role: "assistant", parts: [{ type: "text", text: "Voy a editar el archivo:" }] },
    ],
}

const RETRY_LOG = /recovery attempt \d+\/\d+ after prompt timeout/

const BASE_OPTS = {
    enabled: true,
    baseBackoffMs: 1,
    minActivityGapMs: 1,
}

describe("WP-05 watchdog — recovery retry & escalation", () => {
    test("watchdog retries sendContinuePrompt then escalates to abort+resume", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_rec: "idle" },
            messages: {
                ses_rec: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_rec"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        // Initial recovery send (attempt 1) + 1 watchdog retry (attempt 2),
        // then escalation. (Abort+continue sends a 3rd prompt ~2s later.)
        await wait(800)
        expect(promptCalls.length).toBe(2)
        expect(abortCalls.length).toBe(1)
        expect(abortCalls[0].sid).toBe(sid)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(true)
        expect(logCalls.some(l => l.message.includes("recovery attempt 2/2"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("max recovery attempts (2) reached, escalating to abort+resume"))).toBe(true)

        // The timer loop must NOT re-trigger while the watchdog chain runs:
        // prompt count stays exactly 2 until the abort+continue prompt lands.
        await wait(2600)
        expect(promptCalls.length).toBe(3)
        expect(abortCalls.length).toBe(1)
    })

    test("maxRecoveryRetries is configurable (escalates without retry when 1)", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_one: "idle" },
            messages: {
                ses_one: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
            maxRecoveryRetries: 1,
        } as any)
        const sid = "ses_one"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        await wait(800)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(1)
        expect(logCalls.some(l => l.message.includes("max recovery attempts (1) reached, escalating to abort+resume"))).toBe(true)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(false)
    })

    test("watchdog does nothing when session becomes busy (normal operation)", async () => {
        const { ctx, logCalls, promptCalls, abortCalls, statusMap } = createWatchdogContext({
            statusMap: { ses_busy: "idle" },
            messages: {
                ses_busy: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 100,
            checkIntervalMs: 25,
        } as any)
        const sid = "ses_busy"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        // Wait for the initial recovery send, then flip the session to busy
        // before the deferred watchdog fires.
        await wait(60)
        statusMap[sid] = "busy"
        await wait(500)

        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(0)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(false)
        expect(logCalls.some(l => l.message.includes("prompt sent >"))).toBe(false)
    })

    test("watchdog logs a warning only when pendingRecovery is false (backward compatible)", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_plain: "idle" },
            messages: {
                ses_plain: [
                    { role: "assistant", parts: [{ type: "text", text: "Voy a editar el archivo:" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_plain"

        // No streaming failure — a plain action-intent recovery sends a prompt
        // with pendingRecovery === false.
        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        await wait(500)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(0)
        expect(logCalls.some(l => l.message.includes("prompt sent >"))).toBe(true)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(false)
    })

    test("watchdogRetryGuard bypasses the w.continuing guard for watchdog retries only", async () => {
        const { ctx, logCalls, promptCalls, abortCalls, release } = createWatchdogContext({
            statusMap: { ses_guard: "idle" },
            messages: ACTION_INTENT_MESSAGES,
            // Block the action-intent prompt so w.continuing is still true
            // when the deferred watchdog fires for the recovery send.
            blockCall: 2,
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            // The watchdog fires toolTextCheckDelayMs after the recovery send;
            // the action-intent check runs 500ms after idle, so 800ms guarantees
            // the action-intent prompt is in flight when the watchdog fires.
            // warmupMs: 0 disables the session-warmup guard on action intent.
            toolTextCheckDelayMs: 800,
            warmupMs: 0,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_guard"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        // Call 1: recovery send. Call 2: action-intent continue (blocked, so
        // w.continuing stays true). Call 3: watchdog retry must bypass the
        // w.continuing guard via watchdogRetryGuard. Without the bypass the
        // retry would be skipped: only 2 prompts would be sent and the
        // "continue already in progress" debug log would appear.
        const retried = await waitFor(() => promptCalls.length >= 3, 3000)
        expect(retried).toBe(true)
        expect(promptCalls.length).toBe(3)
        expect(logCalls.some(l => l.message.includes("recovery attempt 2/2"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("continue already in progress, skipping"))).toBe(false)

        // The watchdog chain then escalates: max attempts reached → abort+resume.
        const aborted = await waitFor(() => abortCalls.length >= 1, 3000)
        expect(aborted).toBe(true)
        expect(abortCalls.length).toBe(1)
        expect(logCalls.some(l => l.message.includes("max recovery attempts (2) reached, escalating to abort+resume"))).toBe(true)

        // Release the blocked action-intent prompt so the plugin settles.
        for (const resolve of release) resolve()
    })

    test("user-triggered continue is guarded while a recovery send is in flight (no double-send)", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_conc: "idle" },
            messages: ACTION_INTENT_MESSAGES,
            // The recovery send takes 80ms, so the action-intent check at
            // toolTextCheckDelayMs hits the w.continuing guard and is skipped.
            slowFirstPromptMs: 80,
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_conc"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        await wait(500)
        expect(logCalls.some(l => l.level === "debug" && l.message.includes("continue already in progress, skipping"))).toBe(true)
        expect(promptCalls.some(p => p.body.includes("unfinished task"))).toBe(false)
        expect(promptCalls.length).toBe(2)
        expect(abortCalls.length).toBe(1)
    })

    test("successful recovery (busy transition) clears pendingRecovery — no further retries", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_ok: "idle" },
            messages: {
                ses_ok: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 100,
            checkIntervalMs: 25,
        } as any)
        const sid = "ses_ok"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)

        // Recovery succeeds: the session goes busy (resetSessionFlags clears
        // pendingRecovery and recoveryAttempts) and then idle again.
        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeStatusEvent(sid, "idle"))
        await wait(500)

        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(0)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(false)
    })

    test("watchdog logs success with elapsedMs when the session is busy at check time", async () => {
        const { ctx, logCalls, promptCalls, abortCalls, statusMap } = createWatchdogContext({
            statusMap: { ses_done: "idle" },
            messages: {
                ses_done: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 400,
            checkIntervalMs: 25,
        } as any)
        const sid = "ses_done"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)

        // The session goes busy before the deferred watchdog check fires.
        // The statusMap mock must agree, or the timer loop reconciles the
        // session back to "idle" (index.ts) before the watchdog runs.
        statusMap[sid] = "busy"
        await hooks.event(makeStatusEvent(sid, "busy"))

        const logged = await waitFor(() =>
            logCalls.some(l => l.level === "info" && l.message.includes("Recovery successful on")),
            3000,
        )
        expect(logged).toBe(true)
        const successLog = logCalls.find(l => l.message.includes("Recovery successful on"))
        expect(successLog).toBeDefined()
        expect(successLog!.message).toMatch(/elapsedMs=\d+/)

        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(0)
        expect(logCalls.some(l => RETRY_LOG.test(l.message))).toBe(false)
    })

    test("abort failure after escalation → recovery exhausted, no further prompts", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_abf: "idle" },
            messages: {
                ses_abf: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
            abortFails: true,
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
            maxRecoveryRetries: 1,
        } as any)
        const sid = "ses_abf"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        await wait(800)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(1)
        expect(logCalls.some(l => l.message.includes("Abort+Resume on"))).toBe(true)
        expect(logCalls.some(l => l.level === "warn" && l.message.includes("abort failed: simulated abort failure"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("max recovery attempts (1) reached, escalating to abort+resume"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("Recovery exhausted on"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("attempts=1, lastError=abort+resume failed"))).toBe(true)

        // No further prompts: pendingRecovery cleared on escalation and the
        // recoveryAttempts guard blocks the timer loop.
        await wait(500)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(1)
    })

    test("continue-after-abort failure → recovery exhausted, aborting cleared", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_caf: "idle" },
            messages: {
                ses_caf: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
            // Call 1: initial recovery prompt. Call 2: continue after abort.
            failFromCall: 2,
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
            maxRecoveryRetries: 1,
        } as any)
        const sid = "ses_caf"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        // ABORT_CONTINUE_DELAY_MS = 2000: the continue-after-abort prompt
        // lands ~2s after the abort, so wait for it explicitly. Call 2 throws
        // and the in-flight retry (call 3) throws too, so both are counted.
        const continued = await waitFor(() => promptCalls.length >= 3, 4000)
        expect(continued).toBe(true)
        expect(promptCalls.length).toBe(3)
        expect(abortCalls.length).toBe(1)
        expect(logCalls.some(l => l.message.includes("abort OK"))).toBe(true)
        expect(logCalls.some(l => l.level === "error" && l.message.includes("prompt retry also failed: simulated prompt failure"))).toBe(true)
        expect(logCalls.some(l => l.level === "warn" && l.message.includes("continue after abort failed: simulated prompt failure"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("Recovery exhausted on"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("lastError=abort+resume failed"))).toBe(true)
    })

    test("watchdog retry prompt failure resets recoveryAttempts and re-triggers", async () => {
        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_rrf: "idle" },
            messages: {
                ses_rrf: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
            // Call 1: initial recovery send. Call 2: the watchdog retry — fails.
            failFromCall: 2,
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
            maxRecoveryRetries: 2,
        } as any)
        const sid = "ses_rrf"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        // Call 1 (initial) + call 2 (retry, fails) + call 3 (retry's internal
        // retry, fails) + call 4 (timer-loop re-trigger) + call 5 (its internal
        // retry, fails again). The watchdog chain resets recoveryAttempts to 0
        // each time, so the timer loop keeps re-initiating.
        const reTriggered = await waitFor(() => promptCalls.length >= 5, 3000)
        expect(reTriggered).toBe(true)
        expect(promptCalls.length).toBeGreaterThanOrEqual(5)
        expect(abortCalls.length).toBe(0)
        expect(logCalls.some(l => l.level === "warn" && l.message.includes("recovery retry failed: simulated prompt failure"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("Retrying recovery on"))).toBe(true)
        expect(logCalls.some(l => l.level === "warn" && l.message.includes("pending recovery failed: simulated prompt failure"))).toBe(true)
        expect(logCalls.filter(l => l.message.includes("Pending recovery triggered")).length).toBeGreaterThanOrEqual(2)
    })

    test("abort+resume escalation succeeds: entry, abort OK, and continue done logs", async () => {        const { ctx, logCalls, promptCalls, abortCalls } = createWatchdogContext({
            statusMap: { ses_esc: "idle" },
            messages: {
                ses_esc: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 40,
            checkIntervalMs: 20,
            maxRecoveryRetries: 1,
        } as any)
        const sid = "ses_esc"

        await hooks.event(makeStatusEvent(sid, "busy"))
        await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
        await hooks.event(makeStatusEvent(sid, "idle"))

        await wait(800)
        expect(promptCalls.length).toBe(1)
        expect(abortCalls.length).toBe(1)
        expect(logCalls.some(l => l.message.includes("Abort+Resume on"))).toBe(true)
        expect(logCalls.some(l => l.message.includes("abort OK"))).toBe(true)

        const resumed = await waitFor(() => logCalls.some(l => l.message.includes("abort+continue done")), 3000)
        expect(resumed).toBe(true)
        expect(promptCalls.length).toBe(2)
        expect(abortCalls.length).toBe(1)

        // The timer loop must not re-trigger: pendingRecovery was cleared on
        // escalation and recoveryAttempts is still above 0. (The initial
        // trigger does log once, so assert the count stays at 1.)
        await wait(500)
        expect(promptCalls.length).toBe(2)
        expect(logCalls.filter(l => l.message.includes("Pending recovery triggered")).length).toBe(1)
    })
})
