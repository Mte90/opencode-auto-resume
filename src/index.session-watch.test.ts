import { describe, test, expect, beforeEach } from "bun:test"
import type { SessionWatch } from "./index"
import { backoffMs } from "./index"

function createWatch(sid: string, now = Date.now()): SessionWatch {
    return {
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
}

function detectStreamingFailure(w: SessionWatch, errorName: string, now = Date.now()) {
    w.pendingRecovery = true
    w.pendingRecoveryReason = errorName
    w.pendingRecoveryAt = now
}

function resetSessionFlags(w: SessionWatch) {
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
    if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
    w.pendingRecovery = false
    w.pendingRecoveryReason = null
    w.pendingRecoveryAt = 0
    w.recoveryAttempts = 0
    w.watchdogRetryGuard = false
}

function resetIdleFlags(w: SessionWatch) {
    w.aborting = false
    w.orphanWatchStartAt = null
    w.idleSince = Date.now()
    w.pendingTools = 0
    w.pendingCommands = 0
}

function pendingRecoveryCheck(
    w: SessionWatch,
    now: number,
    baseMs: number,
    maxMs: number,
): "blocked" | "waiting" | "triggered" {
    if (
        !(
            w.pendingRecovery &&
            w.status === "idle" &&
            !w.userCancelled &&
            !w.aborting &&
            !w.continuing &&
            !w.gaveUp &&
            w.recoveryAttempts === 0
        )
    ) {
        return "blocked"
    }
    const required = backoffMs(w.recoveryAttempts, baseMs, maxMs)
    if (now - w.pendingRecoveryAt < required) return "waiting"
    w.recoveryAttempts++
    return "triggered"
}

function watchdogStep(w: SessionWatch, maxRetries: number): "success" | "legacy" | "retry" | "escalate" {
    if (w.status === "busy") return "success"
    if (!w.pendingRecovery) return "legacy"
    if (w.recoveryAttempts < maxRetries) {
        w.recoveryAttempts++
        w.watchdogRetryGuard = true
        w.pendingRecovery = true
        w.watchdogRetryGuard = false
        return "retry"
    }
    w.pendingRecovery = false
    return "escalate"
}

describe("SessionWatch pending recovery fields", () => {
    let w: SessionWatch
    const now = 1_000_000

    beforeEach(() => {
        w = createWatch("ses_test", now)
    })

    describe("initialization", () => {
        test("pendingRecovery defaults to false", () => {
            expect(w.pendingRecovery).toBe(false)
        })

        test("pendingRecoveryReason defaults to null", () => {
            expect(w.pendingRecoveryReason).toBeNull()
        })

        test("pendingRecoveryAt defaults to 0", () => {
            expect(w.pendingRecoveryAt).toBe(0)
        })

        test("recoveryAttempts defaults to 0", () => {
            expect(w.recoveryAttempts).toBe(0)
        })

        test("gaveUp defaults to false", () => {
            expect(w.gaveUp).toBe(false)
        })

        test("continuing defaults to false", () => {
            expect(w.continuing).toBe(false)
        })

        test("watchdogRetryGuard defaults to false", () => {
            expect(w.watchdogRetryGuard).toBe(false)
        })
    })

    describe("set on streaming failure", () => {
        test("pendingRecovery is set to true", () => {
            detectStreamingFailure(w, "ProviderError", now)
            expect(w.pendingRecovery).toBe(true)
        })

        test("pendingRecoveryReason stores the error name", () => {
            detectStreamingFailure(w, "TimeoutError", now)
            expect(w.pendingRecoveryReason).toBe("TimeoutError")
        })

        test("pendingRecoveryAt records the detection timestamp for backoff", () => {
            detectStreamingFailure(w, "StreamError", now)
            expect(w.pendingRecoveryAt).toBe(now)
            expect(w.pendingRecoveryAt).toBeGreaterThan(0)
        })
    })

    describe("recovery trigger (timer loop)", () => {
        test("backoff not met → waiting, no state mutation", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            const result = pendingRecoveryCheck(w, now + 100, 1000, 8000)
            expect(result).toBe("waiting")
            expect(w.recoveryAttempts).toBe(0)
            expect(w.pendingRecovery).toBe(true)
        })

        test("backoff met → triggered, recoveryAttempts increments", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            const result = pendingRecoveryCheck(w, now + 600, 1000, 8000)
            expect(result).toBe("triggered")
            expect(w.recoveryAttempts).toBe(1)
        })

        test("pendingRecovery stays armed after trigger (watchdog verifies recovery)", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            pendingRecoveryCheck(w, now + 600, 1000, 8000)
            expect(w.pendingRecovery).toBe(true)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
        })

        test("continuing=true blocks the trigger while a prompt is in flight", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.continuing = true
            const result = pendingRecoveryCheck(w, now + 600, 1000, 8000)
            expect(result).toBe("blocked")
            expect(w.recoveryAttempts).toBe(0)
        })
    })

    describe("clear on escalation (gave up)", () => {
        test("max retries reached → pendingRecovery cleared", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.recoveryAttempts = 2
            const result = watchdogStep(w, 2)
            expect(result).toBe("escalate")
            expect(w.pendingRecovery).toBe(false)
        })

        test("escalation keeps recoveryAttempts and does not set gaveUp", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.recoveryAttempts = 2
            watchdogStep(w, 2)
            expect(w.recoveryAttempts).toBe(2)
            expect(w.gaveUp).toBe(false)
            expect(w.pendingRecoveryReason).toBe("ProviderError")
        })
    })

    describe("clear on session busy", () => {
        test("resetSessionFlags clears all recovery fields", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.recoveryAttempts = 3
            w.watchdogRetryGuard = true
            w.gaveUp = true
            w.continuing = true
            resetSessionFlags(w)
            expect(w.pendingRecovery).toBe(false)
            expect(w.pendingRecoveryReason).toBeNull()
            expect(w.pendingRecoveryAt).toBe(0)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.watchdogRetryGuard).toBe(false)
            expect(w.gaveUp).toBe(false)
            expect(w.continuing).toBe(false)
        })

        test("a busy event resets recoveryAttempts for the next cycle", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.recoveryAttempts = 2
            resetSessionFlags(w)
            expect(w.recoveryAttempts).toBe(0)
        })
    })

    describe("clear on user cancel", () => {
        test("interrupted sets userCancelled and leaves pendingRecovery inert (blocked)", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.userCancelled = true
            const result = pendingRecoveryCheck(w, now + 60_000, 1000, 8000)
            expect(result).toBe("blocked")
            expect(w.pendingRecovery).toBe(true)
            expect(w.recoveryAttempts).toBe(0)
        })

        test("busy after cancel clears pendingRecovery", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.userCancelled = true
            resetSessionFlags(w)
            expect(w.pendingRecovery).toBe(false)
            expect(w.userCancelled).toBe(false)
        })
    })

    describe("recovery attempts counter", () => {
        test("increments on each retry (0 → 1 → 2)", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            expect(w.recoveryAttempts).toBe(0)
            pendingRecoveryCheck(w, now + 600, 1000, 8000)
            expect(w.recoveryAttempts).toBe(1)
            expect(watchdogStep(w, 3)).toBe("retry")
            expect(w.recoveryAttempts).toBe(2)
        })

        test("watchdog retry keeps the counter (no reset in the retry step)", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.status = "idle"
            w.recoveryAttempts = 1
            watchdogStep(w, 3)
            expect(w.recoveryAttempts).toBe(2)
            expect(w.pendingRecovery).toBe(true)
            expect(w.watchdogRetryGuard).toBe(false)
        })

        test("new detection after a completed cycle starts at 0", () => {
            detectStreamingFailure(w, "ProviderError", now)
            w.recoveryAttempts = 2
            resetSessionFlags(w)
            expect(w.recoveryAttempts).toBe(0)
            detectStreamingFailure(w, "TimeoutError", now + 5000)
            expect(w.recoveryAttempts).toBe(0)
            expect(w.pendingRecoveryReason).toBe("TimeoutError")
        })
    })
})
