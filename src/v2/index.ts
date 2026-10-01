/**
 * opencode-auto-resume — adapted for OpenCode v2 plugin API.
 *
 * Port of https://github.com/Mte90/opencode-auto-resume (v1 hooks API) to the
 * v2 promise-plugin API (`Plugin.define` + `ctx.event.subscribe()`).
 *
 * What changed vs. v1:
 *  - Default export is `{ id, setup }` via `Plugin.define`; setup returns a cleanup fn.
 *  - Events come from `ctx.event.subscribe()` (AsyncIterable) with flat payloads
 *    (`{ type, data }`) instead of the v1 `event` hook (`{ type, properties }`).
 *  - SDK calls are flattened: `ctx.session.prompt({ sessionID, text })`,
 *    `ctx.session.interrupt({ sessionID })`, `ctx.session.active()`.
 *  - Assistant text is accumulated from `session.text.delta` events for liveness;
 *    `ctx.session.context()` (stable v2) supplies the authoritative final
 *    assistant text at idle time — replacing v1's `session.messages()` polling.
 *  - No `ctx.app.log` in v2 — logs go to the console (captured by opencode logs).
 *  - Targets the stable v2 API (`@opencode/plugin`). Event names are unchanged
 *    from the beta port; `session.execution.interrupted` now carries a `reason`.
 *
 * Detection/recovery features ported:
 *  - Stalled stream watchdog (busy session with no events for chunkTimeoutMs)
 *  - Execution/step failure recovery (`session.execution.failed`, `session.step.failed`)
 *  - Provider retry awareness (`session.retry.scheduled`)
 *  - Tool-call-printed-as-text detection + targeted recovery prompt
 *  - "Ready to continue" / stalled-intent ("...:") nudges
 *  - "Done" claim without work verification
 *  - Hallucination loop guard (too many auto-continues → interrupt + resume)
 *  - Subagent-awareness: does not recover a parent blocked on a running subagent
 *  - Permission-awareness: never recovers while a permission dialog is open
 *
 * Install: drop this file in ~/.config/opencode/plugins/ (auto-loaded), or add:
 *   { "plugins": [{ "package": "./plugins/auto-resume-v2.ts", "options": { ... } }] }
 */

/**
 * v2 entrypoint shape.
 *
 * The package depends on `@opencode-ai/plugin`, which exports `Plugin` only as a
 * *type* — `(input, options?) => Promise<Hooks>`. There is no runtime
 * `Plugin.define` in it, so the previous `import { Plugin } from
 * "@opencode/plugin"` did not resolve and the file could not be built or
 * type-checked at all (see the build script, which only ever built v1's
 * `src/index.ts`). The v2 contract is simply `{ id, setup }`, so define the
 * identity helper locally rather than importing a symbol that does not exist.
 */
type AutoResumePlugin = {
	id: string
	setup: (ctx: AutoResumePluginInput) => unknown
}

const define = <T>(plugin: T): T => plugin

/**
 * The subset of the v2 plugin input this plugin actually consumes. Typed
 * structurally so the file type-checks standalone, without pinning a
 * @opencode-ai/plugin version whose `Plugin` type describes the v1 contract.
 */
interface AutoResumePluginInput {
	/** Per-plugin options from config. */
	options?: Record<string, unknown>
	/** Event stream (AsyncIterable of `{ type, data }`). */
	event: { subscribe: (opts?: { signal?: AbortSignal }) => AsyncIterable<V2Event> }
	/** Server-side session/messaging operations. */
	session: Record<string, (...args: any[]) => any>
	/**
	 * Opencode API client, when the host provides one. Declared on the real
	 * `@opencode-ai/plugin` `PluginInput` (`client: ReturnType<typeof
	 * createOpencodeClient>`); typed here structurally so the file still
	 * type-checks standalone. Optional: a host may not supply it, and every
	 * use must degrade gracefully when it is absent.
	 */
	client?: { session: { get: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: string } }> } }
	/** Application logger, when the host provides one. */
	app?: { log?: (level: string, message: string) => unknown }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallRecord {
	toolName: string
	at: number
}

/** Minimal structural view of a V2Event (avoids depending on client internals). */
interface V2Event {
	type: string
	created: number
	data?: Record<string, any>
}

interface SessionWatch {
	createdAt: number
	lastActivityAt: number
	status: "busy" | "idle" | "unknown"
	userCancelled: boolean
	resumeAttempts: number
	lastRetryAt: number
	gaveUp: boolean
	aborting: boolean
	/** Timestamp of the last plugin-initiated `session.interrupt()`. Any abort-shaped
	 * event inside `SELF_ABORT_TTL_MS` of it is ours, not the user's. */
	selfAbortAt: number
	/** Count of plugin-initiated interrupts in the current `INTERRUPT_WINDOW_MS`. */
	interruptsThisWindow: number
	interruptWindowStart: number
	/** Timestamp of the last recovery injection, for `injectIntervalMs` debouncing. */
	lastInjectAt: number
	recovering: boolean
	/** Latched when a failure carries an OOC error that `continue` can never clear; recovery (continue + abort+resume) is refused until a genuine user/agent turn. */
	oocLocked: boolean
	oocLockReason: string | null
	/** True while one of our own recovery continues is in flight — distinguishes a self-caused execution.started from a genuine turn. */
	selfRecovery: boolean

	// Assistant text accumulation (v2 replacement for session.messages())
	textParts: Map<string, string> // assistantMessageID -> accumulated text
	lastAssistantText: string
	lastAssistantMessageID: string | null

	// Recovery budgets
	toolTextAttempts: number
	continueTimestamps: number[]
	doneClaimAttempts: number
	intentNudgeAttempts: number
	/** Set when a failure-triggered recovery is pending, so the delayed prompt isn't cancelled by the failure's own idle transition. */
	pendingRecoveryArmed: boolean

	// Guards
	permissionPending: boolean
	/** Timestamp of the latest `permission.asked` (stale-guard for the flag). */
	permissionPendingAt: number | null
	lastWasTaskTool: boolean
	/** Cached verdict from `isSubAgentSession()`: true when the server reports a
	 * `parentID` for this session, i.e. it is a child and must never be injected
	 * into or interrupted. `undefined` = not yet resolved. */
	isSubAgent?: boolean
	idleSince: number | null
	/** Set while the session is mid native compaction — recovery must never interrupt it. */
	compacting: boolean
	/** Timestamp of the latest `session.compaction.started` (stale-guard for the flag). */
	compactionStartedAt: number | null

	// Tool-loop tracking
	recentToolCalls: ToolCallRecord[]

	// Agent/model from last step (informational logging only; sessions are stateful in v2)
	agent?: string
	model?: string
}

export interface AutoResumeOptions {
	chunkTimeoutMs?: number
	gracePeriodMs?: number
	checkIntervalMs?: number
	maxRetries?: number
	baseBackoffMs?: number
	maxBackoffMs?: number
	loopMaxContinues?: number
	loopWindowMs?: number
	/** Minimum gap between recovery injections for one session. */
	injectIntervalMs?: number
	continuePrompt?: string
	toolTextRecoveryPrompt?: string
	doneWithoutWorkPrompt?: string
	actionIntentPrompt?: string
	debug?: boolean
	activeUserWindowMs?: number

	// ---- Ported from v1 (Mte90/opencode-auto-resume#33) ----
	/** v1 name for `maxRetries`. Still accepted so v1 configs port unchanged. */
	maxRecoveryRetries?: number
	/** How a stall is recovered: "continue" (default), "abort", or "off". */
	busyStallStrategy?: "continue" | "abort" | "off"
	/** Fraction of the usable context window that counts as saturated. */
	contextSaturationThreshold?: number
	/** Trigger native compaction on saturation for subagent sessions. */
	subagentNativeCompactionEnabled?: boolean
	/** Resume on action-intent detection (default true). */
	resumeOnActionIntent?: boolean
	/** Delay before the first session discovery sweep. */
	discoveryDelayMs?: number
	/** Quiet period after startup before stall recovery arms. */
	warmupMs?: number
	/** Minimum gap between recorded activity timestamps. */
	minActivityGapMs?: number
	/** Grace before a raw-tool-call-as-text check fires. */
	toolTextCheckDelayMs?: number
	/** Wait for a subagent to report before treating it as stalled. */
	subagentWaitMs?: number
	/** Token floor for the silent-dead-stream heuristic. */
	silentDeadStreamMinTokens?: number
	/** Error names that mark a streaming failure. */
	streamingFailureErrorNames?: string[]
	/** Regex sources that mark a streaming failure message. */
	streamingFailureMessagePatterns?: string[]
	/** Regex sources that mark a "task is done" claim. */
	doneClaimPatterns?: string[]
	/** Regex sources that mark the model ready to continue. */
	readyToContinuePatterns?: string[]
	/** Prompt sent when a done-claim arrives with no work to show. */
	doneWithoutDetailsPrompt?: string
	/** Prompt sent when a tool call was emitted inside reasoning. */
	thinkingToolRecoveryPrompt?: string
}

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

// 45s -> 180s (2026-09-29): silence is the ONLY stall signal here, and 45s +
// 3s grace misfires on a single shared GPU where one subagent turn legitimately
// emits no events for over a minute. Widening the window is a mitigation, not
// the principled fix — that is positive hang detection (a tool call stuck in
// running/pending is a real hang; model generation is not), which changes
// recovery semantics and is still an open decision.
const DEFAULT_CHUNK_TIMEOUT_MS = 180_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000
const DEFAULT_GRACE_PERIOD_MS = 3_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 8_000
const DEFAULT_LOOP_MAX_CONTINUES = 3
const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000
const DEFAULT_DEBUG = false
// Mirrors v1 (Mte90 e1b8374): an inbound user message this recent means the
// user is engaged (likely composing), so idle nudges stand down. Was 15min here.
const DEFAULT_ACTIVE_USER_WINDOW_MS = 5 * 60_000

// ---- Defaults ported from v1 (Mte90/opencode-auto-resume#33) ----
const DEFAULT_DISCOVERY_DELAY_MS = 5_000
const DEFAULT_WARMUP_MS = 15_000
const DEFAULT_MIN_ACTIVITY_GAP_MS = 1_000
const DEFAULT_TOOL_TEXT_CHECK_DELAY_MS = 3_000
const DEFAULT_SUBAGENT_WAIT_MS = 15_000
const DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS = 200
const DEFAULT_CONTEXT_SATURATION_THRESHOLD = 0.85
const DEFAULT_MAX_RECOVERY_RETRIES = 2
// Referenced from FEATURE_GATED_OPTIONS docs; kept so the intended v1 default is
// recorded next to the gate that explains why it is not applied yet.

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

const DEFAULT_DONE_CLAIM_PATTERNS = [
	"task\\s+done[.!]*",
	"done[.!]*",
	"all\\s+done[.!]*",
	"finished[.!]*",
	"complete[.!]*",
	"task\\s+complete[.!]*",
	"task\\s+completed[.!]*",
	"all\\s+tasks?\\s+complete[.!]*",
	"all\\s+tasks?\\s+completed[.!]*",
	"(?:i['’]?m\\s+)?done\\s+with\\s+task",
	"done\\s+with\\s+(?:the\\s+)?(?:task|work|implementation)",
	"finished\\s+(?:the\\s+)?(?:task|work|implementation)",
	"(?:all|everything)\\s+(?:is\\s+)?(?:complete|done|finished)",
	"nothing\\s+(?:else\\s+)?(?:left|remaining|to do)",
]

const DEFAULT_READY_TO_CONTINUE_PATTERNS = [
	"ready to continue with task",
	"continuing with task",
	"continue with task",
	"proceeding with task",
	"ready to proceed with task",
	"will continue with task",
	"moving on to task",
]

const THINKING_TOOL_RECOVERY_PROMPT =
	"I noticed you have a tool call generated in your thinking/reasoning. " +
	"Please execute it using the proper tool calling mechanism instead of keeping it in reasoning."

const DONE_WITHOUT_DETAILS_PROMPT =
	"Your last response claimed the task is complete but contained no work description. This is not acceptable. " +
	"You MUST respond now with a full, detailed report of everything you did: " +
	"for each file you modified, state the full path and the exact changes; " +
	"list every command you ran to verify and its result; state the final outcome. " +
	"Do NOT reply with 'done', 'task completed', or any short acknowledgment — " +
	"your ONLY acceptable response right now is this detailed report. Write it now."

/**
 * Upper bound on how long a `shell.created` → `shell.exited` pair is trusted
 * to mean "this session is busy". A shell that never reports an exit (session
 * torn down, event dropped) would otherwise suppress recovery forever, so
 * entries are pruned past this. Set well above any realistic long build.
 */
const SHELL_OPEN_MAX_MS = 30 * 60_000

/** OOC (out-of-context) errors that `continue` can never clear — recovery is locked out on these. */
const OOC_ERROR_RE = /exceeds the available context size|context size \(\d+\)|too large to compact|too many tokens|prompt is too long/i

/**
 * Window after `session.interrupt()` during which any abort-shaped event is
 * attributed to us rather than to the user. The runtime delivers
 * `session.execution.interrupted` asynchronously, so a boolean `aborting` flag
 * cleared on a fixed timer is not a reliable "this abort was mine" marker.
 */
const SELF_ABORT_TTL_MS = 30_000
/** Interrupt-shaped failure signatures. v2 reports an interrupt as
 * `{type:"aborted", message:"Step interrupted"}`, which the older
 * `("interrupted by user" | type contains "cancel")` filter never matched. */
const ABORT_ERROR_TYPE_RE = /^(abort|aborted|cancel|cancelled|canceled|interrupted)$/i
const ABORT_ERROR_MSG_RE = /step interrupted|interrupted by user|request cancelled|request canceled/i
/** Hard cap on plugin-initiated interrupts. An interrupt persists an errored
 * assistant message that the UI surfaces as a send failure, so it is a last
 * resort, not a routine recovery step. */
const MAX_INTERRUPTS_PER_WINDOW = 2
const INTERRUPT_WINDOW_MS = 10 * 60_000
/**
 * Minimum gap between two recovery injections for the same session.
 * Synthetic turns are not free: sending one to a session that is already
 * running supersedes its in-flight step, which the runtime reports as
 * "Step interrupted". Debouncing collapses the several independent recovery
 * paths (stall watchdog, intent nudge, tool-loop nudge) into at most one
 * injection per interval.
 */
const DEFAULT_INJECT_INTERVAL_MS = 15_000

const MAX_IDLE_SESSIONS = 50
const IDLE_CLEANUP_MS = 10 * 60_000
/** A compaction silent for this long without an ended/failed event is wedged — stale-clear the flag. */
const COMPACTION_STALE_TTL_MS = 30 * 60_000
/** A `permission.asked` unanswered this long is treated as abandoned — stale-clear the flag. */
const PERMISSION_STALE_TTL_MS = 30 * 60_000
const TEXT_BUFFER_TRIM_LEN = 20_000

/**
 * Tool-part states as reported by the v2 message projection.
 *
 * v2 never writes "pending": an in-flight tool part reads "running", and it
 * settles to "completed" or "error". "pending" was the v1 spelling, so a guard
 * that tested for it literally could never fire on v2.
 */
const TOOL_STATE_RUNNING = "running"
/** Kept for v1-shaped payloads; harmless on v2. */
const TOOL_STATE_PENDING = "pending"
const TOOL_STATE_COMPLETED = "completed"

/**
 * Tools whose only real completion is the user answering. A `question` that
 * comes back "error" was interrupted, not answered, so it must still hold the
 * turn open.
 */
const AWAITING_USER_TOOLS = new Set(["question", "permission", "ask", "confirm"])

const CONTINUE_PROMPT = "continue"

const TOOL_TEXT_RECOVERY_PROMPT =
	"Your last message contained a raw tool call printed as text instead of being executed. " +
	"Please use the proper tool calling mechanism to execute it."

const DONE_WITHOUT_WORK_PROMPT =
	"I need you to verify more carefully that you have actually completed all the required tasks. " +
	"Your response indicated you're done, but no work was detected. Please check your todo list " +
	"and complete any remaining work."

const TOOL_LOOP_RECOVERY_PROMPT =
	"I notice you've been calling the same tool multiple times in a row without making progress. " +
	"Please step back and reassess your approach. Consider: " +
	"1) Are you stuck in a loop? 2) Do you need different information first? " +
	"3) Should you try a different tool or break the task into smaller steps? " +
	"Take a moment to think about what's blocking you and propose a different strategy."

const TASK_TOOL_HINTS = ["task", "agent", "subagent", "dispatch"]

// ---------------------------------------------------------------------------
// Pattern lists (ported verbatim from upstream where pure)
// ---------------------------------------------------------------------------

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
	/^(?:i['’]?m\s+)?done\s+with\s+task/im,
	/\bdone\s+with\s+(?:the\s+)?(?:task|work|implementation)/im,
	/\bfinished\s+(?:the\s+)?(?:task|work|implementation)/im,
	/\b(?:all|everything)\s+(?:is\s+)?(?:complete|done|finished)/im,
	/\bnothing\s+(?:else\s+)?(?:left|remaining|to do)/im,
]

// Error signatures that indicate a transient streaming/provider failure worth retrying
const STREAMING_FAILURE_MESSAGE_PATTERNS = [
	"stream.*fail",
	"stream.*timeout",
	"connection.*reset",
	"connection.*closed",
	"connection.*error",
	"socket.*hang",
	"econnreset",
	"etimedout",
	"rate.?limit",
	"overloaded",
	"server error",
	"internal error",
]

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "")
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

function containsReadyToContinuePattern(text: string, patterns: RegExp[] = READY_TO_CONTINUE_PATTERNS): boolean {
	const lines = text.split("\n")
	const lastLines = lines.slice(-3).join("\n")
	return patterns.some((pat) => pat.test(lastLines))
}

function containsDoneClaimPattern(text: string, patterns: RegExp[] = DONE_CLAIM_PATTERNS): boolean {
	const lines = text.split("\n")
	const lastLines = lines.slice(-5).join("\n")
	return patterns.some((pat) => pat.test(lastLines))
}

/** Model ends with ":" announcing intent without executing. */
function containsActionIntent(text: string): boolean {
	if (text.length <= 15) return false
	const cleaned = text.replace(/<[a-zA-Z/?][^>]*>/g, "").trim()
	const lines = cleaned.split("\n")
	let lastLine = ""
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) {
			lastLine = lines[i].trim()
			break
		}
	}
	return lastLine.endsWith(":") && lastLine.length > 5 && lastLine.length < 500
}

/**
 * True when a turn cleanly ends by handing control back to the user — a
 * question, or an explicit prompt for their input. Nudging such a turn
 * injects a synthetic `continue` that starts an in-flight step, and when the
 * user's real reply then arrives it interrupts that step → "Step interrupted"
 * (the execution.interrupted event). A hand-off turn is, by design, awaiting
 * the user, so it must never be nudged.
 */
function isUserHandoff(text: string): boolean {
	const lines = text.split("\n")
	let last = ""
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim()
		if (t.length > 0) {
			last = t
			break
		}
	}
	if (!last) return false
	if (last.endsWith("?") || last.endsWith("？")) return true
	const patterns = [/let\s+me\s+know/i, /your\s+call/i, /up\s+to\s+you/i, /which\s+(would|do\s+you|option)/i, /should\s+I/i, /want\s+me\s+to/i, /would\s+you\s+like/i]
	return patterns.some((p) => p.test(last))
}

function backoffMs(attempt: number, base: number, max: number): number {
	return Math.min(base * Math.pow(2, attempt - 1), max)
}

function isStreamingFailure(message: string, patterns: string[] = STREAMING_FAILURE_MESSAGE_PATTERNS): boolean {
	const lower = message.toLowerCase()
	if (!lower) return false
	return patterns.some((pattern) => {
		try {
			return new RegExp(pattern, "i").test(lower)
		} catch {
			return lower.includes(pattern.toLowerCase())
		}
	})
}

/** True when an error `name` is one of the configured streaming-failure names. */
function isStreamingFailureName(name: string, names: string[]): boolean {
	return names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())
}

/** Repeating tool-call patterns: A-A-A or A-B-A-B-A-B etc. */
function detectPatternLoop(recentTools: string[]): boolean {
	if (recentTools.length < 6) return false
	for (const patternLen of [1, 2, 3]) {
		if (recentTools.length < patternLen * 3) continue
		const pattern = recentTools.slice(-patternLen)
		let matches = 0
		for (let i = recentTools.length - patternLen * 2; i >= 0; i -= patternLen) {
			const slice = recentTools.slice(i, i + patternLen)
			if (slice.length !== patternLen) break
			if (!slice.every((t, idx) => t === pattern[idx])) break
			matches++
		}
		if (matches >= 2) return true
	}
	return false
}

function trackToolCall(w: SessionWatch, toolName: string): boolean {
	const now = Date.now()
	w.recentToolCalls = w.recentToolCalls.filter((c) => now - c.at < 120_000)
	w.recentToolCalls.push({ toolName, at: now })
	const recentTools = w.recentToolCalls.slice(-12).map((c) => c.toolName)
	if (recentTools.length < 6) return false
	const lastTool = recentTools[recentTools.length - 1]
	const consecutiveSame = recentTools.slice(-4).filter((t) => t === lastTool).length
	if (consecutiveSame >= 4) return true
	return detectPatternLoop(recentTools)
}

function short(sid: string): string {
	return sid.length > 12 ? `…${sid.slice(-8)}` : sid
}

function sidOf(ev: V2Event): string | undefined {
	const sid = ev.data?.sessionID
	return typeof sid === "string" ? sid : undefined
}

function isTaskToolCall(ev: V2Event): boolean {
	const tool = ev.data?.tool ?? ev.data?.toolName
	if (typeof tool === "string") {
		const lower = tool.toLowerCase()
		if (TASK_TOOL_HINTS.some((h) => lower.includes(h))) return true
	}
	// Also inspect input for agent-ish payloads
	const desc = ev.data?.input?.description ?? ev.data?.input?.subagent_type ?? ev.data?.input?.agent
	return typeof desc === "string"
}
// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default define({
	id: "auto-resume.v2",

	setup: async (ctx: AutoResumePluginInput) => {
		const opts = (ctx.options ?? {}) as AutoResumeOptions

		const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
		const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
		const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
		// `maxRecoveryRetries` is v1's name for the same knob. Prefer the v2 name,
		// fall back to the v1 alias so an existing v1 config ports unchanged.
		const maxRetries = opts.maxRetries ?? opts.maxRecoveryRetries ?? DEFAULT_MAX_RETRIES
		const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
		const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
		const loopMaxContinues = opts.loopMaxContinues ?? DEFAULT_LOOP_MAX_CONTINUES
		const loopWindowMs = opts.loopWindowMs ?? DEFAULT_LOOP_WINDOW_MS
		const debug = opts.debug ?? DEFAULT_DEBUG
		const activeUserWindowMs = opts.activeUserWindowMs ?? DEFAULT_ACTIVE_USER_WINDOW_MS
		const injectIntervalMs = opts.injectIntervalMs ?? DEFAULT_INJECT_INTERVAL_MS

		// ---- Ported from v1 (Mte90/opencode-auto-resume#33) ----
		const rawBusyStallStrategy = opts.busyStallStrategy ?? "continue"
		const busyStallStrategy: "continue" | "abort" | "off" =
			rawBusyStallStrategy === "abort" || rawBusyStallStrategy === "off" ? rawBusyStallStrategy : "continue"
		// Feature-gated on v2 (see FEATURE_GATED_OPTIONS): accepted for config
		// compatibility, not yet acted on. Not bound to locals so they cannot be
		// mistaken for live behaviour.
		const resumeOnActionIntent = opts.resumeOnActionIntent !== false
		const warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS
		const minActivityGapMs = opts.minActivityGapMs ?? DEFAULT_MIN_ACTIVITY_GAP_MS
		const streamingFailureErrorNames = opts.streamingFailureErrorNames ?? DEFAULT_STREAMING_FAILURE_ERROR_NAMES
		const streamingFailureMessagePatterns = opts.streamingFailureMessagePatterns ?? DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS
		const doneWithoutDetailsPrompt = opts.doneWithoutDetailsPrompt ?? DONE_WITHOUT_DETAILS_PROMPT
		const thinkingToolRecoveryPrompt = opts.thinkingToolRecoveryPrompt ?? THINKING_TOOL_RECOVERY_PROMPT

		/** Compile a user-supplied regex-source list, skipping anything invalid. */
		function compilePatterns(
			raw: string[] | undefined,
			fallback: string[],
			flags: string,
		): RegExp[] {
			const sources = Array.isArray(raw) && raw.length > 0 ? raw : fallback
			const out: RegExp[] = []
			for (const source of sources) {
				try {
					out.push(new RegExp(source, flags))
				} catch {
					// An invalid pattern is dropped rather than failing startup.
				}
			}
			return out
		}

		const doneClaimPatterns = compilePatterns(opts.doneClaimPatterns, DEFAULT_DONE_CLAIM_PATTERNS, "im")
		const readyToContinuePatterns = compilePatterns(
			opts.readyToContinuePatterns,
			DEFAULT_READY_TO_CONTINUE_PATTERNS,
			"i",
		)
		const streamingFailureMessageRegexes = compilePatterns(
			streamingFailureMessagePatterns,
			DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS,
			"i",
		)

		// Options accepted but not yet acted on, because the v2 feature they tune
		// is not ported. Listed (not warned) so an existing v1 config stays valid
		// and the gap is documented rather than surprising. See
		// docs/known-issues-v2.md.
		const FEATURE_GATED_OPTIONS = [
			"contextSaturationThreshold",
			"subagentNativeCompactionEnabled",
			"silentDeadStreamMinTokens",
			"subagentWaitMs",
			"discoveryDelayMs",
			"toolTextCheckDelayMs",
			"thinkingToolRecoveryPrompt",
			"doneWithoutWorkPrompt",
		] as const

		// Options this build understands. Anything else in the user's config is
		// reported once at startup so a silent fallback is visible rather than
		// looking like a bug. (Mte90/opencode-auto-resume#33)
		const RECOGNISED_OPTIONS = new Set<string>([
			"chunkTimeoutMs",
			"checkIntervalMs",
			"gracePeriodMs",
			"maxRetries",
			"maxRecoveryRetries",
			"baseBackoffMs",
			"maxBackoffMs",
			"loopMaxContinues",
			"loopWindowMs",
			"debug",
			"activeUserWindowMs",
			"injectIntervalMs",
			"continuePrompt",
			"toolTextRecoveryPrompt",
			"actionIntentPrompt",
			"doneWithoutWorkPrompt",
			"busyStallStrategy",
			"contextSaturationThreshold",
			"subagentNativeCompactionEnabled",
			"resumeOnActionIntent",
			"discoveryDelayMs",
			"warmupMs",
			"minActivityGapMs",
			"toolTextCheckDelayMs",
			"subagentWaitMs",
			"silentDeadStreamMinTokens",
			"streamingFailureErrorNames",
			"streamingFailureMessagePatterns",
			"doneClaimPatterns",
			"readyToContinuePatterns",
			"doneWithoutDetailsPrompt",
			"thinkingToolRecoveryPrompt",
			"doneWithoutWorkPrompt",
		])
		const unknownOptions = Object.keys(opts).filter((key) => !RECOGNISED_OPTIONS.has(key))
		if (unknownOptions.length > 0) {
			log(
				"warn",
				`ignoring unrecognised option(s): ${unknownOptions.join(", ")} — ` +
					`this v2 build does not read them. See docs/known-issues-v2.md.`,
			)
		}
		// Feature-gated options are valid but inert on v2. Reported in the startup
		// line rather than as a warning — the user cannot act on it, so a per-start
		// warn would be pure noise. See docs/known-issues-v2.md.
		const gatedInUse = Object.keys(opts).filter((key) =>
			(FEATURE_GATED_OPTIONS as readonly string[]).includes(key),
		)

		const dbg = (...args: unknown[]) => {
			if (debug) console.log("[auto-resume:debug]", ...args)
		}

		function log(level: "info" | "warn" | "error", msg: string) {
			const line = `[auto-resume] ${msg}`
			// Prefer the server log sink so plugin output is actually retrievable
			// (console output from a hosted plugin is not captured anywhere useful).
			try {
				const appLog = (ctx as any)?.app?.log
				if (typeof appLog === "function") {
					void appLog.call((ctx as any).app, level === "info" ? "info" : level, line)
				}
			} catch {
				// fall through to console
			}
			if (level === "error") console.error(line)
			else if (level === "warn") console.warn(line)
			else console.log(line)
		}

		// ---------------------------------------------------------------------
		// State
		// ---------------------------------------------------------------------

		const sessions = new Map<string, SessionWatch>()

		/**
		 * Open shells from the process-registry event family, keyed by shell id
		 * → `{ sessionID, startedAt }`. Populated by `shell.created`, cleared by
		 * `shell.exited`. A session with an entry here is running a command and
		 * must not be treated as a stalled parent.
		 *
		 * `shell.created` is the only shell event that carries its session, and it
		 * nests it at `data.info.metadata.sessionID`; the exit events carry only
		 * the shell id, so the reverse lookup has to be recorded here.
		 */
		const openShells = new Map<string, { sessionID: string; startedAt: number }>()

		/** Number of shells currently open for `sid`, pruning stale entries. */
		function openShellCount(sid: string, now = Date.now()): number {
			let n = 0
			for (const [id, s] of openShells) {
				if (now - s.startedAt > SHELL_OPEN_MAX_MS) {
					openShells.delete(id)
					continue
				}
				if (s.sessionID === sid) n++
			}
			return n
		}

		/** Drop every shell entry owned by a session that no longer exists. */
		function forgetShells(sid: string): void {
			for (const [id, s] of openShells) {
				if (s.sessionID === sid) openShells.delete(id)
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
					aborting: false,
					selfAbortAt: 0,
					interruptsThisWindow: 0,
					interruptWindowStart: 0,
					lastInjectAt: 0,
					recovering: false,
					oocLocked: false,
					oocLockReason: null,
					selfRecovery: false,
					textParts: new Map(),
					lastAssistantText: "",
					lastAssistantMessageID: null,
					toolTextAttempts: 0,
					continueTimestamps: [],
					doneClaimAttempts: 0,
					intentNudgeAttempts: 0,
					pendingRecoveryArmed: false,
					permissionPending: false,
					permissionPendingAt: null,
					lastWasTaskTool: false,
					idleSince: null,
					compacting: false,
					compactionStartedAt: null,
					recentToolCalls: [],
				}
				sessions.set(sid, w)
			}
			return w
		}

		function touch(sid: string) {
			const w = ensureWatch(sid)
			// `minActivityGapMs` debounces activity: without it, a burst of events
			// inside one tool call keeps resetting the stall clock and a genuinely
			// wedged step never trips the watchdog.
			const now = Date.now()
			if (now - w.lastActivityAt < minActivityGapMs) return
			w.lastActivityAt = now
		}

		function markBusy(sid: string) {
			const w = ensureWatch(sid)
			if (w.status !== "busy") {
				dbg(`${short(sid)} idle/unknown -> busy`)
				// Fresh busy cycle: reset per-turn budgets.
				// NOTE: continueTimestamps is intentionally preserved — the
				// hallucination-loop detector counts across busy cycles by design.
				w.resumeAttempts = 0
				w.toolTextAttempts = 0
				w.doneClaimAttempts = 0
				w.intentNudgeAttempts = 0
				w.gaveUp = false
				w.recentToolCalls = []
				w.textParts.clear()
				w.lastAssistantText = ""
			}
			w.status = "busy"
			w.idleSince = null
			w.lastActivityAt = Date.now()
		}

		function markIdle(sid: string) {
			const w = ensureWatch(sid)
			if (w.status !== "idle") {
				dbg(`${short(sid)} ${w.status} -> idle`)
				w.status = "idle"
				w.idleSince = Date.now()
			}
			// NOTE: this used to clear `permissionPending`. The `session.idle` handler
			// calls markIdle() and then inspectOnIdle(), so the flag was always false by
			// the time the guard that honours it ran — the permission guard was dead on
			// exactly the transition it exists for. `permission.replied` is now the only
			// thing that clears it, plus a stale-clear for a `permission.asked` whose
			// reply never arrives.
			clearStalePermissionFlag(sid, w)
		}

		/**
		 * A `permission.asked` with no matching `permission.replied` would otherwise
		 * stand the session down forever. Mirrors the compaction stale-guard.
		 */
		function clearStalePermissionFlag(sid: string, w: SessionWatch) {
			if (!w.permissionPending) return
			if (w.permissionPendingAt && Date.now() - w.permissionPendingAt > PERMISSION_STALE_TTL_MS) {
				dbg(`${short(sid)} permission prompt silent >${PERMISSION_STALE_TTL_MS / 60000}m — clearing flag`)
				w.permissionPending = false
				w.permissionPendingAt = null
			}
		}

		function recordContinue(sid: string) {
			const w = sessions.get(sid)
			if (!w) return
			const now = Date.now()
			w.continueTimestamps.push(now)
			const cutoff = now - loopWindowMs
			while (w.continueTimestamps.length > 0 && w.continueTimestamps[0] < cutoff) {
				w.continueTimestamps.shift()
			}
		}

		function continuesInWindow(w: SessionWatch): number {
			const cutoff = Date.now() - loopWindowMs
			while (w.continueTimestamps.length > 0 && w.continueTimestamps[0] < cutoff) {
				w.continueTimestamps.shift()
			}
			return w.continueTimestamps.length
		}

		/**
		 * True while a plugin-initiated abort is still in flight. The runtime delivers
		 * `session.execution.interrupted` asynchronously after `interrupt()` returns, so
		 * the transient `w.aborting` boolean is not a reliable discriminator.
		 */
		function selfAbortActive(w: SessionWatch): boolean {
			return w.selfAbortAt > 0 && Date.now() - w.selfAbortAt < SELF_ABORT_TTL_MS
		}

		/** Does this failure signature mean "the turn was interrupted"? */
		function isAbortError(errType: string, errMsg: string): boolean {
			return ABORT_ERROR_TYPE_RE.test(errType.trim()) || ABORT_ERROR_MSG_RE.test(errMsg)
		}

		/** Remaining plugin-initiated interrupts allowed in the current window. */
		function interruptBudget(w: SessionWatch): number {
			if (w.interruptWindowStart === 0 || Date.now() - w.interruptWindowStart > INTERRUPT_WINDOW_MS) {
				w.interruptWindowStart = Date.now()
				w.interruptsThisWindow = 0
			}
			return MAX_INTERRUPTS_PER_WINDOW - w.interruptsThisWindow
		}

		/**
		 * Fallback source of truth for "which sessions are running". v2's plugin
		 * SessionDomain does not expose `session.active()` (see Mte90/opencode-auto-resume#33),
		 * so when it is missing we derive the set from our own event-derived busy flags.
		 * Without this the subagent-wait guard below can never fire.
		 */
		function busySessions(): string[] {
			const out: string[] = []
			for (const [sid, w] of sessions) {
				if (w.status === "busy" && !w.userCancelled) out.push(sid)
			}
			return out
		}

		/**
		 * Is this session itself a subagent? Definitive test: ask the server for
		 * our own record and look at `parentID`.
		 *
		 * This plugin is parent-scoped — it exists to recover sessions a human is
		 * waiting on. A child is not that: it never reads the parent's AGENTS.md,
		 * so a prompt-level "ignore injected continues" rule in the child agent
		 * loses to an injection that arrives as a real task turn. Observed in the
		 * wild: a worker answered an invisible prompt mid-task and never returned.
		 *
		 * Deliberately independent of the `lastWasTaskTool` heuristic used for
		 * parents in `checkActiveSessions` — that one asks "did this session just
		 * dispatch a child?", this one asks "is this session a child?". A silent
		 * child gets no protection from the parent-side heuristic, which is
		 * exactly the gap this closes.
		 *
		 * Cached on the watch record. `ctx.client` is optional and any failure
		 * degrades to `false` — i.e. precisely the pre-guard behavior — so a host
		 * without a client can neither break recovery nor fail to boot.
		 */
		async function isSubAgentSession(sid: string): Promise<boolean> {
			const w = ensureWatch(sid)
			if (typeof w.isSubAgent === "boolean") return w.isSubAgent
			let sub = false
			try {
				const res = await ctx.client?.session.get({ path: { id: sid } })
				sub = !!res?.data?.parentID
			} catch {
				sub = false
			}
			w.isSubAgent = sub
			return sub
		}

		/**
		 * Single choke point for every recovery injection. Guarantees at most one
		 * synthetic per `injectIntervalMs` and refuses to talk to a live session,
		 * because a turn sent to a busy session supersedes its in-flight step
		 * ("Step interrupted").
		 *
		 * `allowDuringSelfAbort` is for the abort+resume escalation, which by
		 * construction runs inside the plugin's own abort window: it is the one
		 * injection that is *supposed* to follow `interrupt()`. That path skips
		 * both the abort-window check and the busy guard, because:
		 *  - we just killed the step ourselves, so "this session is working" is
		 *    false, and the runtime may not have delivered the idle transition
		 *    yet; and
		 *  - swallowing the continue there leaves a session interrupted with
		 *    nothing to restart it, which is the failure this whole fix targets.
		 * It stays rate-limited by `w.aborting` and `MAX_INTERRUPTS_PER_WINDOW`.
		 */
		async function injectOnce(
			sid: string,
			text: string,
			notification: string,
			allowDuringSelfAbort = false,
		): Promise<boolean> {
			const w = ensureWatch(sid)
			// A subagent is not ours to recover. Checked first, before every other
			// guard, so no code path below can reach a child.
			if (await isSubAgentSession(sid)) {
				dbg(`${short(sid)} subagent session — injection refused (parent owns recovery)`)
				return false
			}
			if (!allowDuringSelfAbort && selfAbortActive(w)) {
				dbg(`${short(sid)} injection refused — inside our own abort window`)
				return false
			}
			if (!allowDuringSelfAbort && w.status === "busy" && Date.now() - w.lastActivityAt < chunkTimeoutMs) {
				dbg(`${short(sid)} injection refused — session busy and live (${Math.round((Date.now() - w.lastActivityAt) / 1000)}s since last event)`)
				return false
			}
			const since = Date.now() - w.lastInjectAt
			if (!allowDuringSelfAbort && w.lastInjectAt > 0 && since < injectIntervalMs) {
				dbg(`${short(sid)} injection debounced — ${Math.round(since / 1000)}s since last (min ${injectIntervalMs / 1000}s)`)
				return false
			}
			w.lastInjectAt = Date.now()
			return notifyAndPrompt(sid, text, notification)
		}

		function cleanupIdleSessions() {
			const now = Date.now()
			const busy = new Set<string>()
			for (const [sid, w] of sessions) {
				if (w.status === "busy") busy.add(sid)
			}
			let idleCount = 0
			const toDelete: string[] = []
			for (const [sid, w] of sessions) {
				if (w.status !== "busy") {
					idleCount++
					if (w.idleSince && now - w.idleSince > IDLE_CLEANUP_MS) toDelete.push(sid)
				}
			}
			if (idleCount > MAX_IDLE_SESSIONS) {
				const entries: Array<{ sid: string; since: number }> = []
				for (const [sid, w] of sessions) {
					if (w.status !== "busy" && w.idleSince) entries.push({ sid, since: w.idleSince })
				}
				entries.sort((a, b) => a.since - b.since)
				const excess = idleCount - MAX_IDLE_SESSIONS
				for (let i = 0; i < excess && i < entries.length; i++) {
					if (!toDelete.includes(entries[i].sid)) toDelete.push(entries[i].sid)
				}
			}
			let cleaned = 0
			for (const sid of toDelete) {
				// A session waiting on a long command emits no activity events and
				// therefore looks idle. Don't drop its watch state out from under
				// a shell that is still running.
				if (openShellCount(sid) > 0) continue
				forgetShells(sid)
				sessions.delete(sid)
				cleaned++
			}
			if (cleaned > 0) dbg(`cleaned ${cleaned} idle sessions, total=${sessions.size}`)
		}

		/**
		 * Accumulate assistant text from deltas. This replaces v1's
		 * `session.messages()` polling, which no longer exists on the v2 ctx.
		 */
		function appendText(sid: string, messageID: string | undefined, delta: string) {
			const w = ensureWatch(sid)
			const mid = messageID ?? "_anon"
			w.textParts.set(mid, (w.textParts.get(mid) ?? "") + delta)
			w.lastAssistantMessageID = mid
			w.lastAssistantText = w.textParts.get(mid) ?? ""
			// Keep memory bounded: keep only the two most recent messages' text
			if (w.textParts.size > 2) {
				const oldest = w.textParts.keys().next().value
				if (oldest !== undefined && oldest !== mid) w.textParts.delete(oldest)
			}
			if (w.lastAssistantText.length > TEXT_BUFFER_TRIM_LEN) {
				w.textParts.set(mid, w.lastAssistantText.slice(-TEXT_BUFFER_TRIM_LEN))
				w.lastAssistantText = w.textParts.get(mid) ?? ""
			}
		}

		// ---------------------------------------------------------------------
		// Recovery actions
		// ---------------------------------------------------------------------

		/**
		 * Show a visible notification in the session timeline and optionally
		 * resume it.  Uses `session.synthetic()` which is exposed on the v2
		 * promise-plugin context — the synthetic message appears in the TUI
		 * so the user knows the plugin intervened.
		 *
		 * When `resume` is true the synthetic also acts as a user turn that
		 * kicks the session back to life, replacing the separate `prompt()`.
		 */
		async function notifyAndPrompt(sid: string, text: string, notification: string, resume = true): Promise<boolean> {
			ensureWatch(sid).selfRecovery = true
			try {
				await ctx.session.synthetic({
					sessionID: sid,
					text,
					description: `auto-resume: ${notification}`,
					resume,
				})
				return true
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log("warn", `${short(sid)} synthetic failed: ${msg}`)
				// Last resort: a plain prompt still resumes the session (just
				// without the visible synthetic notification in the TUI).
				try {
					await ctx.session.prompt({ sessionID: sid, text })
					return true
				} catch {
					log("error", `${short(sid)} all recovery attempts failed: ${msg}`)
					return false
				}
			}
		}

		async function tryAbortAndResume(sid: string, w: SessionWatch): Promise<boolean> {
			// Guarded separately because this path calls `interrupt()` *before*
			// delegating to injectOnce — guarding only the injection would still
			// let us interrupt a running child.
			if (await isSubAgentSession(sid)) {
				dbg(`${short(sid)} subagent session — abort+resume refused`)
				return false
			}
			if (w.aborting || selfAbortActive(w)) return false
			if (w.oocLocked) {
				dbg(`${short(sid)} oocLocked — refusing abort+resume escalation`)
				return false
			}
			if (w.compacting) {
				dbg(`${short(sid)} mid-compaction — refusing abort+resume escalation`)
				return false
			}
			if (interruptBudget(w) <= 0) {
				w.continueTimestamps = []
				log("warn", `${short(sid)} interrupt budget exhausted (${MAX_INTERRUPTS_PER_WINDOW}/${INTERRUPT_WINDOW_MS / 60000}m) — skipping interrupt, loop guard reset`)
				return false
			}
			w.aborting = true
			w.selfAbortAt = Date.now()
			w.interruptsThisWindow++
			log("warn", `${short(sid)} escalating: interrupt + fresh continue (${w.interruptsThisWindow}/${MAX_INTERRUPTS_PER_WINDOW} per ${INTERRUPT_WINDOW_MS / 60000}m)`)
			try {
				await ctx.session.interrupt({ sessionID: sid })
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				log("warn", `${short(sid)} interrupt failed: ${msg}`)
			}
			// Give the runtime a beat to settle the interrupted turn
			await new Promise((r) => setTimeout(r, 2_000))
			w.aborting = false
			w.resumeAttempts = 0
			// Deliberately does not recordContinue(): our own escalation must not feed
			// the loop guard that triggered it, or the guard trips on its own output.
			// Through the same choke point as every other path. The runtime
			// delivers session.execution.interrupted asynchronously, so an
			// escalation that lands on top of a concurrent recovery injection is
			// exactly the case that produced the simultaneous bursts of synthetic
			// continues (and the "Step interrupted" they caused).
			const ok = await injectOnce(sid, opts.continuePrompt ?? CONTINUE_PROMPT, "abort+resume escalation", true)
			if (ok) {
				w.lastRetryAt = Date.now()
				log("info", `${short(sid)} resumed after abort`)
			}
			return ok
		}

		/** Latch the OOC lock when a failure carries an out-of-context error (which `continue` can never clear). */
		function maybeLockOoc(sid: string, errMsg: string) {
			const w = ensureWatch(sid)
			if (w.oocLocked) return
			if (!OOC_ERROR_RE.test(errMsg)) return
			w.oocLocked = true
			w.oocLockReason = errMsg.slice(0, 200)
			log("warn", `${short(sid)} OOC error latched — recovery locked out until a genuine turn: ${errMsg.slice(0, 120)}`)
		}

		/**
		 * Core recovery ladder for a stuck/failed session.
		 * plain continue with backoff -> more attempts -> abort+resume escalation.
		 */
		async function recover(sid: string, reason: string) {
			const w = ensureWatch(sid)
			if (w.recovering || w.aborting || w.gaveUp || w.userCancelled || w.permissionPending) return
			if (w.oocLocked) {
				dbg(`${short(sid)} oocLocked — refusing recovery (reason: ${w.oocLockReason?.slice(0, 80)})`)
				return
			}
			if (w.compacting) {
				dbg(`${short(sid)} mid-compaction — refusing recovery (reason: ${reason})`)
				return
			}
			if (selfAbortActive(w)) {
				dbg(`${short(sid)} self-abort in flight — refusing recovery (reason: ${reason})`)
				return
			}
			// Evaluate the loop guard BEFORE recording this continue, so the plugin
			// never escalates on continues it injected itself.
			if (continuesInWindow(w) >= loopMaxContinues) {
				log("warn", `${short(sid)} hallucination loop (${loopMaxContinues} continues/${loopWindowMs / 1000}s) — abort+resume`)
				await tryAbortAndResume(sid, w)
				w.continueTimestamps = []
				return
			}
			recordContinue(sid)
			if (w.resumeAttempts >= maxRetries) {
				log("warn", `${short(sid)} giving up after ${maxRetries} attempts (${reason})`)
				w.gaveUp = true
				return
			}
			w.recovering = true
			w.resumeAttempts++
			const delay = backoffMs(w.resumeAttempts, baseBackoff, maxBackoff)
			const attempt = w.resumeAttempts
			log(
				"info",
				`${short(sid)} stall detected (${reason}) — resume attempt ${attempt}/${maxRetries} in ${delay}ms`,
			)
			setTimeout(async () => {
				try {
					// Skip only if the session genuinely turned healthy again
					// (a normal completion clears pendingRecoveryArmed) or the
					// user took over.
					if (w.userCancelled || w.gaveUp) return
					if (w.status === "idle" && !w.pendingRecoveryArmed) return // recovered by itself meanwhile
					// A turn sent to a busy session interrupts its in-flight step
					// ("Step interrupted"). Never interrupt mid-compaction, and
					// never interrupt a busy session that is still live (events
					// within the chunk window): it is working, not stalled. The
					// watchdog re-arms if it truly stalls.
					if (w.compacting) {
						dbg(`${short(sid)} mid-compaction at inject time — not interrupting`)
						return
					}
					if (w.status === "busy" && Date.now() - w.lastActivityAt < chunkTimeoutMs) {
						dbg(`${short(sid)} still busy and live at inject time (${Math.round((Date.now() - w.lastActivityAt) / 1000)}s since last event) — not interrupting`)
						return
					}
					const ok = await injectOnce(sid, opts.continuePrompt ?? CONTINUE_PROMPT, "stalled — retrying")
					w.pendingRecoveryArmed = false
					if (ok) {
						w.lastRetryAt = Date.now()
						touch(sid)
						markBusy(sid)
					} else if (attempt >= maxRetries) {
						await tryAbortAndResume(sid, w)
					}
				} finally {
					w.recovering = false
				}
			}, delay)
		}

		/** Targeted recovery prompts (tool-as-text, done-claims, intent nudges). */
		async function targetedRecovery(sid: string, kind: string, prompt: string, budgetKey: "toolTextAttempts" | "doneClaimAttempts" | "intentNudgeAttempts") {
			const w = ensureWatch(sid)
			if (w.recovering || w.userCancelled || w.permissionPending) return
			if (w.compacting) {
				dbg(`${short(sid)} mid-compaction — skipping ${kind} nudge`)
				return
			}
			// A session with a shell still running is working, not idle. A parent
			// parked on a background job goes idle the moment the tool call returns
			// — long before the process finishes — so without this it collects a
			// nudge on the spot and the stall watchdog never even gets a look.
			const busyShells = openShellCount(sid)
			if (busyShells > 0) {
				dbg(`${short(sid)} ${busyShells} shell(s) still running — skipping ${kind} nudge`)
				return
			}
			if (selfAbortActive(w)) {
				dbg(`${short(sid)} self-abort in flight — skipping ${kind} nudge`)
				return
			}
			if (continuesInWindow(w) >= loopMaxContinues) {
				log("warn", `${short(sid)} loop guard before ${kind} nudge — abort+resume`)
				await tryAbortAndResume(sid, w)
				w.continueTimestamps = []
				return
			}
			recordContinue(sid)
			if (w[budgetKey] >= maxRetries) {
				dbg(`${short(sid)} ${kind} budget exhausted`)
				return
			}
			// Port of v1 e1b8374 ("Fix todoNudgeAttempts burning retries on failed
			// sends"): only count an attempt once the prompt actually landed. A
			// rejected send costs nothing, so a transient failure no longer eats a
			// retry and silences the nudge for the rest of the session.
			const attemptNum = w[budgetKey] + 1
			log("info", `${short(sid)} ${kind} detected — sending targeted prompt (${attemptNum}/${maxRetries})`)
			w.recovering = true
			// injectOnce debounces: this nudge counts once, not alongside a
			// concurrent stall-watchdog injection.
			const ok = await injectOnce(sid, prompt, "recovering: " + kind)
			w.recovering = false
			if (ok) {
				w[budgetKey] = attemptNum
				touch(sid)
				markBusy(sid)
			} else {
				dbg(`${short(sid)} ${kind} nudge not delivered — attempt ${attemptNum} not counted`)
			}
		}

		// ---------------------------------------------------------------------
		// Idle-time forensics (runs once when a turn finishes)
		// ---------------------------------------------------------------------

		/**
		 * Read the last assistant message's text from the session message history
		 * (`ctx.session.context()`, stable v2 API). Returns "" when unavailable.
		 * Guarded so a failure in this forensic path never breaks the watchdog.
		 */
		async function lastAssistantTextFromContext(sid: string): Promise<string> {
			try {
				const messages = await ctx.session.context({ sessionID: sid })
				if (!Array.isArray(messages)) return ""
				for (let i = messages.length - 1; i >= 0; i--) {
					const msg = messages[i] as {
						type?: string
						content?: Array<{ type?: string; text?: string }>
					}
					if (!msg || msg.type !== "assistant" || !Array.isArray(msg.content)) continue
					const text = msg.content
						.filter((part) => part?.type === "text" && typeof part.text === "string")
						.map((part) => part.text as string)
						.join("")
					if (text) return text
				}
				return ""
			} catch (e) {
				dbg("session.context() fallback failed:", e instanceof Error ? e.message : String(e))
				return ""
			}
		}

		async function shouldStandDownForUser(sid: string, activeUserWindowMs: number): Promise<boolean> {
	try {
		const result = await ctx.session.context({ sessionID: sid })
		const messages: unknown[] = Array.isArray(result) ? result : ((result as { messages?: unknown[] })?.messages ?? [])
		if (messages.length === 0) return false
		const newest = messages[messages.length - 1] as {
			type?: string
			content?: { type?: string; name?: string; state?: { status?: string } }[]
			time?: { created?: number }
			info?: { time?: { created?: number } }
		}
		// (a) A tool call still awaiting its result means the model is waiting on the
		//     user — a synthetic nudge here would be interrupted by their real reply
		//     ("Step interrupted").
		//
		//     This used to test `state.status === "pending"`, which v2 never emits, so
		//     the branch was unreachable and the nudge fired with an unanswered
		//     `question` on screen. See TOOL_STATE_* above.
		if (newest?.type === "assistant") {
			for (const part of newest.content ?? []) {
				const t = part?.type ?? ""
				if (!(t === "tool_use" || t === "tool" || t === "tool_call" || t.startsWith("tool"))) continue
				const status = part?.state?.status
				if (status === TOOL_STATE_RUNNING || status === TOOL_STATE_PENDING) return true
				// An interactive tool only reaches a terminal state once the user has
				// actually answered. "error" here means the question was interrupted,
				// not that it was answered, so keep standing down.
				if (status !== TOOL_STATE_COMPLETED && AWAITING_USER_TOOLS.has(part?.name ?? "")) return true
			}
		}
		// (b) The user was recently active — they are mid-conversation, not stuck.
		if (newest?.type === "user") {
			const ts = newest.time?.created ?? newest.info?.time?.created
			if (typeof ts === "number" && Date.now() - ts < activeUserWindowMs) return true
		}
		return false
	} catch {
		return false
	}
}

async function inspectOnIdle(sid: string) {
			const w = ensureWatch(sid)
			// Prefer the live delta buffer; fall back to the authoritative message
			// history when it is empty (e.g. the plugin loaded mid-turn) or stale.
			let text = w.lastAssistantText
			if (!text) text = await lastAssistantTextFromContext(sid)
			if (!text) return

			// A turn that ends by handing control back to the user (a question or an
			// explicit prompt) is awaiting their reply; a synthetic nudge here starts
			// an in-flight step that their real reply then interrupts ("Step
			// interrupted"). Never nudge a hand-off turn.
			if (isUserHandoff(text)) {
				dbg(`${short(sid)} idle turn ends with a user hand-off — skipping targeted recovery`)
				return
			}

			if (await shouldStandDownForUser(sid, activeUserWindowMs)) {
				dbg(`${short(sid)} user has pending input or was recently active — standing down`)
				return
			}

			if (containsToolCallAsText(text)) {
				await targetedRecovery(sid, "tool-call-as-text", opts.toolTextRecoveryPrompt ?? TOOL_TEXT_RECOVERY_PROMPT, "toolTextAttempts")
				return
			}
			if (containsReadyToContinuePattern(text, readyToContinuePatterns)) {
				await targetedRecovery(sid, "ready-to-continue", opts.continuePrompt ?? CONTINUE_PROMPT, "intentNudgeAttempts")
				return
			}
			if (resumeOnActionIntent && containsActionIntent(text)) {
				await targetedRecovery(sid, "action-intent", opts.actionIntentPrompt ?? opts.continuePrompt ?? CONTINUE_PROMPT, "intentNudgeAttempts")
				return
			}
			if (containsDoneClaimPattern(text, doneClaimPatterns) && w.doneClaimAttempts < 1) {
				// Single verification nudge for suspiciously terse completions
				const trimmed = text.trim()
				if (trimmed.length < 400) {
					await targetedRecovery(sid, "done-claim-no-details", doneWithoutDetailsPrompt, "doneClaimAttempts")
				}
			}
		}

		// ---------------------------------------------------------------------
		// Watchdog timer
		// ---------------------------------------------------------------------

		/**
		 * `session.active()` exists on the v2 client but is not part of the
		 * plugin SessionDomain pick — access defensively; empty map if missing.
		 */
		/**
		 * `session.active()` exists on the v2 client but is not part of the plugin
		 * SessionDomain pick, so it is normally absent — see
		 * Mte90/opencode-auto-resume#33. Fall back to our own event-derived busy
		 * flags rather than returning an empty set: returning `[]` made the
		 * subagent-wait guard below unreachable, so a parent session that went
		 * quiet while its child ran was declared stalled and interrupted.
		 */
		async function getActiveSessions(): Promise<string[]> {
			try {
				const fn = (ctx.session as any).active
				if (typeof fn !== "function") return busySessions()
				const active = await fn.call(ctx.session)
				return Object.keys(active ?? {}).filter((k) => typeof k === "string")
			} catch {
				return busySessions()
			}
		}

		async function checkActiveSessions() {
			const now = Date.now()

			// Cross-check our busy set against server truth (also catches sessions
			// we never saw an execution.started for, e.g. after plugin reload).
			const activeIDs = await getActiveSessions()
			for (const sid of activeIDs) {
				const w = ensureWatch(sid)
				if (w.status !== "busy") markBusy(sid)
			}

			for (const [sid, w] of sessions) {
				if (w.status !== "busy" || w.userCancelled) continue
				// Warmup: a session that only just went busy has not had a chance to
				// emit anything. Without this a freshly-started turn can be declared
				// stalled while it is still queueing its first model call.
				if (now - w.createdAt < warmupMs) continue
				// Stale compaction flag: a compaction that never reports
				// ended/failed within the TTL is wedged — clear the guard so
				// recovery can eventually intervene.
				if (w.compacting && w.compactionStartedAt && now - w.compactionStartedAt > COMPACTION_STALE_TTL_MS) {
					w.compacting = false
					w.compactionStartedAt = null
					log("warn", `${short(sid)} compaction flag stale (>${COMPACTION_STALE_TTL_MS / 60000}m) — clearing guard`)
				}
				// NEVER interrupt a session that is mid-compaction.
				if (w.compacting) {
					dbg(`${short(sid)} mid-compaction — skipping stall detection`)
					continue
				}
				const silence = now - w.lastActivityAt
				if (silence < chunkTimeoutMs + gracePeriodMs) continue
				if (busyStallStrategy === "off") {
					dbg(`stall on ${short(sid)} ignored (busyStallStrategy=off)`)
					continue
				}
				// Same stale-guard as the compaction flag: an unanswered `permission.asked`
				// must not stand this session down forever.
				clearStalePermissionFlag(sid, w)
				if (w.permissionPending) {
					dbg(`${short(sid)} silent but permission pending — skipping`)
					continue
				}
				if (selfAbortActive(w)) {
					dbg(`${short(sid)} silent but inside our own abort window — skipping`)
					continue
				}
				// A session with a shell still running is working, not stalled. This
				// covers the parked-parent case the task-tool heuristic below cannot
				// see: a backgrounded `shell` spawns no child session, so
				// `lastWasTaskTool` stays false and `others.length` never gets a
				// chance to say "this parent is waiting on something".
				const busyShells = openShellCount(sid)
				if (busyShells > 0) {
					dbg(`${short(sid)} silent with ${busyShells} shell(s) still running — waiting`)
					continue
				}
				// If another session is actively running and this one went silent
				// right after dispatching a task tool, treat it as a parent wait.
				if (w.lastWasTaskTool) {
					const others = (await getActiveSessions()).filter((s) => s !== sid)
					if (others.length > 0) {
						dbg(`${short(sid)} silent after task tool with ${others.length} active child(ren) — waiting`)
						continue
					}
				}
				// busyStallStrategy picks how a stall is answered. "abort" interrupts
				// the wedged step before continuing, because a stream that went
				// silent mid-generation will not pick the prompt up on its own.
				// Mirrors the v1 branch at src/index.ts.
				if (busyStallStrategy === "abort" && w.resumeAttempts < maxRetries) {
					log("info", `${short(sid)} stall (busyStallStrategy=abort): aborting before continue`)
					await tryAbortAndResume(sid, w)
				} else {
					await recover(sid, `no activity for ${Math.ceil(silence / 1000)}s`)
				}
			}
			cleanupIdleSessions()
		}

		const watchdog = setInterval(() => {
			checkActiveSessions().catch((e) =>
				log("error", `watchdog failed: ${e instanceof Error ? e.message : String(e)}`),
			)
		}, checkIntervalMs)

		// ---------------------------------------------------------------------
		// Event stream
		// ---------------------------------------------------------------------

		function handleEvent(ev: V2Event) {
			switch (ev.type) {
				// --- lifecycle -------------------------------------------------
				case "session.execution.started": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					if (w.selfRecovery) {
						w.selfRecovery = false
					} else if (w.oocLocked) {
						w.oocLocked = false
						w.oocLockReason = null
						log("info", `${short(sid)} genuine execution — clearing OOC lock`)
					}
					markBusy(sid)
					return
				}
				case "session.execution.succeeded":
				case "session.idle": {
					const sid = sidOf(ev)
					if (!sid) return
					markIdle(sid)
					const w = ensureWatch(sid)
					w.pendingRecoveryArmed = false
					w.selfRecovery = false // stale — no in-flight recovery prompt by the time we idle
					// Never run the idle heuristics on top of our own abort: the idle
					// transition caused by interrupt() would otherwise trigger a second,
					// independent injection.
					if (selfAbortActive(w)) {
						dbg(`${short(sid)} idle after plugin-initiated abort — skipping targeted recovery`)
						return
					}
					void inspectOnIdle(sid)
					return
				}
				case "session.execution.interrupted": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					// Stable v2 carries the interrupt `reason`. Only a genuine user
					// interrupt should suppress recovery; shutdown/superseded/inactivity
					// (or a missing reason on older runtimes) must not.
					const reason = typeof ev.data?.reason === "string" ? ev.data.reason : undefined
					// Use the latch, not the transient `aborting` flag: the runtime
				// delivers this event asynchronously, after `aborting` may have
				// already been cleared. Only a genuine user stop latches
				// userCancelled; `shutdown`/`superseded`/`inactivity` must not
				// permanently disable recovery for the session.
				const mine = w.aborting || selfAbortActive(w)
				if (!mine) w.userCancelled = reason === undefined || reason === "user"
					// A user interrupt also ends any in-flight compaction.
					w.compacting = false
					w.compactionStartedAt = null
					w.recovering = false
					markIdle(sid)
					return
				}
				case "session.deleted": {
					const sid = sidOf(ev)
					if (!sid) return
					forgetShells(sid)
					sessions.delete(sid)
					return
				}
				// --- reverts ---
				// v2 emits a three-stage revert family. `staged` is intermediate
				// (the user can still clear it), while `cleared` and `committed`
				// are terminal; drop our watch state on the terminal stages so a
				// rewind cannot leave a stale recovery armed against old turns.
				case "session.revert.staged": {
					const sid = sidOf(ev)
					if (!sid) return
					// Staging is user activity, but not terminal: keep the state.
					touch(sid)
					return
				}
				case "session.revert.cleared":
				case "session.revert.committed": {
					const sid = sidOf(ev)
					if (!sid) return
					forgetShells(sid)
					sessions.delete(sid)
					return
				}
				// v1 legacy: not emitted in v2 (reverts now surface as
				// `session.revert.cleared` / `session.revert.committed`). Kept
				// defensively so older runtimes still drop their watch state.
				case "session.reverted": {
					const sid = sidOf(ev)
					if (!sid) return
					forgetShells(sid)
					sessions.delete(sid)
					return
				}

				// --- compaction (NEVER interrupt a session that is compacting) ---
				case "session.compaction.started": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					if (!w.compacting) {
						w.compacting = true
						w.compactionStartedAt = Date.now()
						log("info", `${short(sid)} compaction started — auto-resume recovery suspended until it ends`)
					}
					touch(sid)
					return
				}
				case "session.compaction.ended":
				case "session.compaction.failed": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					if (w.compacting) {
						w.compacting = false
						w.compactionStartedAt = null
						log("info", `${short(sid)} compaction ${ev.type.endsWith("failed") ? "failed" : "ended"} — guard cleared`)
					}
					touch(sid)
					return
				}

				// --- activity --------------------------------------------------
				case "session.step.started": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.agent = typeof ev.data?.agent === "string" ? ev.data.agent : w.agent
					w.model =
						ev.data?.model && typeof ev.data.model === "object"
							? `${ev.data.model.providerID ?? ev.data.model.provider ?? "?"}/${ev.data.model.modelID ?? ev.data.model.id ?? "?"}`
							: w.model
					w.lastWasTaskTool = false
					markBusy(sid)
					return
				}
				case "session.step.ended": {
					const sid = sidOf(ev)
					if (!sid) return
					touch(sid)
					return
				}
				// Liveness between step start and the first token. Without these a
				// step that starts and then produces nothing for `chunkTimeoutMs`
				// looks identical to a stall.
				case "session.step.streamed":
				case "session.text.started":
				case "session.reasoning.started":
				case "session.synthetic": {
					const sid = sidOf(ev)
					if (!sid) return
					touch(sid)
					return
				}
				// A long tool-input generation (e.g. a big heredoc write) emits no
				// text deltas; treating that silence as a stall resumes a session
				// that is in fact working.
				case "session.tool.input.started":
				case "session.tool.input.delta": {
					const sid = sidOf(ev)
					if (!sid) return
					touch(sid)
					return
				}
				case "session.text.delta":
				case "session.reasoning.delta": {
					const sid = sidOf(ev)
					if (!sid) return
					appendText(sid, ev.data?.assistantMessageID, typeof ev.data?.delta === "string" ? ev.data.delta : "")
					touch(sid)
					return
				}
				case "session.text.ended":
				case "session.reasoning.ended": {
					const sid = sidOf(ev)
					if (!sid) return
					touch(sid)
					return
				}

				// --- tools ------------------------------------------------------
				case "session.tool.called": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					const name = typeof ev.data?.tool === "string" ? ev.data.tool : (ev.data?.id as string | undefined) ?? "tool"
					w.lastWasTaskTool = isTaskToolCall(ev)
					if (trackToolCall(w, name)) {
						void targetedRecovery(sid, "tool-loop", TOOL_LOOP_RECOVERY_PROMPT, "intentNudgeAttempts").catch(() => {})
					}
					touch(sid)
					return
				}
				case "session.tool.progress":
				case "session.shell.started":
				case "session.shell.ended": {
					const sid = sidOf(ev)
					if (!sid) return
					touch(sid)
					return
				}
				// --- shell process registry ---
				// `session.shell.*` above is the session-scoped family. The runtime
				// also emits a process-registry family, and which one fires depends
				// on the tool path (the bash/Code Mode shell emits only these). We
				// need the registry pair because it is the one that reports a
				// backgrounded job's real completion: `session.tool.success` fires
				// as soon as the *tool call* returns, which for `background: true`
				// is a few hundred ms — long before the process finishes.
				//
				// `shell.deleted` is deliberately not used: it carries a different
				// id family than `created`/`exited` (verified against the running
				// server), so it cannot close an entry. `shell.exited` can.
				case "shell.created": {
					const info = ev.data?.info
					if (!info || typeof info !== "object") return
					const rec = info as { id?: unknown; metadata?: { sessionID?: unknown } }
					const id = rec.id
					const sid = rec.metadata?.sessionID
					if (typeof id !== "string" || typeof sid !== "string") return
					openShells.set(id, { sessionID: sid, startedAt: Date.now() })
					touch(sid)
					return
				}
				case "shell.exited": {
					const id = ev.data?.id
					if (typeof id !== "string") return
					const sid = openShells.get(id)?.sessionID
					if (sid === undefined) return
					openShells.delete(id)
					touch(sid)
					return
				}
				case "session.tool.success": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.lastWasTaskTool = false
					touch(sid)
					return
				}
				case "session.tool.failed": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.lastWasTaskTool = false
					touch(sid)
					return
				}

				// --- permissions -------------------------------------------------
				case "permission.asked": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.permissionPending = true
					w.permissionPendingAt = Date.now()
					return
				}
				case "permission.replied": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.permissionPending = false
					w.permissionPendingAt = null
					touch(sid)
					return
				}

				// --- failures ----------------------------------------------------
				case "session.retry.scheduled": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					touch(sid) // provider-level retry is progress of its own kind
					const errType = String(ev.data?.error?.type ?? "")
					const errMsg = String(ev.data?.error?.message ?? "")
					maybeLockOoc(sid, errMsg)
					log("info", `${short(sid)} provider retry #${ev.data?.attempt ?? "?"}: ${errType || errMsg}`)
					if (!isStreamingFailure(errMsg, streamingFailureMessagePatterns) && !isStreamingFailureName(errType, streamingFailureErrorNames) && errType !== "retryable") return
					// Let the provider retries play out first; only intervene if it stays quiet
					if (nowSilenceTooLong(w)) {
						w.pendingRecoveryArmed = true
						void recover(sid, "streaming failure with scheduled retry")
					}
					return
				}
				case "session.step.failed":
				case "session.execution.failed": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					const errMsg = String(ev.data?.error?.message ?? "")
					const errType = String(ev.data?.error?.type ?? "")
					// Our own abort: do not recover from it, and do not arm the delayed
					// recovery (arming here is what kept the watchdog injecting into an
					// already-interrupted session).
					if (w.aborting || selfAbortActive(w)) {
						dbg(`${short(sid)} ${ev.type} is this plugin's own abort (${errType || "error"}) — not recovering`)
						w.recovering = false
						w.pendingRecoveryArmed = false
						return
					}
					// Any interrupt-shaped failure (ours or the user's) is not recoverable.
					// v2 reports these as {type:"aborted", message:"Step interrupted"}.
					if (isAbortError(errType, errMsg)) {
						dbg(`${short(sid)} failure was an interrupt (${errType || "error"}) — not recovering`)
						w.pendingRecoveryArmed = false
						return
					}
					maybeLockOoc(sid, errMsg)
					markIdle(sid)
					w.pendingRecoveryArmed = true // our delayed recovery must survive this idle transition
					log("warn", `${short(sid)} ${ev.type}: ${errType || "error"} ${errMsg.slice(0, 160)}`)
					void recover(sid, `${ev.type}${isStreamingFailure(errMsg, streamingFailureMessagePatterns) ? " (streaming)" : ""}`)
					return
				}

				default:
					return
			}
		}

		function nowSilenceTooLong(w: SessionWatch): boolean {
			return Date.now() - w.lastActivityAt > chunkTimeoutMs + gracePeriodMs
		}

		// Subscribe and pump events in the background (setup must not block).
		// Stable v2 recommends passing an AbortSignal so the stream is torn down
		// promptly on plugin unload instead of staying suspended in `for await`.
		let running = true
		const eventAbort = new AbortController()
		const pump = async () => {
			try {
				const stream = ctx.event.subscribe({ signal: eventAbort.signal })
				for await (const raw of stream) {
					if (!running) return
					const ev = raw as unknown as V2Event
					if (!ev || typeof ev.type !== "string") continue
					try {
						handleEvent(ev)
					} catch (e) {
						dbg("handler error:", e instanceof Error ? e.message : String(e))
					}
				}
			} catch (e) {
				if (running) log("error", `event stream ended: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
		void pump()

		log(
			"info",
			`ready (opencode v2). timeout=${chunkTimeoutMs}ms interval=${checkIntervalMs}ms retries=${maxRetries} loop=${loopMaxContinues}/${loopWindowMs / 1000}s warmup=${warmupMs}ms stall=${busyStallStrategy}` +
				(gatedInUse.length > 0 ? ` accepted-but-inert=${gatedInUse.join(",")}` : ""),
		)

		// Cleanup: stop timers and the event pump; OpenCode awaits this on disable/reload/shutdown.
		return () => {
			running = false
			eventAbort.abort()
			clearInterval(watchdog)
			sessions.clear()
			log("info", "stopped")
		}
	},
})
