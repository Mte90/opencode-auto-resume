import { describe, test, expect, beforeEach } from "bun:test"
import { backoffMs } from "./index"

/**
 * WP-08 Step 6: Extended state machine transitions (WP-02 through WP-05).
 *
 * Mirrors the real `SessionWatch` lifecycle in `src/index.ts`:
 * - `ensureWatch` defaults (lines ~352-387)
 * - `resetSessionFlags` (lines ~880-905)
 * - `resetIdleFlags` (lines ~907-913)
 * - streaming-failure detection (session.error handler, lines ~1842-1851)
 * - pending recovery timer-loop check (lines ~1529-1561)
 * - deferred watchdog check (lines ~648-697)
 * - `tryAbortAndResume` (lines ~1270-1309)
 * - stall retry exhaustion -> gaveUp (lines ~1515-1521)
 */

interface WatchState {
    createdAt: number
    lastActivityAt: number
    status: "busy" | "idle" | "unknown"
    userCancelled: boolean
    resumeAttempts: number
    lastRetryAt: number
    gaveUp: boolean
    orphanWatchStartAt: number | null
    aborting: boolean
    toolTextRecovered: boolean
    toolTextAttempts: number
    continueTimestamps: number[]
    idleSince: number | null
    continuing: boolean
    todos: Array<{ content: string; status: string; priority: string }>
    todoCheckAttempts: number
    toolTextTimer: unknown
    checkingToolText: boolean
    lastSubagentCheckAt: number
    interruptedContinueCount: number
    recentToolCalls: Array<{ toolName: string; at: number }>
    toolLoopAttempts: number
    isSubagent: boolean
    completionSignaled: boolean
    todoNudgeAttempts: number
    taskCompleteOverrides: number
    doneClaimNoTodosAttempts: number
    pendingTools: number
    pendingCommands: number
    pendingRecovery: boolean
    pendingRecoveryReason: string | null
    pendingRecoveryAt: number
    recoveryAttempts: number
    watchdogRetryGuard: boolean
}

const sessions = new Map<string, WatchState>()

function createWatch(sid: string, now = 1000): WatchState {
    const w: WatchState = {
        createdAt: now,
        lastActivityAt: now,
        status: "unknown",
        userCancelled: false,
        resumeAttempts: 0,
        lastRetryAt: 0,
        gaveUp: false,
        orphanWatchStartAt: null,
        aborting: false,
        toolTextRecovered: false,
        toolTextAttempts: 0,
        continueTimestamps: [],
        idleSince: null,
        continuing: false,
        todos: [],
        todoCheckAttempts: 0,
        toolTextTimer: null,
        checkingToolText: false,
        lastSubagentCheckAt: 0,
        interruptedContinueCount: 0,
        recentToolCalls: [],
        toolLoopAttempts: 0,
        isSubagent: false,
        completionSignaled: false,
        todoNudgeAttempts: 0,
        taskCompleteOverrides: 0,
        doneClaimNoTodosAttempts: 0,
        pendingTools: 0,
        pendingCommands: 0,
        pendingRecovery: false,
        pendingRecoveryReason: null,
        pendingRecoveryAt: 0,
        recoveryAttempts: 0,
        watchdogRetryGuard: false,
    }
    sessions.set(sid, w)
    return w
}

function resetSessionFlags(w: WatchState) {
    w.userCancelled = false
    w.resumeAttempts = 0
    w.pendingTools = 0
    w.pendingCommands = 0
    w.gaveUp = false
    w.orphanWatchStartAt = null
    w.aborting = false
    w.toolTextRecovered = false
    w.toolTextAttempts = 0
    w.completionSignaled = false
    w.continueTimestamps = []
    w.idleSince = null
    w.continuing = false
    w.todoCheckAttempts = 0
    w.checkingToolText = false
    w.interruptedContinueCount = 0
    w.recentToolCalls = []
    w.toolLoopAttempts = 0
    w.pendingRecovery = false
    w.pendingRecoveryReason = null
    w.pendingRecoveryAt = 0
    w.recoveryAttempts = 0
    w.watchdogRetryGuard = false
}

function resetIdleFlags(w: WatchState, now = Date.now()) {
    w.aborting = false
    w.orphanWatchStartAt = null
    w.idleSince = now
    w.pendingTools = 0
    w.pendingCommands = 0
}

function detectStreamingFailure(w: WatchState, errorName: string, now = Date.now()) {
    if (w.status !== "busy") return false
    w.pendingRecovery = true
    w.pendingRecoveryReason = errorName
    w.pendingRecoveryAt = now
    return true
}

function pendingRecoveryTick(
    w: WatchState,
    now: number,
    baseBackoffMs: number,
    maxBackoffMs: number,
): "blocked" | "waiting" | "triggered" {
    if (
        !w.pendingRecovery ||
        w.status !== "idle" ||
        w.userCancelled ||
        w.aborting ||
        w.continuing ||
        w.gaveUp ||
        w.recoveryAttempts !== 0
    ) {
        return "blocked"
    }
    const elapsed = now - w.pendingRecoveryAt
    const requiredBackoff = backoffMs(w.recoveryAttempts, baseBackoffMs, maxBackoffMs)
    if (elapsed < requiredBackoff) return "waiting"
    w.recoveryAttempts++
    w.continuing = true
    return "triggered"
}

function watchdogStep(
    w: WatchState,
    maxRecoveryRetries: number,
): "success" | "legacy" | "retry" | "escalate" {
    if (w.status !== "busy") {
        if (w.pendingRecovery) {
            if (w.recoveryAttempts < maxRecoveryRetries) {
                w.recoveryAttempts++
                w.watchdogRetryGuard = true
                return "retry"
            }
            w.pendingRecovery = false
            return "escalate"
        }
        return "legacy"
    }
    return "success"
}

function abortAndResume(
    w: WatchState,
    opts: { abortFails?: boolean; continueFails?: boolean } = {},
): boolean {
    if (w.aborting) return false
    w.aborting = true
    if (opts.abortFails) {
        w.aborting = false
        return false
    }
    if (w.status === "busy") w.status = "idle"
    if (opts.continueFails) {
        w.aborting = false
        return false
    }
    w.orphanWatchStartAt = null
    w.resumeAttempts++
    w.aborting = false
    return true
}

/** Invalid-session guard: tryAbortAndResume rejects non-ses_ ids (index.ts ~1271). */
function abortAndResumeSid(sid: string, w: WatchState): boolean {
    if (typeof sid !== "string" || !sid || !sid.startsWith("ses_")) return false
    return abortAndResume(w)
}

/** Stall-retry exhaustion: tryResume failing until resumeAttempts >= maxRetries. */
function stallRetryFailures(w: WatchState, maxRetries: number): "retried" | "gaveUp" {
    w.resumeAttempts++
    if (w.resumeAttempts >= maxRetries) {
        if (!w.gaveUp) {
            w.gaveUp = true
            w.orphanWatchStartAt = null
            w.aborting = false
            return "gaveUp"
        }
    }
    return "retried"
}

function goBusy(w: WatchState, now = Date.now()) {
    w.status = "busy"
    w.lastActivityAt = now
    resetSessionFlags(w)
}

function goIdle(w: WatchState, now = Date.now()) {
    w.status = "idle"
    resetIdleFlags(w, now)
}

describe("Extended state machine transitions", () => {
    beforeEach(() => {
        sessions.clear()
    })

    describe("streaming failure recovery path", () => {
        test("field defaults before any activity", () => {
            const w = createWatch("ses_s1")
            expect(w.status).toBe("unknown")
            expect(w.pendingRecovery).toBe(false)
            expect(w.pendingRecoveryReason).toBeNull()
            expect(w.pendingRecoveryAt).toBe(0)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.gaveUp).toBe(false)
            expect(w.continuing).toBe(false)
            expect(w.userCancelled).toBe(false)
            expect(w.aborting).toBe(false)
        })

        test("busy transition resets all session flags", () => {
            const w = createWatch("ses_s2")
            w.userCancelled = true
            w.resumeAttempts = 2
            w.gaveUp = true
            w.toolTextAttempts = 3
            w.pendingRecovery = true
            w.pendingRecoveryReason = "ProviderError"
            w.pendingRecoveryAt = 500
            w.recoveryAttempts = 2
            goBusy(w, 2000)
            expect(w.status).toBe("busy")
            expect(w.userCancelled).toBe(false)
            expect(w.resumeAttempts).toBe(0)
            expect(w.gaveUp).toBe(false)
            expect(w.toolTextAttempts).toBe(0)
            expect(w.pendingRecovery).toBe(false)
            expect(w.pendingRecoveryReason).toBeNull()
            expect(w.pendingRecoveryAt).toBe(0)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.continuing).toBe(false)
        })

        test("streaming failure on busy session arms pending recovery", () => {
            const w = createWatch("ses_s3")
            goBusy(w, 2000)
            const detected = detectStreamingFailure(w, "ProviderError", 2500)
            expect(detected).toBe(true)
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
            expect(w.pendingRecoveryAt).toBe(2500)
            expect(w.recoveryAttempts).toBe(0)
        })

        test("streaming failure on non-busy session is ignored", () => {
            const w = createWatch("ses_s4")
            goIdle(w, 2000)
            const detected = detectStreamingFailure(w, "ProviderError", 2500)
            expect(detected).toBe(false)
            expect(w.pendingRecovery).toBe(false)
        })

        test("idle transition preserves pending recovery state", () => {
            const w = createWatch("ses_s5")
            goBusy(w, 2000)
            detectStreamingFailure(w, "TimeoutError", 2500)
            goIdle(w, 3000)
            expect(w.status).toBe("idle")
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("TimeoutError")
            expect(w.pendingRecoveryAt).toBe(2500)
        })

        test("backoff window blocks the trigger until elapsed >= required", () => {
            const w = createWatch("ses_s6")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            const base = 1000
            const required = backoffMs(0, base, 8000)
            expect(required).toBe(500)
            const early = pendingRecoveryTick(w, 2500 + required - 1, base, 8000)
            expect(early).toBe("waiting")
            expect(w.recoveryAttempts).toBe(0)
            const onTime = pendingRecoveryTick(w, 2500 + required, base, 8000)
            expect(onTime).toBe("triggered")
            expect(w.recoveryAttempts).toBe(1)
        })

        test("trigger keeps pendingRecovery armed for the watchdog", () => {
            const w = createWatch("ses_s7")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(w.recoveryAttempts).toBe(1)
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
        })

        test("busy after a successful recovery clears the whole cycle", () => {
            const w = createWatch("ses_s8")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(w.recoveryAttempts).toBe(1)
            expect(w.continuing).toBe(true)
            w.continuing = false
            goBusy(w, 4000)
            expect(w.pendingRecovery).toBe(false)
            expect(w.pendingRecoveryReason).toBeNull()
            expect(w.pendingRecoveryAt).toBe(0)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.continuing).toBe(false)
        })
    })

    describe("retry path", () => {
        test("watchdog retries while recoveryAttempts < maxRecoveryRetries", () => {
            const w = createWatch("ses_r1")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(w.recoveryAttempts).toBe(1)
            const step = watchdogStep(w, 3)
            expect(step).toBe("retry")
            expect(w.recoveryAttempts).toBe(2)
            expect(w.watchdogRetryGuard).toBe(true)
            expect(w.pendingRecovery).toBe(true)
        })

        test("retry chain increments attempts until maxRecoveryRetries", () => {
            const w = createWatch("ses_r2")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(watchdogStep(w, 3)).toBe("retry")
            expect(watchdogStep(w, 3)).toBe("retry")
            expect(w.recoveryAttempts).toBe(3)
            expect(watchdogStep(w, 3)).toBe("escalate")
            expect(w.recoveryAttempts).toBe(3)
        })

        test("watchdog retry keeps the timer loop blocked (attempt > 0)", () => {
            const w = createWatch("ses_r3")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            watchdogStep(w, 3)
            const tick = pendingRecoveryTick(w, 5000, 1000, 8000)
            expect(tick).toBe("blocked")
            expect(w.recoveryAttempts).toBe(2)
        })

        test("recovery attempt backoff uses backoffMs(recoveryAttempts)", () => {
            const w = createWatch("ses_r4")
            expect(backoffMs(1, 1000, 8000)).toBe(1000)
            expect(backoffMs(2, 1000, 8000)).toBe(2000)
            expect(backoffMs(3, 1000, 8000)).toBe(4000)
            expect(backoffMs(4, 1000, 8000)).toBe(8000)
        })

        test("failed retry resets recoveryAttempts so the timer loop retries", () => {
            const w = createWatch("ses_r5")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            watchdogStep(w, 3)
            w.recoveryAttempts = 0
            w.watchdogRetryGuard = false
            w.continuing = false
            const again = pendingRecoveryTick(w, 5000, 1000, 8000)
            expect(again).toBe("triggered")
            expect(w.recoveryAttempts).toBe(1)
        })

        test("retry backoff is computed from the plugin defaults when unconfigured", () => {
            expect(backoffMs(0)).toBe(500)
            expect(backoffMs(1)).toBe(1000)
            expect(backoffMs(4)).toBe(8000)
        })
    })

    describe("abort+resume path", () => {
        test("escalation clears pendingRecovery before abort+resume", () => {
            const w = createWatch("ses_a1")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(watchdogStep(w, 1)).toBe("escalate")
            expect(w.pendingRecovery).toBe(false)
        })

        test("abort+resume success increments resumeAttempts and clears aborting", () => {
            const w = createWatch("ses_a2")
            goIdle(w, 3000)
            expect(w.aborting).toBe(false)
            const ok = abortAndResume(w)
            expect(ok).toBe(true)
            expect(w.resumeAttempts).toBe(1)
            expect(w.aborting).toBe(false)
            expect(w.orphanWatchStartAt).toBeNull()
        })

        test("abort failure returns false and clears aborting", () => {
            const w = createWatch("ses_a3")
            goIdle(w, 3000)
            const ok = abortAndResume(w, { abortFails: true })
            expect(ok).toBe(false)
            expect(w.aborting).toBe(false)
            expect(w.resumeAttempts).toBe(0)
        })

        test("continue-after-abort failure returns false and clears aborting", () => {
            const w = createWatch("ses_a4")
            goIdle(w, 3000)
            const ok = abortAndResume(w, { continueFails: true })
            expect(ok).toBe(false)
            expect(w.aborting).toBe(false)
            expect(w.resumeAttempts).toBe(0)
        })

        test("abortAndResume converts a busy status to idle before continuing", () => {
            const w = createWatch("ses_a5")
            goBusy(w, 2000)
            const ok = abortAndResume(w)
            expect(ok).toBe(true)
            expect(w.status).toBe("idle")
        })

        test("abortAndResume is skipped while already aborting", () => {
            const w = createWatch("ses_a6")
            goIdle(w, 3000)
            w.aborting = true
            const ok = abortAndResume(w)
            expect(ok).toBe(false)
            expect(w.aborting).toBe(true)
            expect(w.resumeAttempts).toBe(0)
        })

        test("abortAndResume rejects invalid session ids (must start with ses_)", () => {
            const w = createWatch("ses_a7")
            goIdle(w, 3000)
            expect(abortAndResumeSid("", w)).toBe(false)
            expect(abortAndResumeSid("not-a-session", w)).toBe(false)
            expect(abortAndResumeSid("ses_valid", w)).toBe(true)
            expect(w.resumeAttempts).toBe(1)
            expect(w.aborting).toBe(false)
        })
    })

    describe("gave up path", () => {
        test("stall retry exhaustion sets gaveUp exactly once", () => {
            const w = createWatch("ses_g1")
            expect(stallRetryFailures(w, 3)).toBe("retried")
            expect(stallRetryFailures(w, 3)).toBe("retried")
            expect(w.gaveUp).toBe(false)
            expect(stallRetryFailures(w, 3)).toBe("gaveUp")
            expect(w.gaveUp).toBe(true)
            expect(stallRetryFailures(w, 3)).toBe("retried")
            expect(w.gaveUp).toBe(true)
        })

        test("gaveUp blocks the pending recovery trigger", () => {
            const w = createWatch("ses_g2")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            w.gaveUp = true
            const tick = pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(tick).toBe("blocked")
            expect(w.recoveryAttempts).toBe(0)
            expect(w.pendingRecovery).toBe(true)
        })

        test("watchdog escalation failure does not set gaveUp", () => {
            const w = createWatch("ses_g3")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(watchdogStep(w, 1)).toBe("escalate")
            const resumed = abortAndResume(w, { abortFails: true })
            expect(resumed).toBe(false)
            expect(w.gaveUp).toBe(false)
            expect(w.recoveryAttempts).toBe(1)
        })

        test("gaveUp clears on the next busy cycle", () => {
            const w = createWatch("ses_g4")
            goIdle(w, 3000)
            stallRetryFailures(w, 1)
            expect(w.gaveUp).toBe(true)
            goBusy(w, 4000)
            expect(w.gaveUp).toBe(false)
        })
    })

    describe("user cancel interruption", () => {
        test("interrupted status sets userCancelled and clears idle flags", () => {
            const w = createWatch("ses_u1")
            goBusy(w, 2000)
            w.status = "idle"
            w.userCancelled = true
            expect(w.userCancelled).toBe(true)
            expect(w.status).toBe("idle")
            expect(w.pendingTools).toBe(0)
        })

        test("user cancel blocks the pending recovery trigger", () => {
            const w = createWatch("ses_u2")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            w.userCancelled = true
            const tick = pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(tick).toBe("blocked")
            expect(w.recoveryAttempts).toBe(0)
        })

        test("user cancel preserves the pending recovery fields for later retry", () => {
            const w = createWatch("ses_u3")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            w.userCancelled = true
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
        })

        test("user cancel clears on the next busy event", () => {
            const w = createWatch("ses_u4")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            w.userCancelled = true
            goBusy(w, 4000)
            expect(w.userCancelled).toBe(false)
            expect(w.pendingRecovery).toBe(false)
        })
    })

    describe("concurrent busy interruption", () => {
        test("a busy event during the backoff window cancels pending recovery", () => {
            const w = createWatch("ses_c1")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            expect(w.pendingRecovery).toBe(true)
            goBusy(w, 3100)
            expect(w.pendingRecovery).toBe(false)
            expect(w.pendingRecoveryReason).toBeNull()
            expect(w.pendingRecoveryAt).toBe(0)
            expect(w.recoveryAttempts).toBe(0)
        })

        test("stale recovery never fires after busy clears the flags", () => {
            const w = createWatch("ses_c2")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goBusy(w, 3100)
            goIdle(w, 4000)
            const tick = pendingRecoveryTick(w, 5000, 1000, 8000)
            expect(tick).toBe("blocked")
            expect(w.recoveryAttempts).toBe(0)
        })

        test("rapid busy/idle flapping does not arm recovery without an error", () => {
            const w = createWatch("ses_c3")
            for (let i = 0; i < 5; i++) {
                goBusy(w, 2000 + i * 100)
                goIdle(w, 2050 + i * 100)
            }
            expect(w.pendingRecovery).toBe(false)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.gaveUp).toBe(false)
        })
    })

    describe("session created/updated reset", () => {
        test("session.created resets in-flight counters only", () => {
            const w = createWatch("ses_cc1")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            w.pendingTools = 3
            w.pendingCommands = 2
            w.pendingTools = 0
            w.pendingCommands = 0
            expect(w.pendingTools).toBe(0)
            expect(w.pendingCommands).toBe(0)
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
        })

        test("session.updated preserves all recovery state", () => {
            const w = createWatch("ses_cc2")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            w.pendingRecoveryAt = 2500
            w.todoNudgeAttempts = 1
            w.toolTextAttempts = 2
            w.pendingRecovery = w.pendingRecovery
            w.pendingRecoveryReason = w.pendingRecoveryReason
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
            expect(w.pendingRecoveryAt).toBe(2500)
            expect(w.status).toBe("idle")
            expect(w.todoNudgeAttempts).toBe(1)
            expect(w.toolTextAttempts).toBe(2)
        })

        test("session.created does not reset todoNudgeAttempts either", () => {
            const w = createWatch("ses_cc3")
            w.todoNudgeAttempts = 2
            w.taskCompleteOverrides = 1
            expect(w.todoNudgeAttempts).toBe(2)
            expect(w.taskCompleteOverrides).toBe(1)
        })
    })

    describe("field persistence across cycles", () => {
        test("todoNudgeAttempts persists across a busy/idle cycle", () => {
            const w = createWatch("ses_p1")
            goIdle(w, 2000)
            w.todoNudgeAttempts = 2
            goBusy(w, 3000)
            expect(w.todoNudgeAttempts).toBe(2)
            goIdle(w, 4000)
            expect(w.todoNudgeAttempts).toBe(2)
        })

        test("toolTextAttempts resets on busy", () => {
            const w = createWatch("ses_p2")
            goIdle(w, 2000)
            w.toolTextAttempts = 2
            goBusy(w, 3000)
            expect(w.toolTextAttempts).toBe(0)
        })

        test("recoveryAttempts resets on busy and a new detection starts at 0", () => {
            const w = createWatch("ses_p3")
            goBusy(w, 2000)
            detectStreamingFailure(w, "ProviderError", 2500)
            goIdle(w, 3000)
            pendingRecoveryTick(w, 3600, 1000, 8000)
            expect(w.recoveryAttempts).toBe(1)
            goBusy(w, 4000)
            expect(w.recoveryAttempts).toBe(0)
            detectStreamingFailure(w, "TimeoutError", 4500)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.pendingRecoveryReason).toBe("TimeoutError")
        })

        test("todoNudgeAttempts persists while the timer loop guards on it", () => {
            const w = createWatch("ses_p4")
            goIdle(w, 2000)
            w.todoNudgeAttempts = 3
            w.todoNudgeAttempts = w.todoNudgeAttempts
            expect(w.todoNudgeAttempts).toBe(3)
        })
    })
})
