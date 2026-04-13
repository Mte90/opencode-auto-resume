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
    toolTextRecovered: boolean
    toolTextAttempts: number
    continueTimestamps: number[]
    idleSince: number | null
    continuing: boolean
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

/** Max idle sessions to keep in memory before cleanup. */
const MAX_IDLE_SESSIONS = 50

/** How long an idle session stays in memory before cleanup (10 min). */
const IDLE_CLEANUP_MS = 10 * 60_000

/** Interval for periodic session discovery via session.list(). */
const SESSION_DISCOVERY_INTERVAL_MS = 60_000

/** Specific recovery prompt for tool-call-as-text. */
const TOOL_TEXT_RECOVERY_PROMPT =
    "Your last message contained a raw tool call printed as text instead of being executed. " +
    "Please use the proper tool calling mechanism to execute it."

/** Recovery prompt for function calls stuck in thinking (ReasoningPart). */
const THINKING_TOOL_RECOVERY_PROMPT =
    "I noticed you have a tool call generated in your thinking/reasoning. " +
    "Please execute it using the proper tool calling mechanism instead of keeping it in reasoning."

// ---------------------------------------------------------------------------
// Patterns that indicate a tool call was printed as text, not executed.
// v8.0: Expanded to cover truncated tags, alternative formats, and partial XML.
// ---------------------------------------------------------------------------

const TOOL_TEXT_PATTERNS = [
    // Standard Anthropic-style function tags
    /<function\s*=/i,
    /<function>/i,
    /<\/function>/i,
    /<parameter\s*=/i,
    /<parameter>/i,
    /<\/parameter>/i,
    // Alternative tool call formats
    /<tool_call[\s>]/i,
    /<\/tool_call>/i,
    /<tool[\s_]name\s*=/i,
    /<invoke\s+/i,
    // Truncated/incomplete tags (generation cut off mid-tag)
    /<func(?:t|ti|tio|tion)?$/im,
    /<par(?:a|am|ame|amet|amete|ameter)?$/im,
    // XML tool blocks with common tool names
    /<(?:edit|write|read|bash|grep|glob|search|replace|execute|run)\s*(?:\s[^>]*)?\s*(?:\/>|>)/i,
]

/** Patterns for truncated XML (opened but never closed in the same text). */
const TRUNCATED_XML_PATTERNS = [
    // Opening tag without matching close (within reasonable text length)
    { open: /<function[^>]*>/i, close: /<\/function>/i },
    { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
    { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
]

/**
 * Patterns that indicate the agent is waiting to continue but didn't actually send the continue prompt.
 * These appear at the end of assistant messages when the model says it will continue but doesn't.
 */
const READY_TO_CONTINUE_PATTERNS = [
    /ready to continue with task/i,
    /continuing with task/i,
    /continue with task/i,
    /proceeding with task/i,
    /ready to proceed with task/i,
    /will continue with task/i,
    /moving on to task/i,
]

function containsToolCallAsText(text: string): boolean {
    if (text.length <= 10) return false

    // Check direct pattern matches
    if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))) return true

    // Check for truncated XML: opening tag present but no closing tag
    for (const { open, close } of TRUNCATED_XML_PATTERNS) {
        if (open.test(text) && !close.test(text)) return true
    }

    return false
}

/**
 * Check if the last line of the message contains "ready to continue" patterns.
 * These indicate the model says it will continue but doesn't actually send the prompt.
 */
function containsReadyToContinuePattern(text: string): boolean {
    const lines = text.split('\n')
    const lastLine = lines[lines.length - 1]?.trim()
    if (!lastLine) return false
    
    // Check only last 3 lines for the pattern (model usually says it at the end)
    const lastLines = lines.slice(-3).join('\n')
    return READY_TO_CONTINUE_PATTERNS.some((pat) => pat.test(lastLines))
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
    let discoveryTimer: ReturnType<typeof setInterval> | null = null
    let initialised = false
    let prevBusyCount = 0

    // -----------------------------------------------------------------
    // Per-session hallucination loop detection (v8.0)
    // -----------------------------------------------------------------

    function recordContinue(sid: string): void {
        const w = sessions.get(sid)
        if (!w) return
        w.continueTimestamps.push(Date.now())
        const cutoff = Date.now() - loopWindowMs
        while (w.continueTimestamps.length > 0 && w.continueTimestamps[0] < cutoff) {
            w.continueTimestamps.shift()
        }
    }

    function isHallucinationLoop(sid: string): boolean {
        const w = sessions.get(sid)
        if (!w) return false
        recordContinue(sid)
        return w.continueTimestamps.length >= loopMaxContinues
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
                toolTextAttempts: 0,
                continueTimestamps: [],
                idleSince: null,
                continuing: false,
            }
            sessions.set(sid, w)
        }
        return w
    }

    /** v8.0: Only touch the specific session that emitted the event.
     *  Previously this reset ALL busy sessions, masking real stalls
     *  when a subagent was active. */
    function touchSession(sid: string) {
        const w = sessions.get(sid)
        if (w && w.status === "busy" && !w.userCancelled) {
            w.lastActivityAt = Date.now()
            // Don't reset resumeAttempts here — only reset on new busy status
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

    /** v8.0: Clean up idle sessions that have been idle too long. */
    function cleanupIdleSessions() {
        const now = Date.now()
        const toDelete: string[] = []
        let idleCount = 0

        for (const [sid, w] of sessions) {
            if (w.status !== "busy") {
                idleCount++
                if (w.idleSince && (now - w.idleSince) > IDLE_CLEANUP_MS) {
                    toDelete.push(sid)
                }
            }
        }

        // Also prune if too many idle sessions
        if (idleCount > MAX_IDLE_SESSIONS) {
            const idleEntries: Array<{ sid: string; idleSince: number }> = []
            for (const [sid, w] of sessions) {
                if (w.status !== "busy" && w.idleSince) {
                    idleEntries.push({ sid, idleSince: w.idleSince })
                }
            }
            idleEntries.sort((a, b) => a.idleSince - b.idleSince)
            const excess = idleCount - MAX_IDLE_SESSIONS
            for (let i = 0; i < excess && i < idleEntries.length; i++) {
                if (!toDelete.includes(idleEntries[i].sid)) {
                    toDelete.push(idleEntries[i].sid)
                }
            }
        }

        for (const sid of toDelete) {
            sessions.delete(sid)
        }
        if (toDelete.length > 0) {
            log("debug", `Cleaned up ${toDelete.length} idle session(s). Map size: ${sessions.size}`)
        }
    }

    async function sendContinuePrompt(sid: string, text: string, w: SessionWatch) {
        if (w.continuing) {
            await log("debug", `${short(sid)} - continue already in progress, skipping`)
            return
        }
        w.continuing = true
        try {
            await ctx.client.session.prompt({
                path: { id: sid },
                body: { parts: [{ type: "text", text }] },
            })
            recordContinue(sid)
            w.lastRetryAt = Date.now()
        } finally {
            w.continuing = false
        }
    }

    function extractMessages(response: Record<string, unknown>): Array<Record<string, unknown>> {
        if (Array.isArray(response)) return response
        if (Array.isArray(response.data)) return response.data
        if (Array.isArray(response.messages)) return response.messages
        return []
    }

    async function checkSubagentCrashed(parentSid: string): Promise<boolean> {
        try {
            const response = await ctx.client.session.list()
            const sessions = extractMessages(response as Record<string, unknown>)
            
            for (const s of sessions) {
                const sId = s.id as string
                if (!sId || sId === parentSid) continue
                
                const status = s.status as string
                if (status === "busy") {
                    const msgResponse = await ctx.client.session.messages({ path: { id: sId } })
                    const messages = extractMessages(msgResponse as Record<string, unknown>)
                    const lastMsg = messages[messages.length - 1]
                    
                    if (lastMsg && lastMsg.role === "assistant" && "error" in lastMsg) {
                        const error = lastMsg.error as Record<string, unknown> | undefined
                        const errorName = error?.name as string | undefined
                        await log("debug", `Subagent ${short(sId)} appears crashed: ${errorName}`)
                        return true
                    }
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("debug", `checkSubagentCrashed failed: ${errMsg}`)
        }
        return false
    }

    function resetSessionFlags(w: SessionWatch) {
        w.userCancelled = false
        w.resumeAttempts = 0
        w.gaveUp = false
        w.orphanWatchStartAt = null
        w.aborting = false
        w.toolTextRecovered = false
        w.toolTextAttempts = 0
        w.continueTimestamps = []
        w.idleSince = null
        w.continuing = false
    }

    function resetIdleFlags(w: SessionWatch) {
        w.userCancelled = false
        w.aborting = false
        w.orphanWatchStartAt = null
        w.idleSince = Date.now()
    }

    // -----------------------------------------------------------------------
    // Tool-call-as-text detection (v8.0: no busyCount guard, backoff,
    // specific recovery prompt)
    // -----------------------------------------------------------------------

    async function checkForToolCallAsText(sid: string, w: SessionWatch) {
        if (typeof sid !== "string" || !sid) return
        if (w.userCancelled || w.toolTextRecovered) return

        // v8.0: Backoff for tool-text recovery
        if (w.toolTextAttempts > 0) {
            const elapsed = Date.now() - w.lastRetryAt
            const requiredBackoff = backoffMs(w.toolTextAttempts)
            if (elapsed < requiredBackoff) return
        }

        // v8.0: Cap tool-text attempts like regular retries
        if (w.toolTextAttempts >= maxRetries) return

        await log("debug", `${short(sid)} - checking for tool-call-as-text (attempt ${w.toolTextAttempts + 1})`)

        try {
            const response = await ctx.client.session.messages({
                path: { id: sid },
            })
            const messages = extractMessages(response as Record<string, unknown>)
            const recent = messages.slice(-3)

            for (const msg of recent) {
                const role = msg.role as string | undefined
                if (role !== "assistant") continue

                const parts = msg.parts as Array<Record<string, unknown>> | undefined
                if (!parts) continue

                for (const part of parts) {
                    const partType = part.type as string
                    let text = ""
                    let isReasoning = false

                    if (partType === "text") {
                        text = (part.text as string) ?? ""
                    } else if (partType === "reasoning") {
                        text = (part.text as string) ?? ""
                        isReasoning = true
                    } else {
                        continue
                    }
                    
                    if (containsToolCallAsText(text)) {
                        w.toolTextRecovered = true
                        w.toolTextAttempts++
                        
                        const prompt = isReasoning ? THINKING_TOOL_RECOVERY_PROMPT : TOOL_TEXT_RECOVERY_PROMPT
                        const source = isReasoning ? "reasoning" : "text"
                        
                        await log(
                            "info",
                            `Tool-call-as-text in ${source} detected on ${short(sid)}! ` +
                            `Attempt ${w.toolTextAttempts}/${maxRetries}. Sending recovery prompt...`
                        )

                        if (isHallucinationLoop(sid)) {
                            await log("warn", `Hallucination loop detected on ${short(sid)} — aborting instead`)
                            await tryAbortAndResume(sid, w)
                        } else {
                            try {
                                await sendContinuePrompt(sid, prompt, w)
                                await log("info", `${short(sid)} - tool-call-as-text recovery sent (attempt ${w.toolTextAttempts})`)
                            } catch (err) {
                                const errMsg = err instanceof Error ? err.message : String(err)
                                await log("warn", `${short(sid)} - tool-call-as-text recovery failed: ${errMsg}`)
                            }
                        }
                        return
                    }
                    
                    if (containsReadyToContinuePattern(text)) {
                        w.toolTextRecovered = true
                        w.toolTextAttempts++
                        await log(
                            "info",
                            `Ready-to-continue pattern detected on ${short(sid)}! ` +
                            `Attempt ${w.toolTextAttempts}/${maxRetries}. Sending continue...`
                        )

                        if (isHallucinationLoop(sid)) {
                            await log("warn", `Hallucination loop detected on ${short(sid)} — aborting instead`)
                            await tryAbortAndResume(sid, w)
                        } else {
                            try {
                                await sendContinuePrompt(sid, "continue", w)
                                await log("info", `${short(sid)} - ready-to-continue recovery sent (attempt ${w.toolTextAttempts})`)
                            } catch (err) {
                                const errMsg = err instanceof Error ? err.message : String(err)
                                await log("warn", `${short(sid)} - ready-to-continue recovery failed: ${errMsg}`)
                            }
                        }
                        return
                    }
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            log("debug", `${short(sid)} - could not fetch messages: ${errMsg}`)
        }
    }

    // -----------------------------------------------------------------------
    // Abort + Continue
    // -----------------------------------------------------------------------

    async function tryAbortAndResume(sid: string, w: SessionWatch): Promise<boolean> {
        if (typeof sid !== "string" || !sid) return false
        if (w.aborting) return false
        w.aborting = true

        const idleSec = Math.round((Date.now() - (w.orphanWatchStartAt ?? w.lastActivityAt)) / 1000)
        await log("info", `Abort+Resume on ${short(sid)} (${idleSec}s idle). Aborting...`)

        try {
            await ctx.client.session.abort({ sessionID: sid })
            await log("info", `${short(sid)} - abort OK`)
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `${short(sid)} - abort failed: ${errMsg}`)
            w.aborting = false
            return false
        }

        await new Promise<void>((resolve) => setTimeout(resolve, ABORT_CONTINUE_DELAY_MS))

        if (w.status === "busy") w.status = "idle"

        try {
            await sendContinuePrompt(sid, "continue", w)
            await log("info", `${short(sid)} - abort+continue done`)
            w.orphanWatchStartAt = null
            w.resumeAttempts++
            w.aborting = false
            return true
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `${short(sid)} - continue after abort failed: ${errMsg}`)
            w.aborting = false
            return false
        }
    }

    // -----------------------------------------------------------------------
    // Resume: normal stall
    // -----------------------------------------------------------------------

    async function tryResume(sid: string, w: SessionWatch, reason: string): Promise<boolean> {
        if (typeof sid !== "string" || !sid) {
            await log("warn", `tryResume called with invalid sid: ${sid}`)
            return false
        }
        const now = Date.now()
        const elapsedSinceRetry = now - w.lastRetryAt
        const requiredBackoff = backoffMs(w.resumeAttempts)
        if (w.lastRetryAt > 0 && elapsedSinceRetry < requiredBackoff) return false

        if (isHallucinationLoop(sid)) {
            await log("warn", `Hallucination loop on ${short(sid)}! Aborting...`)
            return await tryAbortAndResume(sid, w)
        }

        w.resumeAttempts++
        const idleSec = Math.round((now - w.lastActivityAt) / 1000)
        await log("info", `${reason} on ${short(sid)} (${idleSec}s, retry ${w.resumeAttempts}/${maxRetries})`)

        try {
            await sendContinuePrompt(sid, "continue", w)
            await log("info", `${short(sid)} - retry sent`)
            return true
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `${short(sid)} - retry failed: ${errMsg}`)
            w.lastRetryAt = now
            return false
        }
    }

    async function discoverSessions() {
        try {
            const response = await ctx.client.session.list()
            const list = extractMessages(response as Record<string, unknown>)

            for (const s of list) {
                const sid = s.id as string
                if (sid) {
                    const isNew = !sessions.has(sid)
                    ensureWatch(sid)
                    const status = s.status as string | undefined
                    if (status) {
                        const w = sessions.get(sid)!
                        w.status = status as SessionWatch["status"]
                        if (status === "idle") w.idleSince = Date.now()
                    }
                    if (isNew) {
                        log("debug", `Discovered session ${short(sid)} via list()`)
                    }
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            log("debug", `Session discovery failed: ${errMsg}`)
        }
    }

    // -----------------------------------------------------------------------
    // Timer (v8.0: cleanup + session discovery)
    // -----------------------------------------------------------------------

    function startTimer() {
        if (timer) return
        timer = setInterval(async () => {
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
                            const crashed = await checkSubagentCrashed(sid)
                            if (crashed) {
                                await log("info", `Subagent crashed, triggering abort+resume on ${short(sid)}`)
                                tryAbortAndResume(sid, w)
                            } else {
                                await log("debug", `Subagent still running, waiting...`)
                            }
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

            // v8.0: Periodic cleanup
            cleanupIdleSessions()
        }, checkIntervalMs)

        if (timer.unref) timer.unref()

        // v8.0: Periodic session discovery
        discoveryTimer = setInterval(() => {
            discoverSessions()
        }, SESSION_DISCOVERY_INTERVAL_MS)
        if (discoveryTimer.unref) discoveryTimer.unref()

        // Run initial discovery after a short delay
        setTimeout(discoverSessions, 5_000)
    }

    startTimer()

    // -----------------------------------------------------------------------
    // Event handler
    // -----------------------------------------------------------------------

    function handleEvent(ev: Record<string, unknown>) {
        const type = ev.type as string
        const sid = getSid(ev)

        // v8.0: Only touch the session that emitted the event
        if (sid) {
            touchSession(sid)
        }

        switch (type) {
            case "session.status": {
                if (!sid) break
                const status = getStatus(ev)
                const statusType = (status?.type as string) ?? "unknown"
                const w = ensureWatch(sid)
                w.status = statusType as SessionWatch["status"]

                if (statusType === "busy") {
                    w.lastActivityAt = Date.now()
                    resetSessionFlags(w)
                    log("debug", `${short(sid)} -> busy (${busyCount()})`)
                } else if (statusType === "idle") {
                    w.status = "idle"
                    resetIdleFlags(w)

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

                    // v8.0: TOOL-CALL-AS-TEXT CHECK — runs regardless of busyCount
                    if (!w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
                        setTimeout(() => {
                            checkForToolCallAsText(sid, w)
                        }, TOOL_TEXT_CHECK_DELAY_MS)
                    }
                } else if (statusType === "retry") {
                    touchSession(sid)
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
                    resetIdleFlags(w)

                    // v8.0: Also check for tool-call-as-text on legacy idle event
                    if (!w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
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
                            resetIdleFlags(w)
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
                    resetSessionFlags(w)
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
                log("info", `opencode-auto-resume ready. timeout=${chunkTimeoutMs}ms, orphan=${subagentWaitMs}ms, loop=${loopMaxContinues}x/${loopWindowMs / 1000}s`)
            }
            handleEvent(event as Record<string, unknown>)
        },

        config: async () => {
            log("info", `opencode-auto-resume config OK`)
            ctx.ui.toast({
                title: "Auto-Resume Plugin",
                message: `Loaded with ${chunkTimeoutMs}ms timeout, ${loopMaxContinues} loop attempts`,
                variant: "success",
                duration: 5000
            })
        },
    }
}

export default AutoResumePlugin
