import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

/**
 * A revert in OpenCode v1 has no event of its own.
 *
 * Verified live on 2026-10-01 against opencode v1.18.34 on a clean Arch LXC with
 * this plugin installed as the real thing: driving a turn, then POSTing
 * /session/:id/revert and /session/:id/unrevert, logging every event the `event`
 * hook received. The sequence was
 *
 *   session.created, session.updated, message.updated, message.part.updated,
 *   session.updated, session.status, message.updated, session.updated,
 *   session.diff, message.updated, session.updated
 *
 * and exactly one event carried the rewind:
 *
 *   session.updated   properties.info.revert = { messageID, partID?, snapshot?, diff? }
 *
 * There is no `session.reverted`, and no `session.revert.*` family either. The
 * `session.revert*` strings in the v1 binary are HTTP route identifiers
 * (`identifier: "session.revert"`, `"session.unrevert"`), not bus events — a plugin
 * that switches on the event name alone never learns the user rewound.
 */

type LogCall = { level: string; message: string }

function createMockContext() {
    const logCalls: LogCall[] = []
    const promptCalls: string[] = []
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
                prompt: mock(async (c: any) => {
                    promptCalls.push(c?.path?.id ?? "")
                    return {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls }
}

const FAST = {
    enabled: true,
    checkIntervalMs: 20,
    chunkTimeoutMs: 60,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 2,
    baseBackoffMs: 20,
    maxBackoffMs: 40,
    loopMaxContinues: 99,
    toolTextCheckDelayMs: 50_000,
    maxRecoveryRetries: 3,
    warmupMs: 60_000,
    // dbg() -> console.log so the drop is observable
    debug: true,
}

const SID = "ses_revertwatch"
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setup() {
    const { ctx, logCalls, promptCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, { ...FAST } as any)
    const dbgLines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
        dbgLines.push(args.join(" "))
    }
    const send = async (event: unknown) => {
        await hooks.event?.({ event } as any)
        await wait(10)
    }
    const restore = () => {
        console.log = origLog
    }
    const dispose = async () => {
        restore()
        await (hooks as any).dispose?.()
    }
    return { hooks, send, logCalls, promptCalls, dbgLines, restore, dispose }
}

/** session.error carrying a provider failure — this is what arms pendingRecovery. */
const streamError = (sid = SID) => ({
    type: "session.error",
    properties: { error: { name: "ProviderError", data: { message: "stream failed" } }, sessionID: sid },
})

const idleEvent = (sid = SID) => ({ type: "session.status", properties: { sessionID: sid, status: "idle" } })

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

/** session.status busy — this is what sets lastActivityAt. */
const busy = (sid = SID) => ({ type: "session.status", properties: { sessionID: sid, status: "busy" } })

/** session.updated with no revert payload. */
const plainUpdate = (sid = SID) => ({
    type: "session.updated",
    properties: { sessionID: sid, info: { sessionID: sid } },
})

/** session.updated carrying the revert — the only shape v1 ever sends. */
const revertUpdate = (sid = SID, revert: Record<string, unknown> = {}) => ({
    type: "session.updated",
    properties: {
        sessionID: sid,
        info: { sessionID: sid, revert: { messageID: "msg_target", ...revert } },
    },
})

const dropped = (dbgLines: string[]) => dbgLines.some((l) => l.includes("Revert on") && l.includes("dropping watch state"))

/**
 * The behavioral half of the fix, and the reason a debug-line assertion is not
 * enough on its own.
 *
 * The flag to watch is `userCancelled`, because it is the one piece of watch
 * state that a busy transition deliberately preserves (resetBusyFlags resets the
 * counters but PRESERVES userCancelled, to stop an ESC from being undone by the
 * next busy event). So it is state that survives only if the watch survives:
 *
 *   Esc -> userCancelled latched, auto-resume stands down for that session
 *   revert -> the watch is dropped, so the latch goes with it
 *   stall -> a fresh watch recovers the session again
 *
 * That is the real user-visible sequence: the user cancels a runaway turn,
 * rewinds it, re-asks, and auto-resume must work on the re-asked turn. Keep the
 * watch and the session is muted for good.
 */
async function setupStall() {
    const { ctx, promptCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, { ...FAST } as any)
    const dbgLines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
        dbgLines.push(args.join(" "))
    }
    const send = async (event: unknown) => {
        await hooks.event?.({ event } as any)
        await wait(10)
    }
    return {
        send,
        promptCalls,
        dbgLines,
        dispose: async () => {
            console.log = origLog
            await (hooks as any).dispose?.()
        },
    }
}

/** The user pressed Esc — the session is stood down until a real message arrives. */
const interrupted = (sid = SID) => ({ type: "session.status", properties: { sessionID: sid, status: "interrupted" } })

describe("v1 revert handling (verified live against opencode v1.18.34)", () => {
    test("info.revert on session.updated drops the watch state", async () => {
        const { send, dbgLines, dispose } = await setup()
        try {
            await send(busy())
            await send(plainUpdate())
            expect(dropped(dbgLines)).toBe(false)

            await send(revertUpdate())
            expect(dropped(dbgLines)).toBe(true)
        } finally {
            await dispose()
        }
    })

    test("the drop reports the counters it discarded", async () => {
        // resumeAttempts is nonzero at that point, so the debug line proves the
        // state being dropped was real — this is the actual bug.
        const { hooks, send, promptCalls, dbgLines, dispose } = await setup()
        try {
            await send(busy())
            await send(streamError())
            await send(idleEvent())
            // let the watchdog actually spend a retry
            expect(await waitFor(() => promptCalls.length >= 1)).toBe(true)

            await send(revertUpdate())
            const line = dbgLines.find((l) => l.includes("dropping watch state")) ?? ""
            expect(line).not.toBe("")
            // At least one recovery counter must be nonzero: the drop is discarding
            // real state, which is the whole bug. resumeAttempts is the watchdog
            // chain's counter; recoveryAttempts is the pending-recovery one, and
            // which of them moves depends on how the stall was detected.
            const ra = Number(line.match(/resumeAttempts=(\d+)/)?.[1] ?? 0)
            const rc = Number(line.match(/recoveryAttempts=(\d+)/)?.[1] ?? 0)
            expect(ra + rc).toBeGreaterThan(0)
        } finally {
            await dispose()
        }
    })

    test("after a revert the session is recoverable again", async () => {
        const { send, promptCalls, dispose } = await setupStall()
        try {
            // The user cancels a runaway turn.
            await send(busy())
            await send(interrupted())

            // The rewind.
            await send(revertUpdate())

            // The re-asked turn stalls. A fresh watch recovers it.
            await send(busy())
            expect(await waitFor(() => promptCalls.length >= 1, 3000)).toBe(true)
        } finally {
            await dispose()
        }
    })

    test("without the revert the cancel still stands (the control for the test above)", async () => {
        const { send, promptCalls, dispose } = await setupStall()
        try {
            await send(busy())
            await send(interrupted())

            // No revert this time — only a plain update.
            await send(plainUpdate())
            await send(busy())
            await wait(800)
            // userCancelled survived, so the session stays stood down. That is the
            // intended behavior of an ESC, and the reason the revert has to drop
            // the watch rather than merely reset a counter.
            expect(promptCalls.length).toBe(0)
        } finally {
            await dispose()
        }
    })

    test("a plain session.updated still ensures a watch", async () => {
        // Regression guard: the patch must not turn every update into a drop,
        // which would stop the watchdog ever seeing a session again.
        const { send, dbgLines, dispose } = await setup()
        try {
            for (let i = 0; i < 5; i++) await send(plainUpdate())
            expect(dropped(dbgLines)).toBe(false)
        } finally {
            await dispose()
        }
    })

    test("info.revert with partID and snapshot set is still a rewind", async () => {
        const { send, dbgLines, dispose } = await setup()
        try {
            await send(busy())
            await send(
                revertUpdate(SID, {
                    partID: "prt_123",
                    snapshot: "abc123",
                    diff: [{ file: "a.ts", additions: 1, deletions: 0 }],
                }),
            )
            expect(dropped(dbgLines)).toBe(true)
        } finally {
            await dispose()
        }
    })

    test("revert: null is NOT a rewind (the guard tests the value, not the key)", async () => {
        const { send, dbgLines, dispose } = await setup()
        try {
            await send(busy())
            await send({ type: "session.updated", properties: { sessionID: SID, info: { sessionID: SID, revert: null } } })
            expect(dropped(dbgLines)).toBe(false)
        } finally {
            await dispose()
        }
    })

    test("session.updated without a sessionID is a no-op, drop or not", async () => {
        const { send, dbgLines, dispose } = await setup()
        try {
            await send({ type: "session.updated", properties: { info: { revert: { messageID: "m" } } } })
            await wait(20)
            expect(dropped(dbgLines)).toBe(false)
        } finally {
            await dispose()
        }
    })
})
