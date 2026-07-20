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
    completionSignaled: boolean
    todoNudgeAttempts: number
    taskCompleteOverrides: number
    doneClaimNoTodosAttempts: number
    pendingTools: number
    pendingCommands: number
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
const DEFAULT_TOOL_TEXT_CHECK_DELAY_MS = 3_000
const DEFAULT_MIN_ACTIVITY_GAP_MS = 1_000
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

function isOpenTodo(t: Todo): boolean {
    return t.status === "pending" || t.status === "in_progress"
}

function getOpenTodos(todos: Todo[]): Todo[] {
    return todos.filter(isOpenTodo)
}

export function buildOpenTodosReminder(todos: Todo[]): string {
    if (!Array.isArray(todos)) return "continue"
    const open = todos.filter(t => t.status === "pending" || t.status === "in_progress")
    if (open.length === 0) return "continue"
    const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
    const plural = open.length > 1 ? "s" : ""
    return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on these task${plural}.`
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
    const toolTextCheckDelayMs: number =
    (options?.toolTextCheckDelayMs as number) ?? DEFAULT_TOOL_TEXT_CHECK_DELAY_MS
    const minActivityGapMs: number =
    (options?.minActivityGapMs as number) ?? DEFAULT_MIN_ACTIVITY_GAP_MS

    const sessions = new Map<string, SessionWatch>()
    let timer: ReturnType<typeof setInterval> | null = null
    let discoveryTimer: ReturnType<typeof setInterval> | null = null
    let initialised = false
    let prevBusyCount = 0

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
                completionSignaled: false,
                todoNudgeAttempts: 0,
                taskCompleteOverrides: 0,
                doneClaimNoTodosAttempts: 0,
                pendingTools: 0,
                pendingCommands: 0,
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

    function hasInflightTools(w: SessionWatch): boolean {
        return w.pendingTools > 0 || w.pendingCommands > 0
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

    function getStatusType(ev: Record<string, unknown>): string {
        const props = ev.properties as Record<string, unknown> | undefined
        const rawStatus = ev.status ?? props?.status
        if (typeof rawStatus === "string") return rawStatus
        if (rawStatus && typeof rawStatus === "object") {
            const type = (rawStatus as Record<string, unknown>).type
            if (typeof type === "string") return type
        }
        return "unknown"
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
        
        let agent: string | undefined
        let model: { providerID: string; modelID: string } | undefined
        
        try {
            const msgs = await getSessionMessages(sid)

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
                await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
            }
        }, toolTextCheckDelayMs)
    }

    function extractMessages(response: Record<string, unknown>): Array<Record<string, unknown>> {
        if (Array.isArray(response)) return response
        if (Array.isArray(response.data)) return response.data
        if (Array.isArray(response.messages)) return response.messages
        return []
    }

    async function getSessionMessages(sid: string): Promise<Array<Record<string, unknown>>> {
        const response = await ctx.client.session.messages({ path: { id: sid } })
        return extractMessages(response as Record<string, unknown>)
    }

    function roleOf(msg: Record<string, unknown> | undefined): string | undefined {
        if (!msg) return undefined
        return (msg.role as string) ?? ((msg.info as Record<string, unknown> | undefined)?.role as string)
    }

    async function lastAssistantEndsWithCelebration(sid: string): Promise<boolean> {
        try {
            const msgs = await getSessionMessages(sid)
            for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i]
                if (roleOf(msg) !== "assistant") continue
                const parts = msg.parts as Array<Record<string, unknown>> | undefined
                if (!parts) continue
                let text = ""
                for (const part of parts) {
                    if (part.type === "text") {
                        text += (part.text as string) ?? ""
                    }
                }
                const normalized = text.trim().replace(/[.!?]+$/, '')
                return normalized.endsWith('🎉')
            }
        } catch {
            // on error, don't block continue
        }
        return false
    }

    async function getSessionStatusMap(): Promise<Record<string, string>> {
        try {
            const response = await ctx.client.session.status()
            const raw = ((response as Record<string, unknown>).data ?? response) as Record<string, unknown>
            const result: Record<string, string> = {}
            if (raw && typeof raw === "object") {
                for (const [sid, val] of Object.entries(raw)) {
                    if (typeof val === "string") {
                        result[sid] = val
                    } else if (val && typeof val === "object") {
                        const type = (val as Record<string, unknown>).type
                        if (typeof type === "string") result[sid] = type
                    }
                }
            }
            return result
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("debug", `session.status() failed: ${errMsg}`)
            return {}
        }
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

        async function hasBusySubagents(parentSid: string): Promise<boolean> {
        try {
            const statusMap = await getSessionStatusMap()
            for (const [sId, statusType] of Object.entries(statusMap)) {
                if (!sId || sId === parentSid) continue
                if (statusType === "busy") return true
            }
            return false
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("debug", `hasBusySubagents failed for ${short(parentSid)}: ${errMsg}`)
            return false
        }
    }

        async function checkSessionHasActiveTool(sid: string): Promise<boolean> {
        try {
            const statusMap = await getSessionStatusMap()
            if (statusMap[sid] === "busy") {
                await log("debug", `Session ${short(sid)} is busy, likely executing a tool`)
                return true
            }

            const messages = await getSessionMessages(sid)
            const lastMsg = messages[messages.length - 1]

            if (!lastMsg) return false

            if (roleOf(lastMsg) !== "assistant") return false

            const toolCall = lastMsg.toolCall as Record<string, unknown> | undefined
            const toolCalls = lastMsg.tool_calls as Array<Record<string, unknown>> | undefined
            const parts = lastMsg.parts as Array<Record<string, unknown>> | undefined

            const hasToolCall = toolCall !== undefined
                || (toolCalls?.length ?? 0) > 0
                || (parts?.some((p: Record<string, unknown>) => p.type === "tool-call" || p.type === "tool_use") ?? false)

            return hasToolCall
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("debug", `checkSessionHasActiveTool failed for ${short(sid)}: ${errMsg}`)
            return false
        }
    }

        async function checkSubagentStatus(parentSid: string): Promise<{ status: "crashed" | "idle" | "busy" | "unknown"; stuckSid?: string }> {
        try {
            const statusMap = await getSessionStatusMap()
            const now = Date.now()

            let hasBusySubagent = false

            for (const [sId, statusType] of Object.entries(statusMap)) {
                if (!sId || sId === parentSid) continue

                if (statusType === "busy") {
                    hasBusySubagent = true
                    const messages = await getSessionMessages(sId)
                    const lastMsg = messages[messages.length - 1]

                    if (lastMsg && roleOf(lastMsg) === "assistant" && ("error" in lastMsg || (lastMsg.info && "error" in (lastMsg.info as Record<string, unknown>)))) {
                        await log("debug", `Subagent ${short(sId)} appears crashed`)
                        return { status: "crashed" }
                    }

                    const msgTime = (lastMsg?.time as Record<string, number> | undefined)?.created ?? (lastMsg?.time as number | undefined)
                    if (!msgTime) continue

                    const toolCall = lastMsg.toolCall as Record<string, unknown> | undefined
                    const toolCalls = lastMsg.tool_calls as Array<Record<string, unknown>> | undefined
                    const parts = lastMsg.parts as Array<Record<string, unknown>> | undefined
                    const hasToolCall = toolCall !== undefined
                        || (toolCalls?.length ?? 0) > 0
                        || (parts?.some((p: Record<string, unknown>) => p.type === "tool-call") ?? false)

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
    }

    function resetIdleFlags(w: SessionWatch) {
        w.aborting = false
        w.orphanWatchStartAt = null
        w.idleSince = Date.now()
        w.pendingTools = 0
        w.pendingCommands = 0
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
        
        for (const patternLen of [2, 3, 4, 5]) {
            if (recentTools.length < patternLen * 3) continue
            
            const pattern = recentTools.slice(-patternLen)
            
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

        if (w.toolTextAttempts >= maxRetries) return

        await log("debug", `${short(sid)} - checking for tool-call-as-text (attempt ${w.toolTextAttempts + 1})`)

        try {
            const messages = await getSessionMessages(sid)
            const recent = messages.slice(-3)

            let bestCandidate: {
                prompt: string
                source: string
                priority: number
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
                        isToolUse = true
                        const toolName = (part.name as string) ?? "unknown"
                        text = `tool_use: ${toolName}`
                    } else {
                        continue
                    }

                    allAssistantText += text + "\n"

                    if (isToolUse) {
                        const toolName = (part.name as string) ?? "unknown"
                        const isLoop = trackToolCall(w, toolName)
                        
                        if (isLoop && w.toolLoopAttempts < 2) {
                            w.toolLoopAttempts++
                            const candidate = {
                                prompt: TOOL_LOOP_RECOVERY_PROMPT,
                                source: "tool-loop",
                                priority: 0,
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
                        const toolMatch = text.match(/<function=([a-zA-Z_]+)/) || text.match(/<invoke\s+name=([a-zA-Z_]+)/) || text.match(/"name":\s*"([a-zA-Z_]+)/)
                        if (toolMatch) {
                            const toolName = toolMatch[1] || "unknown"
                            const isLoop = trackToolCall(w, toolName)
                            if (isLoop && w.toolLoopAttempts < 2) {
                                w.toolLoopAttempts++
                                const loopCandidate = {
                                    prompt: TOOL_LOOP_RECOVERY_PROMPT,
                                    source: "tool-text-loop",
                                    priority: 0,
                                }
                                if (!bestCandidate || loopCandidate.priority < bestCandidate.priority) {
                                    bestCandidate = loopCandidate
                                }
                            }
                        }
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
                        const hasOpenTodos = todos.some(isOpenTodo)
                        
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
                        const hasOpenTodos = todos.some(isOpenTodo)
                        
                    if (hasOpenTodos) {
                        await log("info", `${short(sid)} - model claims done but todos remain open. Sending recovery prompt...`)
                        bestCandidate = {
                            prompt: DONE_WITHOUT_WORK_PROMPT,
                            source: "done-claim-no-emoji",
                            priority: 1,
                        }
                    } else if (w.doneClaimNoTodosAttempts < maxRetries) {
                        await log("info", `${short(sid)} - model claims done with no open todos. Sending verification prompt (attempt ${w.doneClaimNoTodosAttempts + 1}/${maxRetries})...`)
                        bestCandidate = {
                            prompt: DONE_WITHOUT_WORK_PROMPT,
                            source: "done-claim-no-todos",
                            priority: 1,
                        }
                    }
                    }
                }
            }

            const trimmedText = allAssistantText.trim()
            const normalized = trimmedText.replace(/[.!?]+$/, '')
            if (normalized.endsWith('🎉') && (!bestCandidate || bestCandidate.priority > 0)) {
                await log("info", `${short(sid)} - 🎉 completion detected, skipping continue`)
                w.toolTextRecovered = true
                w.completionSignaled = true
                if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                return
            }

            if (!bestCandidate) {
                const todos = w.todos || []
                const hasOpenTodos = todos.some(isOpenTodo)
                
                if (hasOpenTodos && busyCount() === 0) {
                    const reminder = buildOpenTodosReminder(todos)
                    await log("info", `${short(sid)} - no activity detected but todos remain open (${getOpenTodos(todos).length} tasks). Sending reminder...`)
                    bestCandidate = {
                        prompt: reminder,
                        source: "idle-with-open-todos-reminder",
                        priority: 2,
                    }
                } else if (hasOpenTodos && busyCount() > 0) {
                    await log("debug", `${short(sid)} - todos remain open but ${busyCount()} sessions busy (subagents running), skipping continue`)
                }
            }

            if (!bestCandidate) return

            const isOpenTodosReminder = bestCandidate.source === "idle-with-open-todos-reminder"
            const isDoneClaimNoTodos = bestCandidate.source === "done-claim-no-todos"
            if (isOpenTodosReminder) {
                if (w.todoNudgeAttempts >= maxRetries) {
                    await log("info", `${short(sid)} - max open-todos nudges (${maxRetries}) reached, waiting for activity`)
                    return
                }
                w.todoNudgeAttempts++
            } else if (isDoneClaimNoTodos) {
                w.doneClaimNoTodosAttempts++
            } else {
                w.toolTextRecovered = true
                w.toolTextAttempts++
            }

            const attemptNum = isOpenTodosReminder ? w.todoNudgeAttempts : isDoneClaimNoTodos ? w.doneClaimNoTodosAttempts : w.toolTextAttempts
            await log(
                "info",
                `${bestCandidate.source} detected on ${short(sid)}! ` +
                `Attempt ${attemptNum}/${maxRetries}. Sending recovery prompt...`,
            )

            // Guard: don't send if another plugin or user recently sent a prompt
            const timeSinceActivity = Date.now() - w.lastActivityAt
            if (timeSinceActivity < minActivityGapMs) {
                await log("info", `${short(sid)} - skipping ${bestCandidate.source}, session was active ${Math.round(timeSinceActivity / 1000)}s ago`)
                return
            }

            if (isHallucinationLoop(sid)) {
                if (hasInflightTools(w)) {
                    await log("debug", `Session ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping hallucination abort`)
                    return
                }
                // Fallback: polled heuristic for sessions discovered without hooks
                const hasActiveTool = await checkSessionHasActiveTool(sid)
                if (hasActiveTool) {
                    await log("debug", `Session ${short(sid)} has active tool, skipping hallucination abort`)
                    return
                }
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

    async function tryResume(sid: string, w: SessionWatch, reason: string, prompt?: string): Promise<boolean> {
        if (typeof sid !== "string" || !sid) {
            await log("warn", `tryResume called with invalid sid: ${sid}`)
            return false
        }
        const now = Date.now()
        const elapsedSinceRetry = now - w.lastRetryAt
        const requiredBackoff = backoffMs(w.resumeAttempts)
        if (w.lastRetryAt > 0 && elapsedSinceRetry < requiredBackoff) return false

        if (isHallucinationLoop(sid)) {
            if (hasInflightTools(w)) {
                await log("debug", `Session ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping hallucination abort`)
                w.lastRetryAt = now
                return false
            }
            // Fallback: polled heuristic for sessions discovered without hooks
            const hasActiveTool = await checkSessionHasActiveTool(sid)
            if (hasActiveTool) {
                await log("debug", `Session ${short(sid)} has active tool, skipping hallucination abort`)
                w.lastRetryAt = now
                return false
            }
            await log("warn", `Hallucination loop on ${short(sid)}! Aborting...`)
            return await tryAbortAndResume(sid, w)
        }

        w.resumeAttempts++
        const idleSec = Math.round((now - w.lastActivityAt) / 1000)
        await log("info", `${reason} on ${short(sid)} (${idleSec}s, retry ${w.resumeAttempts}/${maxRetries})`)

        try {
            await sendContinuePrompt(sid, prompt ?? "continue", w)
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
            const statusMap = await getSessionStatusMap()

            for (const [sid, w] of sessions) {
                const realStatus = statusMap[sid]
                if (realStatus && realStatus !== w.status) {
                    w.status = realStatus as SessionWatch["status"]
                    if (realStatus === "busy") w.idleSince = null
                }
                
                if (w.status !== "busy") continue
                if (w.userCancelled) continue
                if (w.aborting) continue

                if (w.orphanWatchStartAt !== null) {
                    const orphanIdle = now - w.orphanWatchStartAt
                    if (orphanIdle >= subagentWaitMs + gracePeriodMs) {
                        if (w.resumeAttempts < maxRetries) {
                            // Guard: never abort the parent while it is running a tool.
                            // Primary: deterministic in-flight counters from hooks.
                            if (hasInflightTools(w)) {
                                await log("debug", `Parent ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping orphan-watch abort`)
                                w.orphanWatchStartAt = now
                                continue
                            }
                            // Paths B (subagentWait) and C (chunkTimeout) already check
                            // checkSessionHasActiveTool before aborting; path A was missing
                            // it, so a long-running parent tool was killed when a subagent
                            // finished and the orphan timer expired.
                            const hasActiveTool = await checkSessionHasActiveTool(sid)
                            if (hasActiveTool) {
                                await log("debug", `Parent ${short(sid)} has active tool call, skipping orphan-watch abort`)
                                w.orphanWatchStartAt = now
                                continue
                            }
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
                                const hasBusySub = await hasBusySubagents(sid)
                                if (hasBusySub) {
                                    await log("debug", `Subagents exist but not busy yet, waiting for startup...`)
                                } else {
                                    await log("info", `Parent ${short(sid)} stuck with no active subagents. Triggering abort+resume.`)
                                    tryAbortAndResume(sid, w)
                                }
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
                    if (realStatus === "busy") {
                        await log("debug", `Session ${short(sid)} is still busy (real status), skipping abort`)
                        w.lastSubagentCheckAt = now
                        continue
                    }

                    if (hasInflightTools(w)) {
                        await log("debug", `Session ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping abort check`)
                        w.lastSubagentCheckAt = now
                        continue
                    }
                    
                    const hasActiveTool = await checkSessionHasActiveTool(sid)
                    if (hasActiveTool) {
                        await log("debug", `Session ${short(sid)} has active tool call, skipping abort check`)
                        w.lastSubagentCheckAt = now
                        continue
                    }

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
                    // Primary: deterministic in-flight counters from hooks.
                    // A long-running build/test/command must never be aborted.
                    if (hasInflightTools(w)) {
                        await log("debug", `Session ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping stall recovery`)
                        w.lastSubagentCheckAt = now
                    } else {
                        // Fallback: Check if main session has an active tool call - if so, don't resume
                        const hasActiveTool = await checkSessionHasActiveTool(sid)
                        if (hasActiveTool) {
                            await log("debug", `Session ${short(sid)} has active tool call, skipping stall recovery`)
                            w.lastSubagentCheckAt = now
                        } else if (w.resumeAttempts < maxRetries) {
                            tryResume(sid, w, "Stream stall")
                        } else if (!w.gaveUp) {
                            w.gaveUp = true
                            log("warn", `${short(sid)} - all ${maxRetries} retries exhausted.`)
                        }
                    }
                }
            }

            // Periodic idle session recheck: resume idle sessions with open todos
            for (const [sid, w] of sessions) {
                if (w.status !== "idle") continue
                if (w.isSubagent) continue
                if (w.userCancelled || w.completionSignaled) continue
                if (w.continuing) continue
                if (busyCount() !== 0) continue
                const open = getOpenTodos(w.todos || [])
                if (open.length === 0) continue
                if (w.todoNudgeAttempts >= maxRetries) continue
                const elapsedSinceLastNudge = Date.now() - w.lastRetryAt
                const requiredBackoff = backoffMs(w.todoNudgeAttempts)
                if (w.lastRetryAt > 0 && elapsedSinceLastNudge < requiredBackoff) continue
                const isCelebration = await lastAssistantEndsWithCelebration(sid)
                if (isCelebration) {
                    w.toolTextRecovered = true
                    w.completionSignaled = true
                    continue
                }
                const reminder = buildOpenTodosReminder(w.todos || [])
                const sent = await tryResume(sid, w, "Idle with open todos (periodic)", reminder)
                if (sent) {
                    w.todoNudgeAttempts++
                    await log("info", `${short(sid)} - idle periodic recheck: nudge ${w.todoNudgeAttempts}/${maxRetries}`)
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
                const statusType = getStatusType(ev)
                const w = ensureWatch(sid)
                w.status = statusType as SessionWatch["status"]

                if (statusType === "busy") {
                    w.lastActivityAt = Date.now()
                    resetSessionFlags(w)
                    prevBusyCount = busyCount()
                    log("debug", `${short(sid)} -> busy (${prevBusyCount})`)
                } else if (statusType === "interrupted") {
                    // User pressed Esc — clear timers, back off, let them write
                    w.status = "idle"
                    resetIdleFlags(w)
                    w.userCancelled = true
                    if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                    prevBusyCount = busyCount()
                    log("info", `${short(sid)} -> interrupted by user, backing off`)
                } else if (statusType === "idle") {
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
                    log("debug", `${short(sid)} -> idle (${currentBusy})`)

                    if (!w.isSubagent) {
                        const todos = w.todos || []
                        const open = getOpenTodos(todos)
                        
                        if (open.length > 0 && currentBusy === 0 && !w.completionSignaled && !w.userCancelled && w.todoNudgeAttempts < maxRetries) {
                            const isCelebration = await lastAssistantEndsWithCelebration(sid)
                            if (isCelebration) {
                                await log("info", `${short(sid)} - 🎉 detected in idle handler, skipping continue`)
                                w.toolTextRecovered = true
                                w.completionSignaled = true
                                if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                            } else {
                                w.todoNudgeAttempts++
                                const reminder = buildOpenTodosReminder(todos)
                                await log("info", `${short(sid)} - idle with ${open.length} open todos. Sending reminder (nudge ${w.todoNudgeAttempts}/${maxRetries})...`)
                                await tryResume(sid, w, "Idle with open todos", reminder)
                            }
                        }
                    }

                    if (!w.completionSignaled && !w.userCancelled && w.toolTextAttempts < maxRetries) {
                        if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
                        w.toolTextTimer = setTimeout(() => {
                            checkForToolCallAsText(sid, w)
                        }, toolTextCheckDelayMs)
                    }
                } else if (statusType === "retry") {
                    touchSession(sid)
                    log("debug", `${short(sid)} -> provider retry`)
                }
                break
            }

            case "session.created": {
                if (!sid) break
                const w = ensureWatch(sid)
                w.pendingTools = 0
                w.pendingCommands = 0
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
                        }, toolTextCheckDelayMs)
                    }
                }
                break
            }

            case "session.interrupted": {
                if (!sid) break
                const w = sessions.get(sid)
                if (w) {
                    w.status = "idle"
                    resetIdleFlags(w)
                    w.userCancelled = true
                    if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                    log("info", `${short(sid)} -> interrupted by user, backing off`)
                }
                break
            }

            case "todo.updated": {
                if (!sid) break
                const props = ev.properties as Record<string, unknown> | undefined
                const todos = (props?.todos as Array<Record<string, unknown>>) ?? []
                
                const w = ensureWatch(sid)
                w.todos = todos.map((t) => ({
                    content: (t.content as string) ?? "",
                    status: (t.status as Todo["status"]) ?? "pending",
                    priority: (t.priority as Todo["priority"]) ?? "medium",
                }))
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

                if (sid) {
                    const w = sessions.get(sid)
                    if (w) { w.pendingTools = 0; w.pendingCommands = 0 }
                }
                break
            }

            case "command.executed": {
                for (const [, w] of sessions) {
                    resetSessionFlags(w)
                }
                if (!sid) break
                const w = sessions.get(sid)
                if (w) {
                    w.pendingCommands = Math.max(0, w.pendingCommands - 1)
                    w.lastActivityAt = Date.now()
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
                if (!w.isSubagent) {
                    const openTodos = (w.todos || []).filter(t => t.status === "pending" || t.status === "in_progress")

                    if (openTodos.length > 0 && w.taskCompleteOverrides < maxRetries) {
                        w.taskCompleteOverrides++
                        await log("info", `${short(ctx.sessionID)} - task_complete blocked: ${openTodos.length} open todos remain (override ${w.taskCompleteOverrides}/${maxRetries})`)
                        return `You have ${openTodos.length} unfinished task(s). Please complete all remaining work before signaling completion.`
                    }

                    w.toolTextRecovered = true
                    w.completionSignaled = true
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
        },
        tool: {
            "task_complete": taskCompleteTool,
        },

        "tool.execute.before": async (input) => {
            if (!input?.sessionID) return
            const w = ensureWatch(input.sessionID)
            w.pendingTools++
            w.lastActivityAt = Date.now()
        },

        "command.execute.before": async (input) => {
            if (!input?.sessionID) return
            const w = ensureWatch(input.sessionID)
            w.pendingCommands++
            w.lastActivityAt = Date.now()
        },

        "tool.execute.after": async (input) => {
            if (!input?.sessionID) return
            const w = ensureWatch(input.sessionID)
            w.pendingTools = Math.max(0, w.pendingTools - 1)
            w.lastActivityAt = Date.now()
        },
    }
}

export default AutoResumePlugin
