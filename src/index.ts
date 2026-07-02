/**
 * OpenCode Auto-Resume Plugin
 * Detects when an LLM session stalls mid-stream and automatically sends a continuation prompt.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

interface Todo {
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    priority: "high" | "medium" | "low"
}

interface ToolCallRecord {
    toolName: string
    at: number
}

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
    todos: Todo[]
    todoCheckAttempts: number
    toolTextTimer: ReturnType<typeof setTimeout> | null
    checkingToolText: boolean
    lastSubagentCheckAt: number
    interruptedContinueCount: number
    recentToolCalls: ToolCallRecord[]
    toolLoopAttempts: number
    isSubagent: boolean
}

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
const TOOL_TEXT_CHECK_DELAY_MS = 3_000
const MAX_IDLE_SESSIONS = 50
const IDLE_CLEANUP_MS = 10 * 60_000
const SESSION_DISCOVERY_INTERVAL_MS = 60_000

const TOOL_TEXT_RECOVERY_PROMPT =
    "Your last message contained a raw tool call printed as text instead of being executed. " +
    "Please use the proper tool calling mechanism to execute it."

const THINKING_TOOL_RECOVERY_PROMPT =
    "I noticed you have a tool call generated in your thinking/reasoning. " +
    "Please execute it using the proper tool calling mechanism instead of keeping it in reasoning."

const TOOL_LOOP_RECOVERY_PROMPT =
    "I notice you've been calling the same tool multiple times in a row without making progress. " +
    "Please step back and reassess your approach. Consider: " +
    "1) Are you stuck in a loop? 2) Do you need different information first? " +
    "3) Should you try a different tool or break the task into smaller steps? " +
    "Take a moment to think about what's blocking you and propose a different strategy."

const TOOL_TEXT_PATTERNS = [
    /<function\s*=/i,
    /<function>/i,
    /<\/function>/i,
    /<parameter\s*=/i,
    /<parameter>/i,
    /<\/parameter>/i,
    /<tool_call[\s>]/i,
    /<\/tool_call>/i,
    /<tool[\s_]name\s*=/i,
    /<invoke\s+/i,
    /<func(?:t|ti|tio|tion)?$/im,
    /<par(?:a|am|ame|amet|amete|ameter)?$/im,
    /<(?:edit|write|read|bash|grep|glob|search|replace|execute|run)\s*(?:\s[^>]*)?\s*(?:\/>|>)/i,
    /{"type":\s*"function"/i,
    /{"name":\s*"[a-zA-Z_]/i,
    /\{\s*"type"\s*:?$/im,
    /\{\s*"name"\s*:?$/im,
]

const TRUNCATED_XML_PATTERNS = [
    { open: /<function[^>]*>/i, close: /<\/function>/i },
    { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
    { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
    { open: /\{\s*"type"\s*:/i, close: /}/ },
    { open: /\{\s*"name"\s*:/i, close: /}/ },
]

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
    if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(text))) return true
    for (const { open, close } of TRUNCATED_XML_PATTERNS) {
        if (open.test(text) && !close.test(text)) return true
    }
    return false
}

function containsReadyToContinuePattern(text: string): boolean {
    const lines = text.split('\n')
    const lastLine = lines[lines.length - 1]?.trim()
    if (!lastLine) return false
    const lastLines = lines.slice(-3).join('\n')
    return READY_TO_CONTINUE_PATTERNS.some((pat) => pat.test(lastLines))
}

const DONE_CLAIM_PATTERNS = [
    /^task\s+done[.!]*$/im,
    /^done[.!]*$/im,
    /^all\s+done[.!]*$/im,
    /^finished[.!]*$/im,
    /^complete[.!]*$/im,
    /^task\s+complete[.!]*$/im,
    /^task\s+completed[.!]*$/im,
    /^all\s+tasks?\s+complete[.!]*$/im,
    /^all\s+tasks?\s+completed[.!]*$/im,
    /^(?:i['']?m\s+)?done\s+with\s+task/im,
]

const DONE_WITHOUT_WORK_PROMPT =
    "I need you to verify more carefully that you have actually completed all the required tasks. " +
    "Your response indicated you're done, but no work was detected. Please check your todo list " +
    "and complete any remaining work."

function containsDoneClaimPattern(text: string): boolean {
    const lines = text.split('\n')
    const lastLines = lines.slice(-3).join('\n')
    return DONE_CLAIM_PATTERNS.some((pat) => pat.test(lastLines))
}

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
    // Per-session hallucination loop detection
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

    async function log(level: "debug" | "info" | "warn" | "error", msg: string) {
        try {
            await ctx.client.app.log({ body: { service: "auto-resume", level, message: msg } })
        } catch { /* ignore */ }
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
                todos: [],
                todoCheckAttempts: 0,
                toolTextTimer: null,
                checkingToolText: false,
                lastSubagentCheckAt: 0,
                interruptedContinueCount: 0,
                recentToolCalls: [],
                toolLoopAttempts: 0,
                isSubagent: false,
            }
            sessions.set(sid, w)
        }
        return w
    }

    function touchSession(sid: string) {
        const w = sessions.get(sid)
        if (w && w.status === "busy" && !w.userCancelled) {
            w.lastActivityAt = Date.now()
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
        const sid = (
            (ev.sessionID as string | undefined) ??
            (props?.sessionID as string | undefined) ??
            ((props?.part as Record<string, unknown>)?.sessionID as string | undefined) ??
            ((props?.info as Record<string, unknown>)?.sessionID as string | undefined)
        )
        if (sid && typeof sid === "string" && sid.startsWith("ses_")) {
            return sid
        }
        return undefined
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

    /** Clean up idle sessions that have been idle too long. */
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
            let agent: string | undefined
            let model: { providerID: string; modelID: string } | undefined

            const msgResp = await ctx.client.session.messages({ path: { id: sid } })
            const msgs = extractMessages(msgResp as Record<string, unknown>)

            for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i]
                const role =
                    (msg.role as string) ??
                    ((msg.info as Record<string, unknown> | undefined)?.role as string)
                if (role === "user") {
                    const rawAgent = msg.agent as string | undefined
                    if (typeof rawAgent === "string") {
                        agent = rawAgent
                    } else {
                        const fallbackAgent = (msg.info as Record<string, unknown> | undefined)?.agent as string | undefined
                        if (typeof fallbackAgent === "string") {
                            agent = fallbackAgent
                        }
                    }

                    let rawModel = msg.model as
                        | { providerID: string; modelID: string }
                        | undefined
                    if (!rawModel) {
                        rawModel = (msg.info as Record<string, unknown> | undefined)?.model as
                            | { providerID: string; modelID: string }
                            | undefined
                    }
                    if (
                        rawModel &&
                        typeof rawModel.providerID === "string" &&
                        typeof rawModel.modelID === "string"
                    ) {
                        model = {
                            providerID: rawModel.providerID,
                            modelID: rawModel.modelID,
                        }
                    }
                    break
                }
            }

            await ctx.client.session.prompt({
                path: { id: sid },
                body: {
                    parts: [{ type: "text", text }],
                    agent,
                    model,
                },
            })
            await log(
                "debug",
                `${short(sid)} - prompt sent with agent: ${agent ?? "(default)"}, model: ${model ? `${model.providerID}/${model.modelID}` : "(default)"}`,
            )
            recordContinue(sid)
            w.lastRetryAt = Date.now()
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `${short(sid)} - prompt failed: ${errMsg}`)
            try {
                await ctx.client.session.prompt({
                    path: { id: sid },
                    body: { parts: [{ type: "text", text }], agent, model },
                })
                recordContinue(sid)
                w.lastRetryAt = Date.now()
            } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
                await log("error", `${short(sid)} - prompt retry also failed: ${retryMsg}`)
                throw retryErr
            }
        } finally {
            w.continuing = false
            w.todoCheckAttempts = 0
            if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
        }
        // Deferred check: verify the session went busy after prompt
        setTimeout(async () => {
            if (w.status !== "busy") {
                await log("warn", `${short(sid)} - prompt sent >${TOOL_TEXT_CHECK_DELAY_MS / 1000}s ago but session is still ${w.status}`)
            }
        }, TOOL_TEXT_CHECK_DELAY_MS)
    }

    function extractMessages(response: Record<string, unknown>): Array<Record<string, unknown>> {
        if (Array.isArray(response)) return response
        if (Array.isArray(response.data)) return response.data
        if (Array.isArray(response.messages)) return response.messages
        return []
    }

        const SUBAGENT_STUCK_MS = 60_000

    const SUBAGENT_RECOVERY_PROMPT = "It looks like you may have stalled or timed out. Please retry the last operation or continue with the task."

    async function recoverSubagent(subagentSid: string): Promise<boolean> {
        try {
            await ctx.client.session.prompt({
                path: { id: subagentSid },
                body: { parts: [{ type: "text", text: SUBAGENT_RECOVERY_PROMPT }] },
            })
            await log("info", `Sent recovery prompt to subagent ${short(subagentSid)}`)
            return true
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `Failed to recover subagent ${short(subagentSid)}: ${errMsg}`)
            return false
        }
    }

    async function checkSubagentStatus(parentSid: string): Promise<{ status: "crashed" | "idle" | "busy" | "unknown"; stuckSid?: string }> {
        try {
            const response = await ctx.client.session.list()
            const allSessions = extractMessages(response as Record<string, unknown>)
            const now = Date.now()

            let hasBusySubagent = false

            for (const s of allSessions) {
                const sId = s.id as string
                if (!sId || sId === parentSid) continue

                const status = s.status as string

                if (status === "busy") {
                    hasBusySubagent = true
                    const msgResponse = await ctx.client.session.messages({ path: { id: sId } })
                    const messages = extractMessages(msgResponse as Record<string, unknown>)
                    const lastMsg = messages[messages.length - 1]

                    const rawRole = (lastMsg?.role ?? (lastMsg?.info as Record<string, unknown> | undefined)?.role) as string | undefined
                    if (lastMsg && rawRole === "assistant" && ("error" in lastMsg || (lastMsg.info && "error" in (lastMsg.info as Record<string, unknown>)))) {
                        await log("debug", `Subagent ${short(sId)} appears crashed`)
                        return "crashed"
                    }

                    const msgTime = (lastMsg?.time as Record<string, number> | undefined)?.created ?? (lastMsg?.time as number | undefined)
                    const hasToolCall = (lastMsg?.toolCall as Record<string, unknown> | undefined) !== undefined
                        || (lastMsg?.tool_calls as Record<string, unknown> | undefined) !== undefined
                        || (lastMsg?.parts as Record<string, unknown> | undefined)?.some((p: Record<string, unknown>) => p.type === "tool-call")
                        !== undefined
                    const isStuck = hasToolCall
                        ? now - msgTime > SUBAGENT_STUCK_MS * 3
                        : now - msgTime > SUBAGENT_STUCK_MS
                    if (isStuck) {
                        await log("debug", `Subagent ${short(sId)} stuck - no new text in >${hasToolCall ? 3 : 1}min`)
                        return { status: "crashed", stuckSid: sId }
                    }
                }
            }

            if (!hasBusySubagent) {
                return { status: "idle" }
            }

            return { status: "busy" }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("debug", `checkSubagentStatus failed: ${errMsg}`)
            return { status: "unknown" }
        }
    }

    function resetSessionFlags(w: SessionWatch) {
        w.userCancelled = false
        w.resumeAttempts = 0
        w.gaveUp = false
        w.orphanWatchStartAt = null
        w.aborting = false
        // Only reset toolTextRecovered for subagents - parent sessions keep it if set
        if (w.isSubagent) {
            w.toolTextRecovered = false
        }
        w.toolTextAttempts = 0
        w.continueTimestamps = []
        w.idleSince = null
        w.continuing = false
        w.todoCheckAttempts = 0
        w.checkingToolText = false
        w.interruptedContinueCount = 0
        w.recentToolCalls = []
        w.toolLoopAttempts = 0
        if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
    }

    function resetIdleFlags(w: SessionWatch) {
        w.userCancelled = false
        w.aborting = false
        w.orphanWatchStartAt = null
        w.idleSince = Date.now()
    }

    /**
     * Detect repeating patterns in tool calls (not just consecutive same tool).
     * Examples:
     * - A-B-A-B-A-B (pattern length 2)
     * - A-B-C-A-B-C-A-B-C (pattern length 3)
     * - edit-read-edit-read-edit-read
     */
    function detectPatternLoop(recentTools: string[]): boolean {
        if (recentTools.length < 6) return false // Need at least 6 calls to detect a pattern
        
        // Try different pattern lengths (2, 3, 4, 5)
        for (const patternLen of [2, 3, 4, 5]) {
            if (recentTools.length < patternLen * 3) continue // Need 3 repetitions
            
            // Extract the potential pattern from the most recent calls
            const pattern = recentTools.slice(-patternLen)
            
            // Check if previous calls match this pattern (at least 2 more repetitions)
            let matches = 0
            for (let i = recentTools.length - patternLen * 2; i >= 0; i -= patternLen) {
                const slice = recentTools.slice(i, i + patternLen)
                if (slice.length !== patternLen) break
                
                const isMatch = slice.every((tool, idx) => tool === pattern[idx])
                if (!isMatch) break
                
                matches++
            }
            
            if (matches >= 2) return true
        }
        return false
    }

    function trackToolCall(w: SessionWatch, toolName: string): boolean {
        const now = Date.now()
        w.recentToolCalls = w.recentToolCalls.filter(call => now - call.at < 120_000)
        w.recentToolCalls.push({ toolName, at: now })
        
        const recentTools = w.recentToolCalls.slice(-15).map(call => call.toolName)
        if (recentTools.length < 6) return false
        
        const lastTool = recentTools[recentTools.length - 1]
        const consecutiveSame = recentTools.slice(-5).filter(tool => tool === lastTool).length
        if (consecutiveSame >= 3) return true
        
        return detectPatternLoop(recentTools)
    }

    async function checkForToolCallAsText(sid: string, w: SessionWatch) {
        if (typeof sid !== "string" || !sid) return
        if (w.userCancelled || w.toolTextRecovered) return
        if (w.status !== "idle") return
        if (w.checkingToolText) return
        w.checkingToolText = true

        // Backoff for tool-text recovery
        if (w.toolTextAttempts > 0) {
            const elapsed = Date.now() - w.lastRetryAt
            const requiredBackoff = backoffMs(w.toolTextAttempts)
            if (elapsed < requiredBackoff) return
        }

        // Cap tool-text attempts like regular retries
        if (w.toolTextAttempts >= maxRetries) return

        await log("debug", `${short(sid)} - checking for tool-call-as-text (attempt ${w.toolTextAttempts + 1})`)

        try {
            const response = await ctx.client.session.messages({
                path: { id: sid },
            })
            const messages = extractMessages(response as Record<string, unknown>)
            const recent = messages.slice(-3)

            // Prioritise tool-call-as-text in reasoning over ready-to-continue
            // in text parts: collect all candidates first, then act on the
            // highest-priority one.
            let bestCandidate: {
                prompt: string
                source: string
                priority: number // lower = higher priority
            } | null = null

            let allAssistantText = ""

            for (const msg of recent) {
                const rawRole = (msg.role ?? (msg.info as Record<string, unknown> | undefined)?.role) as string | undefined
                if (rawRole !== "assistant") continue

                // Track tool calls from tool_call / tool_calls fields (not just parts)
                const toolCall = msg.toolCall as Record<string, unknown> | undefined
                if (toolCall && typeof toolCall === "object" && "name" in toolCall) {
                    const toolName = toolCall.name as string
                    if (toolName) {
                        trackToolCall(w, toolName)
                    }
                }
                
                const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
                if (toolCalls) {
                    for (const tc of toolCalls) {
                        if (typeof tc === "object" && "name" in tc) {
                            const toolName = tc.name as string
                            if (toolName) {
                                trackToolCall(w, toolName)
                            }
                        }
                    }
                }

                const parts = msg.parts as Array<Record<string, unknown>> | undefined
                if (!parts) continue

                for (const part of parts) {
                    const partType = part.type as string
                    let text = ""
                    let isReasoning = false
                    let isToolUse = false

                    if (partType === "text") {
                        text = (part.text as string) ?? ""
                    } else if (partType === "reasoning") {
                        text = (part.text as string) ?? ""
                        isReasoning = true
                    } else if (partType === "tool_use") {
                        // Tool use part detected - model is trying to execute a tool
                        // This counts as "ready to continue" since the model wants to do work
                        isToolUse = true
                        const toolName = (part.name as string) ?? "unknown"
                        text = `tool_use: ${toolName}`
                    } else {
                        continue
                    }

                    allAssistantText += text + "\n"

                    // Tool use parts indicate the model wants to execute something
                    if (isToolUse) {
                        // Track this tool call for loop detection
                        const isLoop = trackToolCall(w, toolName)
                        
                        if (isLoop && w.toolLoopAttempts < 2) {
                            // Tool loop detected! Send recovery prompt
                            w.toolLoopAttempts++
                            const candidate = {
                                prompt: TOOL_LOOP_RECOVERY_PROMPT,
                                source: "tool-loop",
                                priority: 0, // Highest priority
                            }
                            if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                                bestCandidate = candidate
                            }
                        } else {
                            const candidate = {
                                prompt: "continue",
                                source: "tool-use",
                                priority: 1,
                            }
                            if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                                bestCandidate = candidate
                            }
                        }
                    }

                    if (containsToolCallAsText(text)) {
                        const candidate = {
                            prompt: isReasoning ? THINKING_TOOL_RECOVERY_PROMPT : TOOL_TEXT_RECOVERY_PROMPT,
                            source: isReasoning ? "reasoning" : "text",
                            priority: 0,
                        }
                        if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                            bestCandidate = candidate
                        }
                    }

                    if (containsReadyToContinuePattern(text)) {
                        // Check if todos exist and are all completed/cancelled
                        const todos = w.todos || []
                        const hasOpenTodos = todos.some(t => t.status === "pending" || t.status === "in_progress")
                        
                        if (!hasOpenTodos && todos.length > 0) {
                            // Todos exist but all are completed - check if we've tried enough times
                            w.todoCheckAttempts++
                            if (w.todoCheckAttempts >= 2) {
                                await log("info", `${short(sid)} - todos completed but agent hasn't closed them. Sending continue...`)
                                const candidate = {
                                    prompt: "continue",
                                    source: "todo-completed-continue",
                                    priority: 1,
                                }
                                if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                                    bestCandidate = candidate
                                }
                                continue
                            }
                            await log("info", `${short(sid)} - skipping continue, todos appear completed (attempt ${w.todoCheckAttempts}/2)`)
                            continue
                        }
                        
                        const candidate = {
                            prompt: containsDoneClaimPattern(text)
                                ? DONE_WITHOUT_WORK_PROMPT
                                : "continue",
                            source: containsDoneClaimPattern(text)
                                ? "done-claim"
                                : "ready-to-continue",
                            priority: 1,
                        }
                        if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                            bestCandidate = candidate
                        }
                    }
                    
                    // Also trigger on done-claim patterns even without "ready to continue" text
                    // This catches cases where model says "task completed" but doesn't use 🎉 or tool_call
                    if (!bestCandidate && containsDoneClaimPattern(text)) {
                        const todos = w.todos || []
                        const hasOpenTodos = todos.some(t => t.status === "pending" || t.status === "in_progress")
                        
                        if (hasOpenTodos) {
                            await log("info", `${short(sid)} - model claims done but todos remain open. Sending recovery prompt...`)
                            bestCandidate = {
                                prompt: DONE_WITHOUT_WORK_PROMPT,
                                source: "done-claim-no-emoji",
                                priority: 1,
                            }
                        }
                    }
                }
            }

            // Completion check: 🎉 overrides ready-to-continue but not tool-call-as-text
            const trimmedText = allAssistantText.trim()
            const normalized = trimmedText.replace(/[.!?]+$/, '')
            if (normalized.endsWith('🎉') && (!bestCandidate || bestCandidate.priority > 0)) {
                await log("info", `${short(sid)} - 🎉 completion detected, skipping continue`)
                w.toolTextRecovered = true
                if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                return
            }

            // AUTO-CONTINUE when todos exist and are open, but model just stopped
            // BUT only if this is the ONLY busy session (no subagents running)
            if (!bestCandidate) {
                const todos = w.todos || []
                const hasOpenTodos = todos.some(t => t.status === "pending" || t.status === "in_progress")
                
                if (hasOpenTodos && busyCount() === 1) {
                    // Model stopped without any signal, but work remains
                    // Only trigger if this is the lone busy session (no subagents active)
                    await log("info", `${short(sid)} - no activity detected but todos remain open (${todos.filter(t => t.status === "pending" || t.status === "in_progress").length} tasks). Sending continue...`)
                    bestCandidate = {
                        prompt: "continue",
                        source: "idle-with-open-todos",
                        priority: 2,
                    }
                } else if (hasOpenTodos && busyCount() > 1) {
                    await log("debug", `${short(sid)} - todos remain open but ${busyCount()} sessions busy (subagents running), skipping continue`)
                }
            }

            if (!bestCandidate) return

            w.toolTextRecovered = true
            w.toolTextAttempts++

            await log(
                "info",
                `${bestCandidate.source} detected on ${short(sid)}! ` +
                `Attempt ${w.toolTextAttempts}/${maxRetries}. Sending recovery prompt...`,
            )

            // Guard: don't send if another plugin or user recently sent a prompt
            const timeSinceActivity = Date.now() - w.lastActivityAt
            if (timeSinceActivity < TOOL_TEXT_CHECK_DELAY_MS) {
                await log("info", `${short(sid)} - skipping ${bestCandidate.source}, session was active ${Math.round(timeSinceActivity / 1000)}s ago`)
                return
            }

            if (isHallucinationLoop(sid)) {
                await log("warn", `Hallucination loop detected on ${short(sid)} — aborting instead`)
                await tryAbortAndResume(sid, w)
            } else {
                try {
                    await sendContinuePrompt(sid, bestCandidate.prompt, w)
                    await log("info", `${short(sid)} - ${bestCandidate.source} recovery sent (attempt ${w.toolTextAttempts})`)
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err)
                    await log("warn", `${short(sid)} - ${bestCandidate.source} recovery failed: ${errMsg}`)
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            log("debug", `${short(sid)} - could not fetch messages: ${errMsg}`)
        } finally {
            w.checkingToolText = false
        }
    }

    // -----------------------------------------------------------------------
    // Abort + Continue
    // -----------------------------------------------------------------------

    async function tryAbortAndResume(sid: string, w: SessionWatch): Promise<boolean> {
        if (typeof sid !== "string" || !sid || !sid.startsWith("ses_")) {
            await log("warn", `Invalid sid for abort: ${sid} (must start with "ses_")`)
            return false
        }
        if (w.aborting) return false
        w.aborting = true

        const idleSec = Math.round((Date.now() - (w.orphanWatchStartAt ?? w.lastActivityAt)) / 1000)
        await log("info", `Abort+Resume on ${short(sid)} (${idleSec}s idle). Aborting...`)

        try {
            await ctx.client.session.abort({ path: { id: sid } })
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
                if (sid && typeof sid === "string" && sid.startsWith("ses_")) {
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
    // Timer: cleanup + session discovery)
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
                            const subStatus = await checkSubagentStatus(sid)
                            if (subStatus.status === "crashed" && subStatus.stuckSid) {
                                const recovered = await recoverSubagent(subStatus.stuckSid)
                                if (recovered) {
                                    await log("info", `Sent recovery prompt to stuck subagent ${short(subStatus.stuckSid)}, waiting...`)
                                } else {
                                    await log("info", `Subagent crashed, triggering abort+resume on ${short(sid)}`)
                                    tryAbortAndResume(sid, w)
                                }
                            } else if (subStatus.status === "idle") {
                                await log("info", `All subagents idle, parent ${short(sid)} stuck. Triggering abort+resume.`)
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

                // Cooldown: only check subagent status every 10s to avoid redundant API calls
                if (now - w.lastSubagentCheckAt < checkIntervalMs * 2) continue
                w.lastSubagentCheckAt = now

                if (w.lastActivityAt > 0 && (now - w.lastActivityAt) > subagentWaitMs) {
                    const subStatus = await checkSubagentStatus(sid)
                    if (subStatus.status === "idle" || subStatus.status === "unknown") {
                        await log("info", `Parent ${short(sid)} stuck with no active subagents. Triggering abort+resume.`)
                        tryAbortAndResume(sid, w)
                        continue
                    } else if (subStatus.status === "crashed" && subStatus.stuckSid) {
                        const recovered = await recoverSubagent(subStatus.stuckSid)
                        if (recovered) {
                            await log("info", `Sent recovery prompt to stuck subagent ${short(subStatus.stuckSid)}, waiting...`)
                        } else {
                            await log("info", `Parent ${short(sid)} subagent recovery failed. Triggering abort+resume.`)
                            tryAbortAndResume(sid, w)
                        }
                        continue
                    }
                }

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

            // Periodic cleanup
            cleanupIdleSessions()
        }, checkIntervalMs)

        if (timer.unref) timer.unref()

        // Periodic session discovery
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

    async function handleEvent(ev: Record<string, unknown>) {
        const type = ev.type as string
        const sid = getSid(ev)

        // Only touch the session that emitted the event
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
                } else if (statusType === "idle" || statusType === "interrupted") {
                    w.status = "idle"
                    resetIdleFlags(w)

                    const currentBusy = busyCount()
                    if (prevBusyCount > 1 && currentBusy === 1) {
                        const lone = getLoneBusySession()
                        if (lone && lone.w.orphanWatchStartAt === null) {
                            lone.w.orphanWatchStartAt = Date.now()
                            w.isSubagent = true
                            log("info", `Subagent finished, parent ${short(lone.sid)} stuck. Orphan watch (${subagentWaitMs / 1000}s).`)
                        }
                    }
                    prevBusyCount = currentBusy
                    log("debug", `${short(sid)} -> idle (${currentBusy})${statusType === "interrupted" ? " (interrupted)" : ""}`)

                    if (!w.isSubagent) {
                        const todos = w.todos || []
                        const hasOpenTodos = todos.some(t => t.status === "pending" || t.status === "in_progress")
                        
                        if (hasOpenTodos && currentBusy === 1 && !w.toolTextRecovered) {
                            await log("info", `${short(sid)} - idle with ${todos.filter(t => t.status === "pending" || t.status === "in_progress").length} open todos. Sending continue...`)
                            tryResume(sid, w, "Idle with open todos")
                        }
                    }

                    if (!w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
                        if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
                        const checkDelay = statusType === "interrupted" ? 500 : TOOL_TEXT_CHECK_DELAY_MS
                        w.toolTextTimer = setTimeout(() => {
                            checkForToolCallAsText(sid, w)
                        }, checkDelay)
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

                    // Also check for tool-call-as-text on legacy idle event
                    if (!w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
                        if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
                        w.toolTextTimer = setTimeout(() => {
                            checkForToolCallAsText(sid, w)
                        }, TOOL_TEXT_CHECK_DELAY_MS)
                    }
                }
                break
            }

            case "session.interrupted": {
                if (!sid) break
                const w = sessions.get(sid)
                if (w) {
                    const wasJustContinued = w.continuing || (Date.now() - w.lastRetryAt < 2000)
                    
                    w.status = "idle"
                    resetIdleFlags(w)
                    log("debug", `${short(sid)} -> interrupted${wasJustContinued ? " (after continue)" : ""}`)

                    // If we just sent a continue and it got interrupted, retry immediately
                    // But limit to 3 consecutive interrupted continues to prevent infinite loops
                    if (wasJustContinued && w.interruptedContinueCount < 3 && !w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
                        w.interruptedContinueCount++
                        await log("info", `${short(sid)} - continue was interrupted (${w.interruptedContinueCount}/3), retrying...`)
                        w.continuing = false // Reset flag so we can send again
                        try {
                            await sendContinuePrompt(sid, "continue", w)
                            await log("info", `${short(sid)} - interrupted continue retried`)
                        } catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err)
                            await log("warn", `${short(sid)} - interrupted continue retry failed: ${errMsg}`)
                        }
                        return // Don't schedule another check
                    } else if (wasJustContinued && w.interruptedContinueCount >= 3) {
                        await log("warn", `${short(sid)} - too many interrupted continues (${w.interruptedContinueCount}), stopping retries`)
                        w.interruptedContinueCount = 0 // Reset counter
                        // Fall through to normal tool-text check
                    }

                    // Check immediately for tool calls that were cut off
                    if (!w.toolTextRecovered && w.toolTextAttempts < maxRetries) {
                        if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
                        w.toolTextTimer = setTimeout(() => {
                            checkForToolCallAsText(sid, w)
                        }, 500)
                    }
                }
                break
            }

            case "todo.updated": {
                if (!sid) break
                const props = ev.properties as Record<string, unknown> | undefined
                const todos = (props?.todos as Array<Record<string, unknown>>) ?? []
                
                const w = sessions.get(sid)
                if (w) {
                    w.todos = todos.map((t) => ({
                        content: (t.content as string) ?? "",
                        status: (t.status as Todo["status"]) ?? "pending",
                        priority: (t.priority as Todo["priority"]) ?? "medium",
                    }))
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
    // task_complete tool
    // -----------------------------------------------------------------------

    const taskCompleteTool = tool({
        description: "Signal that all work is complete. Call this when you have finished everything requested.",
        args: {},
        execute: async (_args, ctx) => {
            const w = sessions.get(ctx.sessionID)
            if (w) {
                // Only set toolTextRecovered for PARENT sessions
                // Subagents can call task_complete without blocking future continues
                if (!w.isSubagent) {
                    w.toolTextRecovered = true
                    if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                }
                log("info", `${short(ctx.sessionID)} - task_complete called, ${w.isSubagent ? 'subagent' : 'agent'} done`)
            }
            return "Task completion acknowledged. No further continuation will be sent."
        },
    })

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
            if (ctx.ui && typeof ctx.ui.toast === "function") {
                ctx.ui.toast({
                    title: "Auto-Resume Plugin",
                    message: `Loaded with ${chunkTimeoutMs}ms timeout, ${loopMaxContinues} loop attempts`,
                    variant: "success",
                    duration: 5000
                })
            }
        },
        tool: {
            "task_complete": taskCompleteTool,
        },
    }
}

export default AutoResumePlugin
