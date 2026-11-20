/**
 * Shared constants, patterns, and prompts for auto-resume plugin.
 *
 * This module is the single source of truth for values shared by both v1 and v2 builds.
 * Per-build divergences are intentionally NOT here.
 */

// ---- Shared types ----
export interface Todo {
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    priority: "high" | "medium" | "low"
}

// ---- Timeout / interval defaults ----
export const DEFAULT_CHUNK_TIMEOUT_MS = 180_000
export const DEFAULT_CHECK_INTERVAL_MS = 5_000
export const DEFAULT_DISCOVERY_DELAY_MS = 5_000
export const DEFAULT_ACTIVE_USER_WINDOW_MS = 5 * 60_000
export const DEFAULT_GRACE_PERIOD_MS = 3_000
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_MAX_BACKOFF_MS = 8_000
export const DEFAULT_BASE_BACKOFF_MS = 1_000
export const DEFAULT_SUBAGENT_WAIT_MS = 15_000
export const DEFAULT_LOOP_MAX_CONTINUES = 3
export const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000
export const DEFAULT_TOOL_TEXT_CHECK_DELAY_MS = 3_000
export const DEFAULT_MAX_RECOVERY_RETRIES = 2
export const DEFAULT_MIN_ACTIVITY_GAP_MS = 1_000
export const DEFAULT_WARMUP_MS = 15_000
export const DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS = 200
export const DEFAULT_DEBUG = false

// ---- Idle session management ----
export const MAX_IDLE_SESSIONS = 50
export const IDLE_CLEANUP_MS = 10 * 60_000
export const SESSION_DISCOVERY_INTERVAL_MS = 60_000

// ---- Context / wrapup ----
export const CTX_WRAPUP_TRIGGER = "ctx-wrapup"
export const UNKNOWN_TOOL_THRESHOLD = 2
export const TOOL_IDS_CACHE_MS = 5 * 60_000

// ---- Error patterns ----
export const OOC_ERROR_RE = /exceeds the available context size|context size \(\d+\)|too large to compact|too many tokens|prompt is too long/i

export const DEFAULT_STREAMING_FAILURE_ERROR_NAMES = [
    "ProviderError",
    "APIError",
    "StreamError",
    "ConnectionError",
    "TimeoutError",
]

export const DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS = [
    "streaming response failed",
    "stream.*fail",
    "connection.*reset",
    "connection.*closed",
    "aborted due to timeout",
]

// ---- Pattern lists ----
export const TOOL_TEXT_PATTERNS = [
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

export const TRUNCATED_XML_PATTERNS = [
    { open: /<function[^>]*>/i, close: /<\/function>/i },
    { open: /<parameter[^>]*>/i, close: /<\/parameter>/i },
    { open: /<tool_call[^>]*>/i, close: /<\/tool_call>/i },
    { open: /\{\s*"type"\s*:/i, close: /}/ },
    { open: /\{\s*"name"\s*:/i, close: /}/ },
]

export const READY_TO_CONTINUE_PATTERNS = [
    /ready to continue with task/i,
    /continuing with task/i,
    /continue with task/i,
    /proceeding with task/i,
    /ready to proceed with task/i,
    /will continue with task/i,
    /moving on to task/i,
]

export const OWN_PROMPT_SHAPES: RegExp[] = [
	/^continue\s*\u2014\s*stalled\s*\(/,
	/^continue\s*\nOnly continue work already in progress\./,
	/^continue\s*\nIf work was already in progress,/,
	/^You tried to use the tool "/,
]

export const DONE_CLAIM_PATTERNS = [
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

// ---- Recovery prompts ----
export const TOOL_TEXT_RECOVERY_PROMPT =
    "Your last message contained a raw tool call printed as text instead of being executed. " +
    "Please use the proper tool calling mechanism to execute it."

export const THINKING_TOOL_RECOVERY_PROMPT =
    "I noticed you have a tool call generated in your thinking/reasoning. " +
    "Please execute it using the proper tool calling mechanism instead of keeping it in reasoning."

export const TOOL_LOOP_RECOVERY_PROMPT =
    "I notice you've been calling the same tool multiple times in a row without making progress. " +
    "Please step back and reassess your approach. Consider: " +
    "1) Are you stuck in a loop? 2) Do you need different information first? " +
    "3) Should you try a different tool or break the task into smaller steps? " +
    "Take a moment to think about what's blocking you and propose a different strategy."

// ---- Task completion prompts ----
export const TASK_COMPLETE_ACK =
    "Task completion acknowledged. No further continuation will be sent. " +
    "End your turn now with a brief text reply — do not call task_complete or any other tool again " +
    "unless the user sends a new message."

export const TASK_COMPLETE_REPEAT_WARNING =
    "Task completion acknowledged already on your previous call — completion is recorded. " +
    "End your turn now with a brief text reply. Do not call task_complete again; " +
    "further repeat calls are rejected as errors."

export const TASK_COMPLETE_REPEAT_ERROR =
    "task_complete already acknowledged twice with no new user message or tool work since — " +
    "completion is recorded. End your turn with text and make no further tool calls."

export const TASK_COMPLETE_BLOCK_PREFIX =
    "You are NOT done. You called task_complete but you still have open todos. " +
    "Update your todo list (mark finished items complete), then continue the remaining work. " +
    "Do not call task_complete again until every todo is completed."

// ---- Done validation prompts ----
export const DONE_WITHOUT_WORK_PROMPT =
    "I need you to verify more carefully that you have actually completed all the required tasks. " +
    "Your response indicated you're done, but no work was detected. Please check your todo list " +
    "and complete any remaining work."

export const DONE_WITHOUT_DETAILS_PROMPT =
    "Your last response claimed the task is complete but contained no work description. This is not acceptable. " +
    "You MUST respond now with a full, detailed report of everything you did: " +
    "for each file you modified, state the full path and the exact changes; " +
    "list every command you ran to verify and its result; state the final outcome. " +
    "Do NOT reply with 'done', 'task completed', or any short acknowledgment — " +
    "your ONLY acceptable response right now is this detailed report. Write it now."

// ---- Continue prompt ----
export const CONTINUE_PROMPT = "continue"

// ---- Pure helper functions ----

export function stripCodeBlocks(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`\n]+`/g, "")
}

export function containsToolCallAsText(text: string): boolean {
    if (text.length <= 10) return false
    const stripped = stripCodeBlocks(text)
    if (TOOL_TEXT_PATTERNS.some((pat) => pat.test(stripped))) return true
    for (const { open, close } of TRUNCATED_XML_PATTERNS) {
        if (open.test(stripped) && !close.test(stripped)) return true
    }
    return false
}

export function containsDoneClaimPattern(text: string, patterns: RegExp[] = DONE_CLAIM_PATTERNS): boolean {
    const lines = text.split('\n')
    const lastLines = lines.slice(-5).join('\n')
    return patterns.some((pat) => pat.test(lastLines))
}

export function containsWorkDescription(text: string): boolean {
    // Backticked span mentioning a dotted filename: `src/index.ts`
    if (/`[^`\n]*\.[a-zA-Z0-9]{1,8}[^`\n]*`/.test(text)) return true
    // Bare path with a slash and a dotted extension: src/index.ts, /a/b.py
    if (/[\w\-~.][\w\-.~\/]*\/[\w\-.~]*\.[a-zA-Z]{1,8}\b/.test(text)) return true
    // Report section headers: files changed, verification, results, ...
    if (/^(changed|modified|deleted|created|updated|renamed|moved|files?\s+changed|verification|verified|tests?(?:\s+run|\s+passing|\s+pass)?|results?|outcome|commands?\s+(?:run|executed))/im.test(text)) return true
    return false
}

export function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length
    if (m === 0) return n
    if (n === 0) return m
    let prev = new Array<number>(n + 1)
    let curr = new Array<number>(n + 1)
    for (let j = 0; j <= n; j++) prev[j] = j
    for (let i = 1; i <= m; i++) {
        curr[0] = i
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        }
        const tmp = prev; prev = curr; curr = tmp
    }
    return prev[n]
}

export function suggestClosestTool(wrongName: string, available: string[]): string | null {
    const lower = wrongName.toLowerCase()
    let best: string | null = null
    let bestDist = Infinity
    for (const id of available) {
        const dist = levenshtein(lower, id.toLowerCase())
        const threshold = Math.max(2, Math.floor(lower.length / 2))
        if (dist < bestDist && dist <= threshold) {
            bestDist = dist
            best = id
        }
    }
    return best
}

export function containsActionIntent(text: string): boolean {
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

export function buildOpenTodosReminder(todos: Todo[]): string {
    if (!Array.isArray(todos)) return "continue"
    const open = todos.filter(t => t.status === "pending" || t.status === "in_progress")
    if (open.length === 0) return "continue"
    const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
    const plural = open.length > 1 ? "s" : ""
    const taskWord = open.length > 1 ? "tasks" : "task"
    const thisWord = open.length > 1 ? "these" : "this"
    return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on ${thisWord} ${taskWord}.`
}

export function isOpenTodo(t: Todo): boolean {
    return t.status === "pending" || t.status === "in_progress"
}

export function getOpenTodos(todos: Todo[]): Todo[] {
    if (!Array.isArray(todos)) return []
    return todos.filter(isOpenTodo)
}
