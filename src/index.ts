/**
 * OpenCode Auto-Resume Plugin
 *
 * Detects when an LLM session stalls mid-stream and automatically
 * sends a continuation prompt.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionWatch {
    lastActivityAt: number
    status: "busy" | "idle" | "retry" | "unknown"
    userCancelled: boolean
    resumeAttempts: number
    lastRetryAt: number
    gaveUp: boolean
    orphanWatchStartAt: number | null
    aborting: boolean
    /** True if we already sent a tool-call-as-text recovery for this idle cycle. */
    toolTextRecovered: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_TIMEOUT_MS = 45_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000
const DEFAULT_GRACE_PERIOD_MS = 3_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_BACKOFF_MS = 8_000
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_SUBAGENT_WAIT_MS = 15_000
const ABORT_CONTINUE_DELAY_MS = 2_000
const DEFAULT_LOOP_MAX_CONTINUES = 3
const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000

/** Delay after session goes idle before checking for tool-call-as-text. */
const TOOL_TEXT_CHECK_DELAY_MS = 1_500

// ---------------------------------------------------------------------------
// Patterns that indicate a tool call was printed as text, not executed.
// These are raw XML tags that appear in the model's text output when it
// "forgets" to use the tool calling mechanism.
// ---------------------------------------------------------------------------

const TOOL_TEXT_PATTERNS = [
    /<function\s*=/i,
/<function>/i,
/<\/function>/i,
/<parameter\s*=/i,
/<parameter>/i,
/<\/parameter>/i,
]

function containsToolCallAsText(text: string): boolean {
    return TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const AutoResumePlugin: Plugin = async (ctx, options) => {
    const chunkTimeoutMs: number =
    (options?.chunkTimeoutMs as number) ?? DEFAULT_CHUNK_TIMEOUT_MS
    const checkIntervalMs: number =
    (options?.checkIntervalMs as number) ?? DEFAULT_CHECK_INTERVAL_MS
    const gracePeriodMs: number =
    (options?.gracePeriodMs as number) ?? DEFAULT_GRACE_PERIOD_MS
    const maxRetries: number =
    (options?.maxRetries as number) ?? DEFAULT_MAX_RETRIES
    const maxBackoffMs: number =
    (options?.maxBackoffMs as number) ?? DEFAULT_MAX_BACKOFF_MS
    const baseBackoffMs: number =
    (options?.baseBackoffMs as number) ?? DEFAULT_BASE_BACKOFF_MS
    const subagentWaitMs: number =
    (options?.subagentWaitMs as number) ?? DEFAULT_SUBAGENT_WAIT_MS
    const loopMaxContinues: number =
    (options?.loopMaxContinues as number) ?? DEFAULT_LOOP_MAX_CONTINUES
    const loopWindowMs: number =
    (options?.loopWindowMs as number) ?? DEFAULT_LOOP_WINDOW_MS

    const sessions = new Map<string, SessionWatch>()
    let timer: ReturnType<typeof setInterval> | null = null
    let initialised = false
    let prevBusyCount = 0

    // -----------------------------------------------------------------
    // Hallucination loop detection
    // -----------------------------------------------------------------

    const continueTimestamps: number[] = []

    function recordContinue() {
        continueTimestamps.push(Date.now())
        const cutoff = Date.now() - loopWindowMs
        while (continueTimestamps.length > 0 && continueTimestamps[0] < cutoff) {
            continueTimestamps.shift()
        }
    }

    function isHallucinationLoop(): boolean {
        recordContinue()
        return continueTimestamps.length >= loopMaxContinues
    }

    // -----------------------------------------------------------------------
    // Logging
    // -----------------------------------------------------------------------

    async function log(level: "debug" | "info" | "warn" | "error", msg: string) {
        try {
            await ctx.client.app.log({
                body: { service: "auto-resume", level, message: msg },
            })
        } catch {
            // NEVER console.log
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function ensureWatch(sid: string): SessionWatch {
        let w = sessions.get(sid)
        if (!w) {
            w = {
                lastActivityAt: Date.now(),
                status: "unknown",
                userCancelled: false,
                resumeAttempts: 0,
                lastRetryAt: 0,
                gaveUp: false,
                orphanWatchStartAt: null,
                aborting: false,
                toolTextRecovered: false,
            }
            sessions.set(sid, w)
        }
        return w
    }

    function touchAndPropagate() {
        const now = Date.now()
        for (const [, w] of sessions) {
            if (w.status === "busy" && !w.userCancelled) {
                w.lastActivityAt = now
                w.resumeAttempts = 0
                w.gaveUp = false
                w.orphanWatchStartAt = null
            }
        }
    }

    function busyCount(): number {
        let count = 0
        for (const [, w] of sessions) {
            if (w.status === "busy" && !w.userCancelled) count++
        }
        return count
    }

    function getLoneBusySession(): { sid: string; w: SessionWatch } | null {
        let found: { sid: string; w: SessionWatch } | null = null
        let count = 0
        for (const [sid, w] of sessions) {
            if (w.status === "busy" && !w.userCancelled) {
                count++
                found = { sid, w }
            }
        }
        return count === 1 ? found : null
    }

    function getSid(ev: Record<string, unknown>): string | undefined {
        const props = ev.properties as Record<string, unknown> | undefined
        return (
            (ev.sessionID as string | undefined) ??
            (props?.sessionID as string | undefined) ??
            ((props?.part as Record<string, unknown>)?.sessionID as string | undefined) ??
            ((props?.info as Record<string, unknown>)?.sessionID as string | undefined)
        )
    }

    function getError(ev: Record<string, unknown>): Record<string, unknown> | undefined {
        const props = ev.properties as Record<string, unknown> | undefined
        return (
            (ev.error as Record<string, unknown> | undefined) ??
            (props?.error as Record<string, unknown> | undefined)
        )
    }

    function getStatus(ev: Record<string, unknown>): Record<string, unknown> | undefined {
        const props = ev.properties as Record<string, unknown> | undefined
        return (
            (ev.status as Record<string, unknown> | undefined) ??
            (props?.status as Record<string, unknown> | undefined)
        )
    }

    function short(sid: string): string {
        return sid.length > 12 ? `...${sid.slice(-8)}` : sid
    }

    function backoffMs(attempt: number): number {
        return Math.min(baseBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs)
    }

    // -----------------------------------------------------------------------
    // Tool-call-as-text detection
    //
    // When a session goes idle, fetch the last messages and check if the
    // model printed tool call XML as plain text instead of executing it.
    // If detected, send "continue" to prompt the model to re-execute.
    // -----------------------------------------------------------------------

    async function checkForToolCallAsText(sid: string, w: SessionWatch) {
        if (w.userCancelled || w.toolTextRecovered) return
            if (busyCount() > 0) return // don't interfere if other sessions are busy

                await log("debug", `${short(sid)} - checking for tool-call-as-text`)

                try {
                    const response = await ctx.client.session.messages({
                        path: { id: sid },
                    })

                    const data = response as Record<string, unknown>
                    // The response could be an array or an object with a data/messages field.
                    let messages: Array<Record<string, unknown>> = []
                    if (Array.isArray(data)) {
                        messages = data
                    } else if (Array.isArray(data.data)) {
                        messages = data.data
                    } else if (Array.isArray(data.messages)) {
                        messages = data.messages
                    }

                    // Check the last 3 messages (look at the most recent assistant messages).
                    const recent = messages.slice(-3)

                    for (const msg of recent) {
                        const role = msg.role as string | undefined
                        if (role !== "assistant") continue

                            // Check text parts for raw tool-call XML.
                            const parts = msg.parts as Array<Record<string, unknown>> | undefined
                            if (!parts) continue

                                for (const part of parts) {
                                    if (part.type !== "text") continue
                                        const text = (part.text as string) ?? ""
                                        if (text.length > 10 && containsToolCallAsText(text)) {
                                            w.toolTextRecovered = true
                                            await log(
                                                "info",
                                                `Tool-call-as-text detected on ${short(sid)}! ` +
                                                `Model printed a tool call instead of executing it. Sending continue...`
                                            )

                                            // Check hallucination loop before sending.
                                            if (isHallucinationLoop()) {
                                                await log("warn", `Hallucination loop detected — aborting instead`)
                                                await tryAbortAndResume(sid, w)
                                            } else {
                                                try {
                                                    await ctx.client.session.prompt({
                                                        path: { id: sid },
                                                        body: { parts: [{ type: "text", text: "continue" }] },
                                                    })
                                                    recordContinue()
                                                    await log("info", `${short(sid)} - tool-call-as-text recovery: continue sent`)
                                                } catch (err) {
                                                    const msg = err instanceof Error ? err.message : String(err)
                                                    await log("warn", `${short(sid)} - tool-call-as-text recovery failed: ${msg}`)
                                                }
                                            }
                                            return // only send once per idle cycle
                                        }
                                }
                    }
                } catch (err) {
                    // If we can't fetch messages, just skip silently.
                    const msg = err instanceof Error ? err.message : String(err)
                    log("debug", `${short(sid)} - could not fetch messages: ${msg}`)
                }
    }

    // -----------------------------------------------------------------------
    // Abort + Continue
    // -----------------------------------------------------------------------

    async function tryAbortAndResume(sid: string, w: SessionWatch): Promise<boolean> {
        if (w.aborting) return false
            w.aborting = true

            const idleSec = Math.round((Date.now() - (w.orphanWatchStartAt ?? w.lastActivityAt)) / 1000)
            await log("info", `Abort+Resume on ${short(sid)} (${idleSec}s idle). Aborting...`)

            try {
                await ctx.client.session.abort({ sessionID: sid })
                await log("info", `${short(sid)} - abort OK`)
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                await log("warn", `${short(sid)} - abort failed: ${msg}`)
                w.aborting = false
                return false
            }

            await new Promise<void>((resolve) => setTimeout(resolve, ABORT_CONTINUE_DELAY_MS))

            if (w.status === "busy") w.status = "idle"

                try {
                    await ctx.client.session.prompt({
                        path: { id: sid },
                        body: { parts: [{ type: "text", text: "continue" }] },
                    })
                    recordContinue()
                    await log("info", `${short(sid)} - abort+continue done`)
                    w.lastRetryAt = Date.now()
                    w.orphanWatchStartAt = null
                    w.resumeAttempts++
                    w.aborting = false
                    return true
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    await log("warn", `${short(sid)} - continue after abort failed: ${msg}`)
                    w.aborting = false
                    return false
                }
    }

    // -----------------------------------------------------------------------
    // Resume: normal stall
    // -----------------------------------------------------------------------

    async function tryResume(sid: string, w: SessionWatch, reason: string): Promise<boolean> {
        const now = Date.now()
        const elapsedSinceRetry = now - w.lastRetryAt
        const requiredBackoff = backoffMs(w.resumeAttempts)
        if (w.lastRetryAt > 0 && elapsedSinceRetry < requiredBackoff) return false

            if (isHallucinationLoop()) {
                await log("warn", `Hallucination loop on ${short(sid)}! Aborting...`)
                return await tryAbortAndResume(sid, w)
            }

            w.resumeAttempts++
            const idleSec = Math.round((now - w.lastActivityAt) / 1000)
            await log("info", `${reason} on ${short(sid)} (${idleSec}s, retry ${w.resumeAttempts}/${maxRetries})`)

            try {
                await ctx.client.session.prompt({
                    path: { id: sid },
                    body: { parts: [{ type: "text", text: "continue" }] },
                })
                recordContinue()
                await log("info", `${short(sid)} - retry sent`)
                w.lastRetryAt = now
                return true
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                await log("warn", `${short(sid)} - retry failed: ${msg}`)
                w.lastRetryAt = now
                return false
            }
    }

    // -----------------------------------------------------------------------
    // Timer
    // -----------------------------------------------------------------------

    function startTimer() {
        if (timer) return
            timer = setInterval(() => {
                const now = Date.now()
                const numBusy = busyCount()

                for (const [sid, w] of sessions) {
                    if (w.status !== "busy") continue
                        if (w.userCancelled) continue
                            if (w.aborting) continue

                                if (w.orphanWatchStartAt !== null) {
                                    const orphanIdle = now - w.orphanWatchStartAt
                                    if (orphanIdle >= subagentWaitMs + gracePeriodMs) {
                                        if (w.resumeAttempts < maxRetries) {
                                            tryAbortAndResume(sid, w)
                                        } else if (!w.gaveUp) {
                                            w.gaveUp = true
                                            w.orphanWatchStartAt = null
                                            w.aborting = false
                                            log("warn", `${short(sid)} - orphan retries exhausted.`)
                                        }
                                    }
                                    continue
                                }

                                if (numBusy > 1) continue

                                    const idle = now - w.lastActivityAt
                                    if (idle >= chunkTimeoutMs + gracePeriodMs) {
                                        if (w.resumeAttempts < maxRetries) {
                                            tryResume(sid, w, "Stream stall")
                                        } else if (!w.gaveUp) {
                                            w.gaveUp = true
                                            log("warn", `${short(sid)} - all ${maxRetries} retries exhausted.`)
                                        }
                                    }
                }
            }, checkIntervalMs)

            if (timer.unref) timer.unref()
    }

    startTimer()

    // -----------------------------------------------------------------------
    // Event handler
    // -----------------------------------------------------------------------

    function handleEvent(ev: Record<string, unknown>) {
        const type = ev.type as string
        const sid = getSid(ev)

        if (sid) {
            const w = sessions.get(sid)
            if (w && (w.status === "busy" || w.status === "unknown")) {
                touchAndPropagate()
            }
        }

        switch (type) {
            case "session.status": {
                if (!sid) break
                    const status = getStatus(ev)
                    const statusType = (status?.type as string) ?? "unknown"
                    const w = ensureWatch(sid)
                    w.status = statusType as SessionWatch["status"]

                    if (statusType === "busy") {
                        touchAndPropagate()
                        w.userCancelled = false
                        w.resumeAttempts = 0
                        w.gaveUp = false
                        w.orphanWatchStartAt = null
                        w.aborting = false
                        w.toolTextRecovered = false
                        log("debug", `${short(sid)} -> busy (${busyCount()})`)
                    } else if (statusType === "idle") {
                        w.status = "idle"
                        w.userCancelled = false
                        w.aborting = false

                        const currentBusy = busyCount()
                        if (prevBusyCount > 1 && currentBusy === 1) {
                            const lone = getLoneBusySession()
                            if (lone && lone.w.orphanWatchStartAt === null) {
                                lone.w.orphanWatchStartAt = Date.now()
                                log("info", `Subagent finished, parent ${short(lone.sid)} stuck. Orphan watch (${subagentWaitMs / 1000}s).`)
                            }
                        }
                        prevBusyCount = currentBusy
                        log("debug", `${short(sid)} -> idle (${currentBusy})`)

                        // =============================================================
                        // TOOL-CALL-AS-TEXT CHECK (v7.1):
                        // After a short delay, check if the model printed tool calls
                        // as text instead of executing them.
                        // =============================================================
                        if (!w.toolTextRecovered && w.resumeAttempts < maxRetries) {
                            setTimeout(() => {
                                checkForToolCallAsText(sid, w)
                            }, TOOL_TEXT_CHECK_DELAY_MS)
                        }
                    } else if (statusType === "retry") {
                        touchAndPropagate()
                        log("debug", `${short(sid)} -> provider retry`)
                    }
                    break
            }

            case "session.created": {
                if (!sid) break
                    ensureWatch(sid)
                    log("debug", `New session: ${short(sid)} (${sessions.size})`)
                    break
            }

            case "session.updated": {
                if (sid) ensureWatch(sid)
                    break
            }

            case "session.idle": {
                if (!sid) break
                    const w = sessions.get(sid)
                    if (w) {
                        w.status = "idle"
                        w.userCancelled = false
                        w.orphanWatchStartAt = null
                        w.aborting = false

                        // Also check for tool-call-as-text on legacy idle event.
                        if (!w.toolTextRecovered && w.resumeAttempts < maxRetries) {
                            setTimeout(() => {
                                checkForToolCallAsText(sid, w)
                            }, TOOL_TEXT_CHECK_DELAY_MS)
                        }
                    }
                    break
            }

            case "session.error": {
                const errorObj = getError(ev)
                const errorName = (errorObj?.name as string) ?? ""
                const isMessageAborted = errorName === "MessageAbortedError"

                if (isMessageAborted) {
                    for (const [wSid, w] of sessions) {
                        if (w.status === "busy") {
                            w.userCancelled = true
                            w.status = "idle"
                            w.orphanWatchStartAt = null
                            w.aborting = false
                        }
                    }
                    log("info", "User abort (ESC)")
                    break
                }

                if (busyCount() === 0) break

                    const errorMessage =
                    (errorObj?.data as Record<string, unknown>)?.message as string | undefined ??
                    String(errorObj?.data ?? "")
                    log("debug", `Session error: ${errorName} - ${errorMessage}`)
                    break
            }

            case "command.executed": {
                for (const [, w] of sessions) {
                    w.userCancelled = false
                    w.resumeAttempts = 0
                    w.gaveUp = false
                    w.orphanWatchStartAt = null
                    w.aborting = false
                    w.toolTextRecovered = false
                }
                break
            }
        }
    }

    // -----------------------------------------------------------------------
    // Returned hooks
    // -----------------------------------------------------------------------

    return {
        event: async ({ event }) => {
            if (!initialised) {
                initialised = true
                log("info", `v7.1 ready. timeout=${chunkTimeoutMs}ms, orphan=${subagentWaitMs}ms, loop=${loopMaxContinues}x/${loopWindowMs / 1000}s`)
            }
            handleEvent(event as Record<string, unknown>)
        },

        config: async () => {
            log("info", `v7.1 config OK`)
        },

        tool: {
            resume: tool({
                description: "Manually resume a stalled LLM session.",
                args: {
                    prompt: tool.schema.string().optional().describe("Continuation prompt. Defaults to 'continue'."),
                         session_id: tool.schema.string().optional().describe("Target session ID."),
                },
                async execute(args, toolCtx) {
                    let targetSid = (args.session_id as string) ?? toolCtx.sessionID

                    if (!targetSid) {
                        let orphan: { sid: string; w: SessionWatch } | null = null
                        let best: { sid: string; last: number } | null = null
                        for (const [sid, w] of sessions) {
                            if (w.status === "busy") {
                                if (w.orphanWatchStartAt !== null && !orphan) orphan = { sid, w }
                                if (w.lastActivityAt > 0 && (!best || w.lastActivityAt > best.last)) {
                                    best = { sid, last: w.lastActivityAt }
                                }
                            }
                        }
                        targetSid = orphan?.sid ?? best?.sid
                        if (!targetSid) return "No active stalled session found."
                    }

                    const w = sessions.get(targetSid)
                    const text = (args.prompt as string) ?? "continue"
                    log("info", `Manual resume on ${short(targetSid)}: "${text}"`)

                    try {
                        await ctx.client.session.prompt({
                            path: { id: targetSid },
                            body: { agent: toolCtx.agent, parts: [{ type: "text", text }] },
                        })
                        recordContinue()
                        if (w) { w.orphanWatchStartAt = null; w.resumeAttempts = 0; w.toolTextRecovered = false }
                        return `Resume sent to ${short(targetSid)}: "${text}"`
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        return `Failed: ${msg}`
                    }
                },
            }),
        },
    }
}

export default AutoResumePlugin
