/**
 * OpenCode Auto-Resume Plugin
 * Detects when an LLM session stalls mid-stream and automatically sends a continuation prompt.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { SessionPromptResponses } from "@opencode-ai/sdk"

interface Todo {
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    priority: "high" | "medium" | "low"
}

interface ToolCallRecord {
    toolName: string
    at: number
}

export interface SessionWatch {
    createdAt: number
    lastActivityAt: number
    status: "busy" | "idle" | "retry" | "unknown"
    userCancelled: boolean
    resumeAttempts: number
    lastRetryAt: number
    gaveUp: boolean
    orphanWatchStartAt: number | null
    aborting: boolean
    pluginAbortInFlight: boolean
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
    liveToolSigs: string[]
    lastTokenTotal: number
    contextWrapupAttempts: number
    toolLoopAttempts: number
    isSubagent: boolean
    completionSignaled: boolean
    todoNudgeAttempts: number
    taskCompleteOverrides: number
    doneClaimNoTodosAttempts: number
    // Last inbound user message (message.updated, role=user). A recently
    // active user is likely composing a reply — idle nudges must stand down.
    lastUserMessageAt: number
    pendingTools: number
    pendingCommands: number
    pendingRecovery: boolean
    pendingRecoveryReason: string | null
    pendingRecoveryAt: number
    recoveryAttempts: number
    watchdogRetryGuard: boolean
}

const DEFAULT_CHUNK_TIMEOUT_MS = 45_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000
// Active-user window: an inbound user message this recent means the user is
// engaged (likely composing) — idle open-todos nudges stand down.
const DEFAULT_ACTIVE_USER_WINDOW_MS = 15 * 60_000
const DEFAULT_GRACE_PERIOD_MS = 3_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_BACKOFF_MS = 8_000
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_SUBAGENT_WAIT_MS = 15_000
const ABORT_CONTINUE_DELAY_MS = 2_000
const DEFAULT_LOOP_MAX_CONTINUES = 3
const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000
const DEFAULT_TOOL_TEXT_CHECK_DELAY_MS = 3_000
const DEFAULT_MAX_RECOVERY_RETRIES = 2
const DEFAULT_MIN_ACTIVITY_GAP_MS = 1_000
const DEFAULT_WARMUP_MS = 15_000
const DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS = 200
const DEFAULT_DEBUG = false

const DEFAULT_STREAMING_FAILURE_ERROR_NAMES = [
    "ProviderError",
    "APIError",
    "StreamError",
    "ConnectionError",
    "TimeoutError",
]

const DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS = [
    "streaming response failed",
    "stream.*fail",
    "connection.*reset",
    "connection.*closed",
]

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

const CTX_WRAPUP_TRIGGER = "ctx-wrapup"

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

function stripCodeBlocks(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`\n]+`/g, "")
}

function containsToolCallAsText(text: string): boolean {
    if (text.length <= 10) return false
    const stripped = stripCodeBlocks(text)
    if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(stripped))) return true
    for (const { open, close } of TRUNCATED_XML_PATTERNS) {
        if (open.test(stripped) && !close.test(stripped)) return true
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
    /\bdone\s+with\s+(?:the\s+)?(?:task|work|implementation)/im,
    /\bfinished\s+(?:the\s+)?(?:task|work|implementation)/im,
    /\b(?:all|everything)\s+(?:is\s+)?(?:complete|done|finished)/im,
    /\bnothing\s+(?:else\s+)?(?:left|remaining|to do)/im,
]

const DONE_WITHOUT_WORK_PROMPT =
    "I need you to verify more carefully that you have actually completed all the required tasks. " +
    "Your response indicated you're done, but no work was detected. Please check your todo list " +
    "and complete any remaining work."

const DONE_WITHOUT_DETAILS_PROMPT =
    "Your last response claimed the task is complete but contained no work description. This is not acceptable. " +
    "You MUST respond now with a full, detailed report of everything you did: " +
    "for each file you modified, state the full path and the exact changes; " +
    "list every command you ran to verify and its result; state the final outcome. " +
    "Do NOT reply with 'done', 'task completed', or any short acknowledgment — " +
    "your ONLY acceptable response right now is this detailed report. Write it now."

function containsDoneClaimPattern(text: string): boolean {
    const lines = text.split('\n')
    const lastLines = lines.slice(-5).join('\n')
    return DONE_CLAIM_PATTERNS.some((pat) => pat.test(lastLines))
}

// A done-claim that already carries a concrete work report satisfies the
// details demand on its own — prompting again would loop forever (#26).
function containsWorkDescription(text: string): boolean {
    // Backticked span mentioning a dotted filename: `src/index.ts`
    if (/`[^`\n]*\.[a-zA-Z0-9]{1,8}[^`\n]*`/.test(text)) return true
    // Bare path with a slash and a dotted extension: src/index.ts, /a/b.py
    if (/[\w\-~.][\w\-.~\/]*\/[\w\-.~]*\.[a-zA-Z]{1,8}\b/.test(text)) return true
    // Report section headers: files changed, verification, results, ...
    if (/^(changed|modified|deleted|created|updated|renamed|moved|files?\s+changed|verification|verified|tests?(?:\s+run|\s+passing|\s+pass)?|results?|outcome|commands?\s+(?:run|executed))/im.test(text)) return true
    return false
}

function isStreamingFailure(
    errorName: string,
    errorMessage: string,
    errorNames: string[] = DEFAULT_STREAMING_FAILURE_ERROR_NAMES,
    messagePatterns: string[] = DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS,
): boolean {
    if (!errorName && !errorMessage) return false

    // Error name match: exact, case-sensitive
    if (errorName && errorNames.includes(errorName)) {
        return true
    }

    // Message pattern match: case-insensitive regex, substring fallback on invalid regex
    if (errorMessage) {
        const lowerMessage = errorMessage.toLowerCase()
        for (const pattern of messagePatterns) {
            try {
                if (new RegExp(pattern, "i").test(lowerMessage)) return true
            } catch {
                if (lowerMessage.includes(pattern.toLowerCase())) return true
            }
        }
    }

    return false
}

/**
 * Extract the most recent assistant-message error from a message list.
 * Checks (in priority order): message.error, message.info.error, and
 * any `type === "retry"` part's `error` field (SDK RetryPart surface).
 * Returns `{ name, message }` or null if no assistant message has an error.
 */
function getLastAssistantError(
    messages: Array<Record<string, unknown>>,
): { name: string; message: string } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const role =
            (msg.role as string) ??
            ((msg.info as Record<string, unknown> | undefined)?.role as string)
        if (role !== "assistant") continue

        const info = msg.info as Record<string, unknown> | undefined
        const err =
            (msg.error as Record<string, unknown> | undefined) ??
            (info?.error as Record<string, unknown> | undefined)
        if (err) {
            const data = err.data as Record<string, unknown> | undefined
            const name = (err.name as string) ?? ""
            const message =
                (data?.message as string) ?? (err.message as string) ?? ""
            return { name, message }
        }

        const parts = msg.parts as Array<Record<string, unknown>> | undefined
        if (parts) {
            for (let j = parts.length - 1; j >= 0; j--) {
                const part = parts[j]
                if (part.type !== "retry") continue
                const partErr = part.error as
                    | Record<string, unknown>
                    | undefined
                if (!partErr) continue
                const data = partErr.data as
                    | Record<string, unknown>
                    | undefined
                const name = (partErr.name as string) ?? ""
                const message =
                    (data?.message as string) ??
                    (partErr.message as string) ??
                    ""
                return { name, message }
            }
        }
    }
    return null
}

/**
 * Detects a silent dead stream: the NEWEST assistant message has a finish reason
 * but emitted no text parts (only reasoning or no parts at all). This can happen when
 * the model stream dies mid-response. Only the newest assistant message is evaluated:
 * if it has text, the session completed normally and null is returned — never walk
 * back past a delivered answer to an intermediate tool-call step.
 */
function getLastSilentDeadStream(
    messages: Array<Record<string, unknown>>,
): { finish: string; outputTokens: number } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const role = (msg.role as string) ??
            ((msg.info as Record<string, unknown> | undefined)?.role as string)
        if (role !== "assistant") continue

        const info = msg.info as Record<string, unknown> | undefined
        const finish = (msg.finish as string) ??
            (info?.finish as string) ??
            (info?.finishReason as string)
        if (!finish) continue

        const parts = (msg.parts as Array<Record<string, unknown>> | undefined) ?? []
        const hasText = parts.some((p) => {
            const t = p as Record<string, unknown>
            return t.type === "text" && typeof t.text === "string" && t.text.length > 0
        })
        if (hasText) return null

        const tokens = msg.tokens as Record<string, unknown> | undefined
        const tInfo = info?.tokens as Record<string, unknown> | undefined
        const output = ((tokens?.output as number) ?? 0) +
            ((tInfo?.output as number) ?? 0)
        return { finish, outputTokens: output }
    }
    return null
}

/**
 * Stable fingerprint of a tool call: tool name + deterministically serialized
 * arguments (object keys sorted). Identical name+arguments produce the same
 * signature regardless of argument key order.
 */
function toolCallSignature(toolName: string, args: unknown): string {
    const stable = (v: unknown): string => {
        if (v === null) return "null"
        if (v === undefined) return "undefined"
        if (typeof v !== "object") return JSON.stringify(v) ?? String(v)
        if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]"
        const obj = v as Record<string, unknown>
        return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stable(obj[k])).join(",") + "}"
    }
    try {
        return `${toolName}:${stable(args)}`.slice(0, 200)
    } catch {
        // Non-serializable args (cycles): degrade to a name-only fingerprint
        return `${toolName}:unserializable`
    }
}

/**
 * Exponential backoff for recovery retries: `base * 2^(attempt-1)`, capped at `max`.
 * Exported as a pure function for unit testing (WP-08).
 */
function backoffMs(
    attempt: number,
    baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
    return Math.min(baseBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs)
}

/**
 * Detect an "action intent" — the model ends with `:` announcing intent
 * (e.g. "Voy a editar el archivo:") without executing. Used to nudge.
 */
function containsActionIntent(text: string): boolean {
    if (text.length <= 15) return false
    const cleaned = text.replace(/<[a-zA-Z/?][^>]*>/g, "").trim()
    const lines = cleaned.split('\n')
    let lastLine = ""
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0) {
            lastLine = lines[i].trim()
            break
        }
    }
    return lastLine.endsWith(":") && lastLine.length > 5 && lastLine.length < 500
}

function isOpenTodo(t: Todo): boolean {
    return t.status === "pending" || t.status === "in_progress"
}

function getOpenTodos(todos: Todo[]): Todo[] {
    if (!Array.isArray(todos)) return []
    return todos.filter(isOpenTodo)
}

function buildOpenTodosReminder(todos: Todo[]): string {
    if (!Array.isArray(todos)) return "continue"
    const open = todos.filter(t => t.status === "pending" || t.status === "in_progress")
    if (open.length === 0) return "continue"
    const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
    const plural = open.length > 1 ? "s" : ""
    const taskWord = open.length > 1 ? "tasks" : "task"
    const thisWord = open.length > 1 ? "these" : "this"
    return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on ${thisWord} ${taskWord}.`
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
    const maxRecoveryRetries: number =
    (options?.maxRecoveryRetries as number) ?? DEFAULT_MAX_RECOVERY_RETRIES
    const minActivityGapMs: number =
    (options?.minActivityGapMs as number) ?? DEFAULT_MIN_ACTIVITY_GAP_MS
    const warmupMs: number =
    (options?.warmupMs as number) ?? DEFAULT_WARMUP_MS
    const debug: boolean =
    (options?.debug as boolean) ?? DEFAULT_DEBUG
    const streamingFailureErrorNames: string[] =
        (options?.streamingFailureErrorNames as string[]) ?? DEFAULT_STREAMING_FAILURE_ERROR_NAMES
    const streamingFailureMessagePatterns: string[] =
        (options?.streamingFailureMessagePatterns as string[]) ?? DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS
    const resumeOnActionIntent: boolean =
    (options?.resumeOnActionIntent as boolean) !== false
    const continuePrompt: string =
    (options?.continuePrompt as string) ?? "continue"
    const actionIntentPrompt: string =
    (options?.actionIntentPrompt as string) ?? continuePrompt
    const toolTextRecoveryPrompt: string =
    (options?.toolTextRecoveryPrompt as string) ?? TOOL_TEXT_RECOVERY_PROMPT
    const thinkingToolRecoveryPrompt: string =
    (options?.thinkingToolRecoveryPrompt as string) ?? THINKING_TOOL_RECOVERY_PROMPT
    const doneWithoutWorkPrompt: string =
        (options?.doneWithoutWorkPrompt as string) ?? DONE_WITHOUT_WORK_PROMPT
    const doneWithoutDetailsPrompt: string =
        (options?.doneWithoutDetailsPrompt as string) ?? DONE_WITHOUT_DETAILS_PROMPT
    const silentDeadStreamMinTokens: number =
        (options?.silentDeadStreamMinTokens as number) ?? DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS
    const rawBusyStallStrategy = (options?.busyStallStrategy as string) ?? "continue"
    const busyStallStrategy: "continue" | "abort" | "off" =
        rawBusyStallStrategy === "abort" || rawBusyStallStrategy === "off"
            ? rawBusyStallStrategy
            : "continue"
    const contextSaturationThreshold: number =
        (options?.contextSaturationThreshold as number) ?? 0.85
    const subagentNativeCompactionEnabled: boolean =
        (options?.subagentNativeCompactionEnabled as boolean) ?? false
    const activeUserWindowMs: number =
        (options?.activeUserWindowMs as number) ?? DEFAULT_ACTIVE_USER_WINDOW_MS
    const dbg = (...args: unknown[]) => { if (debug) console.log("[debug]", ...args) }

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

    const recentLogMsgs = new Map<string, number>()
    const LOG_DEDUP_WINDOW_MS = 5000

    async function log(level: "debug" | "info" | "warn" | "error", msg: string) {
        // Suppress repeated identical debug messages within 5s to avoid log storms during DB contention.
        // Only dedup debug — info/warn/error must always be logged for visibility.
        if (level === "debug") {
            const key = `${level}:${msg}`
            const now = Date.now()
            const last = recentLogMsgs.get(key)
            if (last && now - last < LOG_DEDUP_WINDOW_MS) return
            recentLogMsgs.set(key, now)
            if (recentLogMsgs.size > 200) {
                const oldest = [...recentLogMsgs.entries()].sort((a, b) => a[1] - b[1])
                for (let i = 0; i < 100; i++) recentLogMsgs.delete(oldest[i][0])
            }
        }
        try {
            await ctx.client.app.log({ body: { service: "auto-resume", level, message: msg } })
        } catch (e) {
            console.error("[auto-resume] log() failed:", e instanceof Error ? e.message : String(e))
        }
    }

    async function safe<T>(fn: () => Promise<T>, ctxLabel: string): Promise<T | undefined> {
        try {
            return await fn()
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[auto-resume] ${ctxLabel}: ${msg}`)
            try { await log("error", `${ctxLabel}: ${msg}`) } catch { /* logging best-effort */ }
            return undefined
        }
    }

    function ensureWatch(sid: string): SessionWatch {
        let w = sessions.get(sid)
        if (!w) {
            w = {
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                status: "unknown",
                userCancelled: false,
                resumeAttempts: 0,
                lastRetryAt: 0,
                gaveUp: false,
                orphanWatchStartAt: null,
                aborting: false,
                pluginAbortInFlight: false,
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
                liveToolSigs: [],
                lastTokenTotal: 0,
                contextWrapupAttempts: 0,
                toolLoopAttempts: 0,
                isSubagent: false,
                completionSignaled: false,
                todoNudgeAttempts: 0,
                taskCompleteOverrides: 0,
                doneClaimNoTodosAttempts: 0,
                lastUserMessageAt: 0,
                pendingTools: 0,
                pendingCommands: 0,
                pendingRecovery: false,
                pendingRecoveryReason: null,
                pendingRecoveryAt: 0,
                recoveryAttempts: 0,
                watchdogRetryGuard: false,
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

    /**
     * Extract the `{ info, parts }` payload from a `session.prompt()` result.
     * Handles both the SDK client shape (`{ data: { info, parts } }`) and the
     * raw payload shape (`{ info, parts }`). Returns null on unexpected shapes
     * so the caller can log the raw response for debugging.
     */
    function getPromptResponsePayload(result: unknown): SessionPromptResponses[200] | null {
        if (!result || typeof result !== "object") return null
        const raw = result as Record<string, unknown>
        const data = raw.data as Record<string, unknown> | undefined
        if (data && typeof data === "object" && "parts" in data) {
            return data as unknown as SessionPromptResponses[200]
        }
        if ("parts" in raw) {
            return raw as unknown as SessionPromptResponses[200]
        }
        return null
    }

    /**
     * Diagnostic logging for a `session.prompt()` response (WP-06).
     * Never throws and never alters control flow — observability only.
     */
    async function logPromptResponse(result: unknown, context: { sessionId: string; isRetry?: boolean }) {
        const payload = getPromptResponsePayload(result)
        const isRetry = context.isRetry ?? false
        if (!payload) {
            await log("debug", `${short(context.sessionId)} - session.prompt() response has unexpected structure: ${JSON.stringify({ sessionId: context.sessionId, isRetry, rawResponse: JSON.stringify(result) })}`)
            return
        }
        const parts = Array.isArray(payload.parts) ? payload.parts : []
        const partsCount = parts.length
        const info = payload.info && typeof payload.info === "object" ? payload.info : undefined
        const infoKeys = info ? Object.keys(info) : []
        const hasParts = partsCount > 0

        await log("debug", `${short(context.sessionId)} - session.prompt() response received: ${JSON.stringify({ sessionId: context.sessionId, isRetry, hasParts, partsCount, infoKeys, info })}`)

        if (partsCount === 0) {
            await log("warn", `${short(context.sessionId)} - session.prompt() returned empty parts array - possible stream initiation failure: ${JSON.stringify({ sessionId: context.sessionId, isRetry, responseInfo: info, partsCount })}`)
        }

        if (info && "error" in info) {
            await log("warn", `${short(context.sessionId)} - session.prompt() response.info contains error indicator: ${JSON.stringify({ sessionId: context.sessionId, isRetry, errorInfo: info.error })}`)
        }

        await log("debug", `${short(context.sessionId)} - session.prompt() raw response: ${JSON.stringify({ sessionId: context.sessionId, isRetry, rawResponse: JSON.stringify(result, null, 2) })}`)
    }

    async function sendContinuePrompt(sid: string, text: string, w: SessionWatch) {
        if (w.continuing && !w.watchdogRetryGuard) {
            await log("debug", `${short(sid)} - continue already in progress, skipping`)
            return
        }
        if (w.userCancelled || w.completionSignaled) return
        if (!w.continuing) dbg(`State transition on ${short(sid)}: continuing=false -> true`)
        w.continuing = true
        if (w.watchdogRetryGuard) {
            // Watchdog retry: keep the recovery armed so the retried prompt's
            // own deferred watchdog continues the escalation chain (WP-05).
            w.pendingRecovery = true
        }
        w.watchdogRetryGuard = false
        
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

            dbg(`Recovery prompt sent to ${short(sid)}: prompt="${text.length > 80 ? `${text.slice(0, 80)}...` : text}", agent=${agent ?? "(default)"}, model=${model ? `${model.providerID}/${model.modelID}` : "(default)"}`)
            // Re-check: ESC (or completion) may have landed while the session
            // messages were being fetched above — never send into a cancelled
            // session. (finally below resets the continuing flag on return.)
            if (w.userCancelled || w.completionSignaled) return
            const response = await ctx.client.session.prompt({
                path: { id: sid },
                body: {
                    parts: [{ type: "text", text }],
                    agent,
                    model,
                },
            })
            await logPromptResponse(response, { sessionId: sid })
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
                const retryResponse = await ctx.client.session.prompt({
                    path: { id: sid },
                    body: { parts: [{ type: "text", text }], agent, model },
                })
                await logPromptResponse(retryResponse, { sessionId: sid, isRetry: true })
                recordContinue(sid)
                w.lastRetryAt = Date.now()
            } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
                await log("error", `${short(sid)} - prompt retry also failed: ${retryMsg}`)
                throw retryErr
            }
        } finally {
            if (w.continuing) dbg(`State transition on ${short(sid)}: continuing=true -> false`)
            w.continuing = false
            w.todoCheckAttempts = 0
            if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
        }
        // Deferred check: verify the session went busy after prompt.
        // If this was a streaming-failure recovery (pendingRecovery armed),
        // retry up to maxRecoveryRetries and then escalate to abort+resume.
        setTimeout(async () => {
            if (w.status !== "busy") {
                if (w.pendingRecovery) {
                    // Disarm on ESC/completion: without this the retry burns an
                    // attempt (or escalates) on a dead session, and the still-
                    // armed recovery refires spuriously once the user re-engages.
                    if (w.userCancelled || w.completionSignaled) {
                        w.pendingRecovery = false
                        w.pendingRecoveryReason = null
                        w.recoveryAttempts = 0
                        await log("info", `${short(sid)} - recovery disarmed: session cancelled/completed while awaiting watchdog`)
                    } else if (w.recoveryAttempts < maxRecoveryRetries) {
                        w.recoveryAttempts++
                        dbg(`State transition on ${short(sid)}: recoveryAttempts=${w.recoveryAttempts - 1} -> ${w.recoveryAttempts}`)
                        w.watchdogRetryGuard = true
                        await log("warn", `${short(sid)} - recovery attempt ${w.recoveryAttempts}/${maxRecoveryRetries} after prompt timeout`)
                        await log("warn", `Recovery failed on ${short(sid)} - session still ${w.status}: attempt=${w.recoveryAttempts}, maxRetries=${maxRecoveryRetries}, nextAction=retry`)
                        dbg(`Watchdog check on ${short(sid)}: status=${w.status}, recoveryAttempts=${w.recoveryAttempts}, maxRetries=${maxRecoveryRetries}, watchdogLatencyMs=${Date.now() - w.lastRetryAt} -> RETRY`)
                        const retryBackoffMs = backoffMs(w.recoveryAttempts, baseBackoffMs, maxBackoffMs)
                        await log("info", `Retrying recovery on ${short(sid)}: attempt=${w.recoveryAttempts}, backoffMs=${retryBackoffMs}`)
                        dbg(`Retrying recovery on ${short(sid)}: recoveryAttempts=${w.recoveryAttempts}, backoffMs=${retryBackoffMs}, pendingRecoveryReason=${w.pendingRecoveryReason}`)
                        try {
                            await sendContinuePrompt(sid, continuePrompt, w)
                        } catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err)
                            await log("warn", `${short(sid)} - recovery retry failed: ${errMsg}`)
                            // Let the timer loop re-initiate the recovery
                            w.recoveryAttempts = 0
                        }
                        w.watchdogRetryGuard = false
                    } else {
                        dbg(`Pending recovery cleared on ${short(sid)}: reason=recovery-attempt`)
                        w.pendingRecovery = false
                        await log("warn", `${short(sid)} - max recovery attempts (${maxRecoveryRetries}) reached, escalating to abort+resume`)
                        await log("warn", `Recovery failed on ${short(sid)} - session still ${w.status}: attempt=${w.recoveryAttempts}, maxRetries=${maxRecoveryRetries}, nextAction=abort-resume`)
                        await log("warn", `Escalating to abort+resume on ${short(sid)}: attempt=${w.recoveryAttempts}`)
                        dbg(`Watchdog check on ${short(sid)}: status=${w.status}, recoveryAttempts=${w.recoveryAttempts}, maxRetries=${maxRecoveryRetries}, watchdogLatencyMs=${Date.now() - w.lastRetryAt} -> ABORT_RESUME`)
                        const resumed = await tryAbortAndResume(sid, w)
                        if (!resumed && !w.aborting) {
                            await log("warn", `Recovery exhausted on ${short(sid)}: attempts=${w.recoveryAttempts}, lastError=abort+resume failed`)
                            dbg(`Watchdog check on ${short(sid)}: status=${w.status} -> GAVE_UP`)
                            if (w.pendingRecoveryAt > 0) {
                                dbg(`Total recovery cycle on ${short(sid)} (failed): totalCycleMs=${Date.now() - w.pendingRecoveryAt}`)
                            }
                        }
                    }
                } else {
                    await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
                }
            } else {
                const elapsedMs = Date.now() - w.lastRetryAt
                await log("info", `Recovery successful on ${short(sid)}: elapsedMs=${elapsedMs}`)
                dbg(`Watchdog check on ${short(sid)}: status=busy, elapsedMs=${elapsedMs} -> SUCCESS`)
                if (w.pendingRecoveryAt > 0) {
                    dbg(`Total recovery cycle on ${short(sid)}: totalCycleMs=${Date.now() - w.pendingRecoveryAt}`)
                }
            }
        }, toolTextCheckDelayMs)
    }

    function extractMessages(response: Record<string, unknown>): Array<Record<string, unknown>> {
        if (Array.isArray(response)) return response
        if (Array.isArray(response.data)) return response.data
        if (Array.isArray(response.messages)) return response.messages
        return []
    }

    // Awaiting-input gate: a trailing pending tool_use part (e.g. the
    // question tool waiting on the user) means the ball is in the user's
    // court — the session is NOT stalled, so no idle check may prompt.
    // A newer user message clears the gate.
    function hasPendingUserInput(messages: Array<Record<string, unknown>>): boolean {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            const rawRole = (msg.role ?? (msg.info as Record<string, unknown> | undefined)?.role) as string | undefined
            if (rawRole === "user") return false
            if (rawRole !== "assistant") continue
            const parts = msg.parts as Array<Record<string, unknown>> | undefined
            if (!parts) return false
            for (const part of parts) {
                if ((part.type as string) !== "tool_use") continue
                const state = part.state as Record<string, unknown> | undefined
                if ((state?.status as string | undefined) === "pending") return true
            }
            return false
        }
        return false
    }

    // Active-user suppression: the awaiting-input gate only covers a formally
    // pending tool_use — but a composing user leaves no pending tool call.
    // Any inbound user message inside activeUserWindowMs means the user is
    // engaged, so idle nudges stand down.
    function userRecentlyActive(w: SessionWatch): boolean {
        return w.lastUserMessageAt > 0 && Date.now() - w.lastUserMessageAt < activeUserWindowMs
    }

    const messagesInflight = new Map<string, Promise<Array<Record<string, unknown>>>>()

    async function getSessionMessages(sid: string): Promise<Array<Record<string, unknown>>> {
        const inflight = messagesInflight.get(sid)
        if (inflight) return inflight
        const p = (async () => {
            try {
                const response = await ctx.client.session.messages({ path: { id: sid } })
                return extractMessages(response as Record<string, unknown>)
            } finally {
                messagesInflight.delete(sid)
            }
        })()
        messagesInflight.set(sid, p)
        return p
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

    // In-memory cache + inflight dedup to avoid concurrent SQLite reads
    const todoCache = new Map<string, { todos: Todo[]; fetchedAt: number }>()
    const todoInflight = new Map<string, Promise<Todo[]>>()
    const TODO_CACHE_TTL_MS = 2000

    async function fetchSessionTodos(sid: string): Promise<Todo[]> {
        if (typeof sid !== "string" || !sid.startsWith("ses")) return []
        // Cache hit — avoid hitting the DB if we fetched recently
        const cached = todoCache.get(sid)
        if (cached && Date.now() - cached.fetchedAt < TODO_CACHE_TTL_MS) return cached.todos
        // Dedup concurrent calls for the same session — only one DB query at a time
        const inflight = todoInflight.get(sid)
        if (inflight) return inflight
        const p = (async () => {
            try {
                const todoFn = (ctx.client.session as any).todo
                if (typeof todoFn !== "function") return []
                const response = await todoFn.call(ctx.client.session, { path: { id: sid } })
                const rawTodos = ((response as Record<string, unknown>).data ?? response) as unknown
                if (!Array.isArray(rawTodos)) return []
                const todos = rawTodos.map((t) => ({
                    content: (t?.content as string) ?? "",
                    status: (t?.status as Todo["status"]) ?? "pending",
                    priority: (t?.priority as Todo["priority"]) ?? "medium",
                }))
                todoCache.set(sid, { todos, fetchedAt: Date.now() })
                return todos
            } catch {
                return []
            } finally {
                todoInflight.delete(sid)
            }
        })()
        todoInflight.set(sid, p)
        return p
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

        let magicContextDetected: boolean | null = null

    /**
     * True when the magic-context plugin appears in the host's configured
     * plugin list. Fail-safe: any error or missing data returns false without
     * caching, so a transient failure can be re-checked later.
     */
    async function isMagicContextInstalled(): Promise<boolean> {
        if (magicContextDetected !== null) return magicContextDetected
        try {
            const res = await (ctx.client as { config?: { get?: () => Promise<unknown> } }).config?.get?.()
            const cfg = (res as { data?: { plugin?: unknown } } | undefined)?.data
            const plugins = cfg?.plugin
            if (!Array.isArray(plugins)) {
                dbg("magic-context detection: plugin list unavailable, treating as not installed")
                return false
            }
            magicContextDetected = plugins.some((p) => {
                const spec = typeof p === "string" ? p : Array.isArray(p) ? String(p[0]) : ""
                return spec.toLowerCase().includes("magic-context")
            })
            return magicContextDetected
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            dbg(`magic-context detection failed, treating as not installed: ${errMsg}`)
            return false
        }
    }

    const usableLimitCache = new Map<string, number>()

    /**
     * Usable context window for a session's model, mirroring OpenCode's own
     * overflow math: context - min(20k, maxOutput). Returns null when the
     * model or its limits cannot be determined (fail-safe: no intervention).
     */
    async function getUsableContextLimit(sid: string): Promise<number | null> {
        try {
            const msgs = await getSessionMessages(sid)
            let model: { providerID?: string; modelID?: string } | undefined
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i] as Record<string, unknown>
                if ((m.role as string) === "user") {
                    model = (m.model ?? (m.info as Record<string, unknown> | undefined)?.model) as
                        | { providerID?: string; modelID?: string }
                        | undefined
                    break
                }
            }
            if (!model || typeof model.providerID !== "string" || typeof model.modelID !== "string") {
                return null
            }
            const key = `${model.providerID}/${model.modelID}`
            const cached = usableLimitCache.get(key)
            if (cached !== undefined) return cached
            const res = await (ctx.client as { provider?: { get?: () => Promise<unknown> } }).provider?.get?.()
            const providers = ((res as { data?: unknown } | undefined)?.data ?? res) as
                | Array<Record<string, unknown>>
                | undefined
            if (!Array.isArray(providers)) return null
            const prov = providers.find((p) => p.id === model!.providerID)
            const models = prov?.models as Array<Record<string, unknown>> | undefined
            const entry = models?.find((x) => x.id === model!.modelID)
            const limit = entry?.limit as { context?: number; output?: number } | undefined
            if (!limit || typeof limit.context !== "number" || limit.context === 0) return null
            const usable = limit.context - Math.min(20_000, limit.output ?? 0)
            usableLimitCache.set(key, usable)
            return usable
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            dbg(`usable-context-limit lookup failed for ${short(sid)}: ${errMsg}`)
            return null
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
        w.liveToolSigs = []
        w.toolLoopAttempts = 0
        if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
        w.pendingRecovery = false
        w.pendingRecoveryReason = null
        w.pendingRecoveryAt = 0
        w.recoveryAttempts = 0
        w.watchdogRetryGuard = false
    }

    function resetBusyFlags(w: SessionWatch) {
        w.resumeAttempts = 0
        w.lastRetryAt = 0
        w.pendingTools = 0
        w.pendingCommands = 0
        w.gaveUp = false
        w.orphanWatchStartAt = null
        w.aborting = false
        w.toolTextRecovered = false
        w.toolTextAttempts = 0
        w.todoCheckAttempts = 0
        w.checkingToolText = false
        w.interruptedContinueCount = 0
        w.recentToolCalls = []
        w.liveToolSigs = []
        w.toolLoopAttempts = 0
        w.contextWrapupAttempts = 0
        w.pendingRecovery = false
        w.pendingRecoveryReason = null
        w.pendingRecoveryAt = 0
        w.recoveryAttempts = 0
        w.watchdogRetryGuard = false
        if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
        // Reset nudge budget on each genuine new busy→work cycle (user prompt or agent re-engagement after nudge)
        w.todoNudgeAttempts = 0
        // PRESERVE doneClaimNoTodosAttempts: re-armed only by an inbound user
        // message (genuine new work cycle). Resetting it here let the
        // done-claim-no-todos prompt refire unboundedly across cycles (#26).
        w.continueTimestamps = []
        // PRESERVE: userCancelled, completionSignaled, idleSince, continuing
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

    /**
     * Live loop detection over name+args fingerprints: fires on 3+ identical
     * consecutive signatures within the last 5, or a repeating cycle (length
     * 2-5) occurring at least three times — the alternating-identical-calls
     * case name-only tracking cannot see.
     */
    function detectLiveToolLoop(sigs: string[]): "consecutive" | "pattern" | null {
        if (sigs.length < 6) return null
        const last = sigs[sigs.length - 1]
        if (sigs.slice(-5).filter((s) => s === last).length >= 3) return "consecutive"
        if (detectPatternLoop(sigs)) return "pattern"
        return null
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
        dbg(`checkForToolCallAsText called for ${short(sid)}, userCancelled=${w.userCancelled}, toolTextRecovered=${w.toolTextRecovered}, toolTextAttempts=${w.toolTextAttempts}`)

        // Backoff for tool-text recovery
        if (w.toolTextAttempts > 0) {
            const elapsed = Date.now() - w.lastRetryAt
            const requiredBackoff = backoffMs(w.toolTextAttempts, baseBackoffMs, maxBackoffMs)
            if (elapsed < requiredBackoff) return
        }

        if (w.toolTextAttempts >= maxRetries) return

        await log("debug", `${short(sid)} - checking for tool-call-as-text (attempt ${w.toolTextAttempts + 1})`)

        try {
            const messages = await getSessionMessages(sid)
            if (hasPendingUserInput(messages)) {
                w.checkingToolText = false
                await log("info", `${short(sid)} - awaiting user input (pending tool_use), skipping tool-text check`)
                return
            }
            if (userRecentlyActive(w)) {
                w.checkingToolText = false
                await log("info", `${short(sid)} - user recently active, skipping tool-text check`)
                return
            }
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
                                prompt: continuePrompt,
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
                            prompt: isReasoning ? thinkingToolRecoveryPrompt : toolTextRecoveryPrompt,
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
                                    prompt: continuePrompt,
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
                                ? doneWithoutWorkPrompt
                                : continuePrompt,
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
                            prompt: doneWithoutWorkPrompt,
                            source: "done-claim-no-emoji",
                            priority: 1,
                        }
                    } else if (containsWorkDescription(allAssistantText)) {
                        await log("info", `${short(sid)} - model claims done with no open todos, but the response already contains a work description. Skipping details prompt...`)
                    } else if (w.doneClaimNoTodosAttempts < maxRetries) {
                        await log("info", `${short(sid)} - model claims done with no open todos. Sending details prompt (attempt ${w.doneClaimNoTodosAttempts + 1}/${maxRetries})...`)
                        bestCandidate = {
                            prompt: doneWithoutDetailsPrompt,
                            source: "done-claim-no-todos",
                            priority: 1,
                        }
                    }
                    }
                }
            }

            if (resumeOnActionIntent) {
                const lastAssistantMsg = messages.slice().reverse().find(m => (m.role ?? (m.info as Record<string, unknown> | undefined)?.role) === "assistant")
                if (lastAssistantMsg) {
                    let lastAssistantText = ""
                    for (const part of ((lastAssistantMsg.parts as Array<Record<string, unknown>> | undefined) || [])) {
                        lastAssistantText += (part.text as string ?? "") + "\n"
                    }
                    if (containsActionIntent(lastAssistantText)) {
                        dbg(`ACTION INTENT DETECTED in checkForToolCallAsText for ${short(sid)}`)
                        const candidate = {
                            prompt: actionIntentPrompt,
                            source: "action-intent",
                            priority: 2,
                        }
                        if (!bestCandidate || candidate.priority < bestCandidate.priority) {
                            bestCandidate = candidate
                        }
                    }
                }
            }

            const trimmedText = allAssistantText.trim()
            const normalized = trimmedText.replace(/[.!?]+$/, '')
            if (normalized.endsWith('🎉') && (!bestCandidate || bestCandidate.priority > 0)) {
                const openCount = getOpenTodos(w.todos || []).length
                if (openCount > 0) {
                    await log("info", `${short(sid)} - 🎉 detected but ${openCount} open todos remain, NOT latching completion`)
                } else {
                    await log("info", `${short(sid)} - 🎉 completion detected, skipping continue`)
                    w.toolTextRecovered = true
                    w.completionSignaled = true
                    if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
                    return
                }
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
                    if (isOpenTodosReminder) w.todoNudgeAttempts++
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
        if (w.userCancelled || w.completionSignaled) return false
        if (w.aborting) return false

        const idleSec = Math.round((Date.now() - (w.orphanWatchStartAt ?? w.lastActivityAt)) / 1000)
        await log("info", `Abort+Resume on ${short(sid)} (${idleSec}s idle). Aborting...`)

        w.pluginAbortInFlight = true
        try {
            await ctx.client.session.abort({ path: { id: sid } })
            await log("info", `${short(sid)} - abort OK`)
            dbg(`Abort succeeded on ${short(sid)}, waiting ${ABORT_CONTINUE_DELAY_MS}ms before continue prompt`)
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            await log("warn", `${short(sid)} - abort failed: ${errMsg}`)
            w.aborting = false
            w.pluginAbortInFlight = false
            return false
        }

        await new Promise<void>((resolve) => setTimeout(resolve, ABORT_CONTINUE_DELAY_MS))

        if (w.status === "busy") w.status = "idle"

        // ESC (or completion) may have landed during the abort delay —
        // re-check before continuing into a cancelled session.
        if (w.userCancelled || w.completionSignaled) {
            w.aborting = false
            await log("info", `${short(sid)} - abort+resume stood down: session cancelled/completed during abort delay`)
            return false
        }

        try {
            await sendContinuePrompt(sid, continuePrompt, w)
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
        } finally {
            w.pluginAbortInFlight = false
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
        const requiredBackoff = backoffMs(w.resumeAttempts, baseBackoffMs, maxBackoffMs)
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
            await sendContinuePrompt(sid, prompt ?? continuePrompt, w)
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
                        log("debug", `Discovered session ${short(sid)} via list() — fetching todos`)
                        const fetched = await fetchSessionTodos(sid)
                        if (fetched.length > 0) {
                            const w = sessions.get(sid)!
                            w.todos = fetched
                        }
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
            await safe(async () => {
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
                if (w.userCancelled || w.completionSignaled) continue
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
                            dbg(`State transition on ${short(sid)}: gaveUp=false -> true`)
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
                    if (busyStallStrategy === "off") {
                        dbg(`Stream stall on ${short(sid)} ignored (busyStallStrategy=off)`)
                        continue
                    }
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
                            if (busyStallStrategy === "abort") {
                                await log("info", `Stream stall on ${short(sid)} (busyStallStrategy=abort): aborting before continue`)
                                tryAbortAndResume(sid, w)
                            } else {
                                tryResume(sid, w, "Stream stall")
                            }
                        } else if (!w.gaveUp) {
                            w.gaveUp = true
                            dbg(`State transition on ${short(sid)}: gaveUp=false -> true`)
                            log("warn", `${short(sid)} - all ${maxRetries} retries exhausted.`)
                        }
                    }
                }
            }

            // Periodic idle session recheck: resume idle sessions with open todos
            for (const [sid, w] of sessions) {
                // Pending recovery: trigger deferred recovery for streaming failures (WP-04)
                if (
                    w.pendingRecovery &&
                    w.status === "idle" &&
                    !w.userCancelled &&
                    !w.aborting &&
                    !w.continuing &&
                    !w.gaveUp &&
                    // recoveryAttempts === 0: the watchdog chain owns the
                    // counter once the first recovery send is initiated (WP-05)
                    w.recoveryAttempts === 0
                ) {
                    dbg(`Pending recovery check on ${short(sid)}: pendingRecovery=${w.pendingRecovery}, status=${w.status}, userCancelled=${w.userCancelled}, aborting=${w.aborting}, continuing=${w.continuing}, gaveUp=${w.gaveUp}, recoveryAttempts=${w.recoveryAttempts}, pendingRecoveryAt=${w.pendingRecoveryAt}`)
                    const elapsed = Date.now() - w.pendingRecoveryAt
                    const requiredBackoff = backoffMs(w.recoveryAttempts, baseBackoffMs, maxBackoffMs)
                    if (elapsed < requiredBackoff) {
                        dbg(`Backoff check on ${short(sid)}: elapsed=${elapsed}ms, required=${requiredBackoff}ms, attempt=${w.recoveryAttempts}, pass=false`)
                        dbg(`Pending recovery on ${short(sid)} waiting for backoff: ${requiredBackoff - elapsed}ms remaining`)
                        continue
                    }
                    dbg(`Backoff check on ${short(sid)}: elapsed=${elapsed}ms, required=${requiredBackoff}ms, attempt=${w.recoveryAttempts}, pass=true`)
                    await log("info", `Pending recovery triggered on ${short(sid)}: reason=${w.pendingRecoveryReason}, attempt=${w.recoveryAttempts + 1}, maxRetries=${maxRecoveryRetries}`)
                    dbg(`Recovery timing on ${short(sid)}: detectionToAttemptMs=${Date.now() - w.pendingRecoveryAt}`)
                    w.recoveryAttempts++
                    dbg(`State transition on ${short(sid)}: recoveryAttempts=${w.recoveryAttempts - 1} -> ${w.recoveryAttempts}`)
                    // Keep pendingRecovery armed: the deferred watchdog (WP-05)
                    // verifies this recovery and retries/escalates on failure.
                    try {
                        await sendContinuePrompt(sid, continuePrompt, w)
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        await log("warn", `${short(sid)} - pending recovery failed: ${errMsg}`)
                        w.recoveryAttempts = 0
                    }
                }

                if (w.status !== "idle") continue
                if (w.isSubagent) continue
                if (w.userCancelled || w.completionSignaled) continue
                if (w.continuing) continue
                if (busyCount() !== 0) continue
                // Awaiting-input gate (same contract as the session.idle
                // block): a trailing pending tool_use means the user holds
                // the ball — the periodic open-todos nudge must stand down
                // too. Without this it fires with no question asked whenever
                // the session has open todos.
                try {
                    if (hasPendingUserInput(await getSessionMessages(sid))) {
                        await log("info", `${short(sid)} - awaiting user input (pending tool_use), skipping periodic open-todos nudge`)
                        continue
                    }
                } catch (e) {
                    dbg(`periodic recheck sid=${short(sid)}: awaiting-input check error: ${e}`)
                }
                // Active-user suppression: inbound user message inside the
                // window means the user is engaged (likely composing) — the
                // session is NOT abandoned, skip the periodic nudge too.
                if (userRecentlyActive(w)) {
                    await log("info", `${short(sid)} - user recently active, skipping periodic open-todos nudge`)
                    continue
                }
                // Lazy fetch: if we never received a todo.updated event, try the API
                if ((w.todos || []).length === 0) {
                    const fetched = await fetchSessionTodos(sid)
                    if (fetched.length > 0) {
                        w.todos = fetched
                    }
                }
                const open = getOpenTodos(w.todos || [])
                if (open.length === 0) continue
                if (w.todoNudgeAttempts >= maxRetries) continue
                const elapsedSinceLastNudge = Date.now() - w.lastRetryAt
                const requiredBackoff = backoffMs(w.todoNudgeAttempts, baseBackoffMs, maxBackoffMs)
                if (w.lastRetryAt > 0 && elapsedSinceLastNudge < requiredBackoff) continue
                const isCelebration = await lastAssistantEndsWithCelebration(sid)
                if (isCelebration) {
                    const openCount = getOpenTodos(w.todos || []).length
                    if (openCount > 0) {
                        await log("info", `${short(sid)} - 🎉 detected in periodic recheck but ${openCount} open todos remain, NOT latching completion`)
                    } else {
                        w.toolTextRecovered = true
                        w.completionSignaled = true
                    }
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
            }, "periodic timer")
        }, checkIntervalMs)

        if (timer.unref) timer.unref()

        // Periodic session discovery
        discoveryTimer = setInterval(() => {
            safe(discoverSessions, "discoveryTimer").catch(() => {})
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
                    if (w.pendingRecovery) {
                        dbg(`Pending recovery cleared on ${short(sid)}: reason=session-busy`)
                    }
                    resetBusyFlags(w)
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

                    // Subagent context saturation: subagents never enter the
                    // parent-only recovery block below, so the opt-in native
                    // compaction safety net is handled here with its own gates.
                    // No magic-context detection: session.summarize() is native
                    // and works with or without magic-context installed.
                    if (w.isSubagent) {
                        try {
                            let subAwaitingInput = false
                            try {
                                subAwaitingInput = hasPendingUserInput(await getSessionMessages(sid))
                            } catch (e) {
                                dbg(`session.idle sid=${short(sid)}: awaiting-input check error: ${e}`)
                            }
                            if (subAwaitingInput) {
                                await log("info", `${short(sid)} - awaiting user input (pending tool_use), skipping subagent saturation check`)
                            } else if (userRecentlyActive(w)) {
                                await log("info", `${short(sid)} - user recently active, skipping subagent saturation check`)
                            } else if (
                                w.lastTokenTotal > 0 &&
                                w.contextWrapupAttempts < 1 &&
                                !w.userCancelled &&
                                !w.completionSignaled &&
                                !w.aborting
                            ) {
                                const usable = await getUsableContextLimit(sid)
                                if (
                                    usable &&
                                    w.lastTokenTotal / usable >= contextSaturationThreshold
                                ) {
                                    if (subagentNativeCompactionEnabled) {
                                        w.contextWrapupAttempts++
                                        await log(
                                            "warn",
                                            `${short(sid)} - context saturation (subagent): ${w.lastTokenTotal}/${usable} tokens (${Math.round((w.lastTokenTotal / usable) * 100)}% of usable); triggering native compaction`,
                                        )
                                        if (w.userCancelled || w.completionSignaled) break
                                        await ctx.client.session.summarize({ path: { id: sid } })
                                    }
                                }
                            }
                        } catch (e) {
                            const errMsg =
                                e instanceof Error ? e.message : String(e)
                            dbg(
                                `session.idle sid=${short(sid)}: context-saturation check error: ${errMsg}`,
                            )
                        }
                    }

                    if (!w.isSubagent) {
                        // Awaiting-input gate: trailing pending tool_use (e.g. an
                        // open question) means the user holds the ball — skip the
                        // whole idle block, no check may prompt. Re-evaluated on
                        // the next idle event after the user answers. Computed
                        // once here so every idle check below (streaming,
                        // dead-stream, context, open-todos) shares it.
                        let awaitingUserInput = false
                        try {
                            awaitingUserInput = hasPendingUserInput(await getSessionMessages(sid))
                        } catch (e) {
                            dbg(`session.idle sid=${short(sid)}: awaiting-input check error: ${e}`)
                        }
                        if (awaitingUserInput) {
                            await log("info", `${short(sid)} - awaiting user input (pending tool_use), standing down all idle checks/nudges`)
                        }
                        if (
                            !awaitingUserInput &&
                            !w.pendingRecovery &&
                            !w.completionSignaled &&
                            !w.userCancelled &&
                            !w.aborting
                        ) {
                            try {
                                const errInfo = getLastAssistantError(
                                    await getSessionMessages(sid),
                                )
                                if (
                                    errInfo &&
                                    isStreamingFailure(
                                        errInfo.name,
                                        errInfo.message,
                                        streamingFailureErrorNames,
                                        streamingFailureMessagePatterns,
                                    )
                                ) {
                                    w.pendingRecovery = true
                                    w.pendingRecoveryReason = errInfo.name
                                    w.pendingRecoveryAt = Date.now()
                                    dbg(
                                        `State transition on ${short(sid)}: pendingRecovery=false -> true, reason=${errInfo.name}`,
                                    )
                                    await log(
                                        "info",
                                        `${short(sid)} - streaming failure detected on idle: ${errInfo.name} - ${errInfo.message}`,
                                    )
                                    await tryResume(
                                        sid,
                                        w,
                                        "Streaming failure on idle",
                                        continuePrompt,
                                    )
                                }
                            } catch (e) {
                                const errMsg =
                                    e instanceof Error ? e.message : String(e)
                                dbg(
                                    `session.idle sid=${short(sid)}: streaming-failure check error: ${errMsg}`,
                                )
                            }

                            // Silent dead stream: the newest assistant message has a
                            // finish reason but no text parts (e.g. reasoning-only,
                            // finish=unknown). A delivered text answer means the session
                            // completed normally — no recovery.
                            try {
                                const dead = getLastSilentDeadStream(
                                    await getSessionMessages(sid),
                                )
                                if (
                                    dead &&
                                    dead.outputTokens >= silentDeadStreamMinTokens
                                ) {
                                    let busyAgain = false
                                    try {
                                        const liveStatus = (await getSessionStatusMap())[sid]
                                        busyAgain = liveStatus === "busy" || liveStatus === "retry"
                                    } catch (e) {
                                        dbg(
                                            `session.idle sid=${short(sid)}: silent-dead-stream status check failed: ${e instanceof Error ? e.message : String(e)}`,
                                        )
                                    }
                                    if (busyAgain) {
                                        dbg(
                                            `session.idle sid=${short(sid)}: silent-dead-stream recovery skipped, session is busy/retry again`,
                                        )
                                    } else {
                                        w.pendingRecovery = true
                                        w.pendingRecoveryReason = `silent-${dead.finish}`
                                        w.pendingRecoveryAt = Date.now()
                                        await log(
                                            "info",
                                            `${short(sid)} - silent dead stream: finish=${dead.finish}, ${dead.outputTokens} output tokens, no text parts; resuming`,
                                        )
                                        await tryResume(
                                            sid,
                                            w,
                                            `Silent dead stream (${dead.finish})`,
                                            continuePrompt,
                                        )
                                    }
                                }
                            } catch (e) {
                                const errMsg =
                                    e instanceof Error ? e.message : String(e)
                                dbg(
                                    `session.idle sid=${short(sid)}: silent-dead-stream check error: ${errMsg}`,
                                )
                            }

                            // Context saturation (parent sessions only — subagents
                            // are handled above): the last assistant message used
                            // >= threshold of the model's usable window. When
                            // magic-context manages the session (its setup disables
                            // native compaction), trigger its wrapup command rather
                            // than native compaction, which would double-compress.
                            try {
                                if (
                                    w.lastTokenTotal > 0 &&
                                    w.contextWrapupAttempts < 1 &&
                                    !w.userCancelled &&
                                    !w.completionSignaled &&
                                    !userRecentlyActive(w)
                                ) {
                                    const usable = await getUsableContextLimit(sid)
                                    if (
                                        usable &&
                                        w.lastTokenTotal / usable >= contextSaturationThreshold
                                    ) {
                                        const installed = await isMagicContextInstalled()
                                        if (!installed) break
                                        w.contextWrapupAttempts++
                                        await log(
                                            "warn",
                                            `${short(sid)} - context saturation: ${w.lastTokenTotal}/${usable} tokens (${Math.round((w.lastTokenTotal / usable) * 100)}% of usable); sending magic-context wrapup command`,
                                        )
                                            if (w.userCancelled || w.completionSignaled) break
                                            await ctx.client.session.command({
                                            path: { id: sid },
                                            body: { command: CTX_WRAPUP_TRIGGER, arguments: "" },
                                        })
                                    }
                                }
                            } catch (e) {
                                const errMsg =
                                    e instanceof Error ? e.message : String(e)
                                dbg(
                                    `session.idle sid=${short(sid)}: context-saturation check error: ${errMsg}`,
                                )
                            }
                        }

                        let todos = w.todos || []
                        // Lazy fetch: if we never received a todo.updated event, try the API
                        if (todos.length === 0) {
                            const fetched = await fetchSessionTodos(sid)
                            if (fetched.length > 0) {
                                w.todos = fetched
                                todos = fetched
                            }
                        }
                        const open = getOpenTodos(todos)
                        
                        if (open.length > 0 && currentBusy === 0 && !awaitingUserInput && !userRecentlyActive(w) && !w.completionSignaled && !w.userCancelled && w.todoNudgeAttempts < maxRetries) {
                            const isCelebration = await lastAssistantEndsWithCelebration(sid)
                            await log("info", `${short(sid)} - open todos=${open.length}, isCelebration=${isCelebration}, currentBusy=${currentBusy}`)
                            if (isCelebration) {
                                // 🎉 with open todos is a FALSE POSITIVE - don't latch completionSignaled, send nudge
                                await log("info", `${short(sid)} - 🎉 detected but ${open.length} open todos remain, sending nudge`)
                                const reminder = buildOpenTodosReminder(todos)
                                await tryResume(sid, w, "Idle with open todos (celebration false positive)", reminder)
                                w.todoNudgeAttempts++
                            } else {
                                const reminder = buildOpenTodosReminder(todos)
                                await tryResume(sid, w, "Idle with open todos", reminder)
                                w.todoNudgeAttempts++
                            }
                        }
                    }

                    if (!w.completionSignaled && !w.userCancelled && w.toolTextAttempts < maxRetries) {
                        if (resumeOnActionIntent && !w.toolTextRecovered) {
                            const idleSid = sid
                            const idleW = w
                            setTimeout(async () => {
                                try {
                                    if (Date.now() - idleW.createdAt < warmupMs) {
                                        dbg(`session.idle sid=${short(idleSid)}: skipping action intent, session is warming up (${Date.now() - idleW.createdAt}ms < ${warmupMs}ms)`)
                                        return
                                    }
                                    const msgs = await getSessionMessages(idleSid)
                                    if (hasPendingUserInput(msgs)) {
                                        dbg(`session.idle sid=${short(idleSid)}: awaiting user input, skipping action-intent prompt`)
                                        return
                                    }
                                    if (userRecentlyActive(idleW)) {
                                        dbg(`session.idle sid=${short(idleSid)}: user recently active, skipping action-intent prompt`)
                                        return
                                    }
                                    const lastAssistantMsg = msgs.slice().reverse().find(m => (m.role ?? (m.info as Record<string, unknown> | undefined)?.role) === "assistant")
                                    if (lastAssistantMsg) {
                                        let lastText = ""
                                        for (const part of ((lastAssistantMsg.parts as Array<Record<string, unknown>> | undefined) || [])) {
                                            lastText += (part.text as string ?? "") + "\n"
                                        }
                                        if (containsActionIntent(lastText)) {
                                            const w2 = sessions.get(idleSid)
                                             if (!w2 || w2.toolTextRecovered || w2.completionSignaled || w2.userCancelled || w2.status !== "idle") return
                                            w2.toolTextRecovered = true
                                            w2.toolTextAttempts++
                                            dbg(`session.idle sid=${short(idleSid)}: ACTION INTENT DETECTED, sending "${actionIntentPrompt.slice(0, 40)}..."`)
                                            await sendContinuePrompt(idleSid, actionIntentPrompt, w2)
                                        }
                                    }
                                } catch (e) {
                                    dbg(`session.idle sid=${short(idleSid)}: delayed check error: ${e}`)
                                }
                            }, 500)
                        }

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
                const createdProps = ev.properties as Record<string, unknown> | undefined
                const parentID = (createdProps?.parentID ??
                    (createdProps?.session as Record<string, unknown> | undefined)?.parentID) as
                    | string
                    | undefined
                w.isSubagent = typeof parentID === "string" && parentID.length > 0
                log("debug", `New session: ${short(sid)} (${sessions.size})${w.isSubagent ? " [subagent]" : ""}`)
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
                    dbg(`session.idle sid=${short(sid)}: resetIdleFlags done, toolTextRecovered=${w.toolTextRecovered}, toolTextAttempts=${w.toolTextAttempts}, maxRetries=${maxRetries}`)

                    if (resumeOnActionIntent && !w.toolTextRecovered && !w.completionSignaled) {
                        setTimeout(async () => {
                            try {
                                if (Date.now() - w.createdAt < warmupMs) {
                                    dbg(`session.idle sid=${short(sid)}: skipping action intent, session is warming up (${Date.now() - w.createdAt}ms < ${warmupMs}ms)`)
                                    return
                                }
                                const msgs = await getSessionMessages(sid)
                                if (hasPendingUserInput(msgs)) {
                                    dbg(`session.idle sid=${short(sid)}: awaiting user input, skipping action-intent prompt`)
                                    return
                                }
                                const w2pre = sessions.get(sid)
                                if (w2pre && userRecentlyActive(w2pre)) {
                                    dbg(`session.idle sid=${short(sid)}: user recently active, skipping action-intent prompt`)
                                    return
                                }
                                const lastAssistantMsg = msgs.slice().reverse().find(m => (m.role ?? (m.info as Record<string, unknown> | undefined)?.role) === "assistant")
                                if (lastAssistantMsg) {
                                    let lastText = ""
                                    for (const part of ((lastAssistantMsg.parts as Array<Record<string, unknown>> | undefined) || [])) {
                                        lastText += (part.text as string ?? "") + "\n"
                                    }
                                    if (containsActionIntent(lastText)) {
                                        const w2 = sessions.get(sid)
                                         if (!w2 || w2.toolTextRecovered || w2.completionSignaled || w2.userCancelled || w2.status !== "idle") return
                                        w2.toolTextRecovered = true
                                        w2.toolTextAttempts++
                                        dbg(`session.idle sid=${short(sid)}: ACTION INTENT DETECTED, sending "${actionIntentPrompt.slice(0, 40)}..."`)
                                        await sendContinuePrompt(sid, actionIntentPrompt, w2)
                                    }
                                }
                            } catch (e) {
                                dbg(`session.idle sid=${short(sid)}: delayed check error: ${e}`)
                            }
                        }, 500)
                    }

                    // Also check for tool-call-as-text on legacy idle event
                    const shouldSet = !w.toolTextRecovered && w.toolTextAttempts < maxRetries
                    if (shouldSet) {
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

            case "message.updated": {
                if (!sid) break
                const props = ev.properties as Record<string, unknown> | undefined
                const info = props?.info as Record<string, unknown> | undefined
                const role = (info?.role as string) ?? (props?.role as string)
                if (role === "user") {
                    // Genuine new work cycle: re-arm the done-claim nudge budget.
                    // (Deliberately NOT reset in resetBusyFlags — see note there.)
                    // Also stamps inbound user activity for active-user suppression.
                    const w = sessions.get(sid)
                    if (w) {
                        w.doneClaimNoTodosAttempts = 0
                        w.lastUserMessageAt = Date.now()
                    }
                    break
                }
                if (role !== "assistant") break
                const tokens = (info?.tokens ?? props?.tokens) as Record<string, unknown> | undefined
                if (!tokens) break
                const cache = tokens.cache as Record<string, unknown> | undefined
                const total =
                    (tokens.total as number) ??
                    ((tokens.input as number) ?? 0) +
                        ((tokens.output as number) ?? 0) +
                        ((cache?.read as number) ?? 0) +
                        ((cache?.write as number) ?? 0)
                if (typeof total === "number" && total > 0) {
                    const w = ensureWatch(sid)
                    w.lastActivityAt = Date.now()
                    w.lastTokenTotal = total
                }
                break
            }

            case "todo.updated": {
                if (!sid) break
                const props = ev.properties as Record<string, unknown> | undefined
                const rawTodos = props?.todos
                const todos: Array<Record<string, unknown>> = Array.isArray(rawTodos) ? rawTodos : []

                const w = ensureWatch(sid)
                w.todos = todos.map((t) => ({
                    content: (t?.content as string) ?? "",
                    status: (t?.status as Todo["status"]) ?? "pending",
                    priority: (t?.priority as Todo["priority"]) ?? "medium",
                }))
                break
            }

            case "session.error": {
                const errorObj = getError(ev)
                const errorName = (errorObj?.name as string) ?? ""
                const errorMessage =
                    (errorObj?.data as Record<string, unknown>)?.message as string | undefined ??
                    String(errorObj?.data ?? "")
                const isMessageAborted = errorName === "MessageAbortedError"

                if (isMessageAborted) {
                    for (const [wSid, w] of sessions) {
                        if (!w.pluginAbortInFlight) {
                            w.userCancelled = true
                            w.status = "idle"
                            resetIdleFlags(w)
                        }
                    }
                    log("info", "User abort (ESC)")
                    break
                }

                const isStreamingFail = isStreamingFailure(
                    errorName,
                    errorMessage,
                    streamingFailureErrorNames,
                    streamingFailureMessagePatterns,
                )

                if (isStreamingFail) {
                    if (sid) {
                        const w = sessions.get(sid)
                        if (w && w.status === "busy") {
                            w.pendingRecovery = true
                            w.pendingRecoveryReason = errorName
                            w.pendingRecoveryAt = Date.now()
                            dbg(`State transition on ${short(sid)}: pendingRecovery=false -> true, reason=${errorName}`)
                            await log("info", `Streaming failure detected on ${short(sid)}: errorName=${errorName}, errorMessage=${errorMessage}, pendingRecoveryReason=${errorName}`)
                        }
                        log("info", `Streaming failure detected: ${errorName} - ${errorMessage}`)
                    } else {
                        log("warn", `Streaming failure detected but no session ID: ${errorName} - ${errorMessage}`)
                    }
                }

                if (busyCount() === 0) break

                log("debug", `Session error: ${errorName} - ${errorMessage}`)

                if (sid) {
                    const w = sessions.get(sid)
                    if (w) { w.pendingTools = 0; w.pendingCommands = 0 }
                }
                break
            }

            case "command.executed": {
                if (!sid) break
                const w = sessions.get(sid)
                if (w) {
                    if (w.pendingRecovery) {
                        dbg(`Pending recovery cleared on ${short(sid)}: reason=user-command`)
                    }
                    resetBusyFlags(w)
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
        description: "Signal that all work is complete and stop automatic continuation prompts. Call this ONLY after finishing everything requested.",
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
                }

                w.toolTextRecovered = true
                w.completionSignaled = true
                if (w.toolTextTimer) { clearTimeout(w.toolTextTimer); w.toolTextTimer = null }
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
            handleEvent(event as Record<string, unknown>).catch((e) => {
                const msg = e instanceof Error ? e.message : String(e)
                console.error(`[auto-resume] handleEvent error: ${msg}`)
                log("error", `handleEvent error: ${msg}`).catch(() => {})
            })
        },

        config: async () => {
            log("info", `opencode-auto-resume config OK`)
        },
        tool: {
            "task_complete": taskCompleteTool,
        },

        "chat.message": async (input) => {
            const sid = input?.sessionID
            if (!sid) return
            const w = ensureWatch(sid)
            w.lastActivityAt = Date.now()
            // Recovery prompts this plugin sends via session.prompt() also land
            // here, but only while `continuing` is latched (sendContinuePrompt
            // holds it across the await). A message arriving with `continuing`
            // unset is a genuine user (or external client) prompt: a new round
            // of work, so lift the ESC back-off and the task_complete latch.
            // Busy-state resets must still preserve both flags (issue #16).
            if (w.continuing) return
            if (w.userCancelled || w.completionSignaled) {
                w.userCancelled = false
                w.completionSignaled = false
                await log("info", `${short(sid)} - new user message, re-arming auto-resume`)
            }
        },

        "tool.execute.before": async (input, hookArgs) => {
            if (!input?.sessionID) return
            const w = ensureWatch(input.sessionID)
            w.pendingTools++
            w.lastActivityAt = Date.now()

            const toolName = (input.tool as string) ?? "unknown"
            const rawArgs = (hookArgs as { args?: unknown } | undefined)?.args
                ?? (input as { args?: unknown }).args
            w.liveToolSigs.push(toolCallSignature(toolName, rawArgs))
            if (w.liveToolSigs.length > 15) w.liveToolSigs.splice(0, w.liveToolSigs.length - 15)

            const loopKind = detectLiveToolLoop(w.liveToolSigs)
            if (!loopKind || w.userCancelled || w.toolLoopAttempts >= 2 || w.pluginAbortInFlight) return

            // Sanctioned exception to the busy-abort guard: a loop proven by 6+
            // identical name+args fingerprints is the hallucinated-loop case the
            // plugin is allowed to interrupt — the current call has not started yet.
            w.toolLoopAttempts++
            w.liveToolSigs = []
            const sid = input.sessionID
            const kind = loopKind
            void (async () => {
                try {
                    if (typeof sid !== "string" || !sid.startsWith("ses")) return
                    w.pluginAbortInFlight = true
                    try {
                        await ctx.client.session.abort({ path: { id: sid } })
                        await log("warn", `${short(sid)} - live tool-loop (${kind}) detected; aborted, sending recovery prompt`)
                        await new Promise((r) => setTimeout(r, ABORT_CONTINUE_DELAY_MS))
                        await sendContinuePrompt(sid, TOOL_LOOP_RECOVERY_PROMPT, w)
                    } finally {
                        w.pluginAbortInFlight = false
                    }
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err)
                    await log("warn", `${short(sid)} - live tool-loop intervention failed: ${errMsg}`)
                }
            })()
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
