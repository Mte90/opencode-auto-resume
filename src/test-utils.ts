/**
 * Pure utility functions used by tests.
 *
 * These MUST NOT be exported from src/index.ts in the production bundle.
 * OpenCode's plugin loader iterates every module export and treats each as a
 * Plugin entrypoint. Non-Plugin functions that return non-Hooks values
 * (especially `null`) cause a host crash: `null.config?.(U)` throws
 * "null is not an object (evaluating 'N.config')".
 *
 * Signatures mirror the private definitions in src/index.ts so tests exercise
 * the same logic. If a function's signature changes in index.ts, update it
 * here too.
 */

export interface Todo {
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    priority: "high" | "medium" | "low"
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
    pluginAbortAt: number
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
    recentToolCalls: Array<{ toolName: string; at: number }>
    toolLoopAttempts: number
    isSubagent: boolean
    completionSignaled: boolean
    todoNudgeAttempts: number
    taskCompleteOverrides: number
    taskCompleteSignals: number
    doneClaimNoTodosAttempts: number
    pendingTools: number
    pendingCommands: number
    pendingRecovery: boolean
    pendingRecoveryReason: string | null
    pendingRecoveryAt: number
    recoveryAttempts: number
    watchdogRetryGuard: boolean
}

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
    "aborted due to timeout",
]

const DEFAULT_MAX_BACKOFF_MS = 8_000
const DEFAULT_BASE_BACKOFF_MS = 1_000

export function isStreamingFailure(
    errorName: string,
    errorMessage: string,
    errorNames: string[] = DEFAULT_STREAMING_FAILURE_ERROR_NAMES,
    messagePatterns: string[] = DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS,
): boolean {
    if (!errorName && !errorMessage) return false

    if (errorName && errorNames.includes(errorName)) {
        return true
    }

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

export function getLastAssistantError(
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

export function backoffMs(
    attempt: number,
    baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
    return Math.min(baseBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs)
}

export function buildOpenTodosReminder(todos: Todo[]): string {
    if (!Array.isArray(todos) || todos.length === 0) return "continue"
    const open = todos.filter(t => t.status === "pending" || t.status === "in_progress")
    if (open.length === 0) return "continue"
    const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
    const plural = open.length > 1 ? "s" : ""
    const taskWord = open.length > 1 ? "tasks" : "task"
    const thisWord = open.length > 1 ? "these" : "this"
    return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on ${thisWord} ${taskWord}.`
}

export function containsDoneClaimPattern(text: string, patterns: RegExp[] = DONE_CLAIM_PATTERNS): boolean {
    const lines = text.split('\n')
    const lastLines = lines.slice(-5).join('\n')
    return patterns.some((pat) => pat.test(lastLines))
}

export function containsReadyToContinuePattern(text: string, patterns: RegExp[] = READY_TO_CONTINUE_PATTERNS): boolean {
    const lines = text.split('\n')
    const lastLine = lines[lines.length - 1]?.trim()
    if (!lastLine) return false
    const lastLines = lines.slice(-3).join('\n')
    return patterns.some((pat) => pat.test(lastLines))
}

const DEFAULT_DONE_CLAIM_PATTERNS = [
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

const DEFAULT_READY_TO_CONTINUE_PATTERNS = [
    /ready to continue with task/i,
    /continuing with task/i,
    /continue with task/i,
    /proceeding with task/i,
    /ready to proceed with task/i,
    /will continue with task/i,
    /moving on to task/i,
]

export const DONE_CLAIM_PATTERNS = DEFAULT_DONE_CLAIM_PATTERNS
export const READY_TO_CONTINUE_PATTERNS = DEFAULT_READY_TO_CONTINUE_PATTERNS
