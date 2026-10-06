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
 *  - No `ctx.app.log` in v2: `ctx.app` is only `{name, version, channel}` (see
 *    `packages/plugin/src/app.ts`), and v2 has no `app.log` endpoint. Console
 *    output from a hosted plugin is not captured anywhere retrievable, so v1's
 *    `ctx.client.app.log(...)` has no equivalent. This build therefore appends
 *    to its own log file — see LOG_FILE below.
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

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
	client?: { session: Record<string, (...args: any[]) => any> }
	/**
	 * Model catalogue. v2's `ModelDomain.get(providerID, modelID)` returns
	 * `Model.Info`, whose `limit` is `{ context, input?, output }` — the usable
	 * context window for context-saturation checks. Optional: a host may not
	 * supply it, and the saturation check degrades to "no intervention".
	 */
	model?: { get: (providerID: string, modelID: string) => unknown }
	/**
	 * Installed-plugin inventory (`ctx.plugin.list()`). v2 removed the `config`
	 * domain, so this is how a plugin detects that magic-context is present before
	 * routing a saturated parent to it.
	 */
	plugin?: { list: () => Promise<unknown> }
	/**
	 * Key/value store scoped to the plugin (`ctx.storage.get/set/remove/scan`).
	 * Read-only here: auto-resume does not own a todo list, it reads the one the
	 * installed todo tool writes, so this only ever calls `get`.
	 */
	storage?: { get: (key: string) => Promise<unknown> }
	/**
	 * Tool registry (`ctx.tool.transform` / `ctx.tool.list` / `ctx.tool.hook`).
	 * v2 plugins register their own tools here, which is how `task_complete`
	 * exists: there is no built-in equivalent in v2, so the plugin provides it.
	 */
	tool?: {
		transform: (cb: (editor: AutoResumeToolEditor) => void) => Promise<unknown>
		list: () => Promise<readonly unknown[]>
	}
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

/** The tool registry handle passed to `ctx.tool.transform`. */
interface AutoResumeToolEditor {
	add(tool: {
		name: string
		description: string
		input: Record<string, unknown>
		execute: (input: any, context: { sessionID: string }) => Promise<{ content: string }>
	}): void
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
	/** Last injected prod text + assistant snapshot at prod time, for duplicate suppression. */
	lastProdText: string
	prodAssistantSnapshot: string
	/** Texts this plugin injected (visible channel posts them as real user
	 * messages). `noteInboundUserMessage` must not read them as new user
	 * instructions, or every injection re-arms the budgets it just spent and
	 * the same errors refire on the next idle. Capped; identity is exact text. */
	ownPromptTexts: string[]
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
	/** Done-claim with todos still open. Separate from `doneClaimAttempts`: the two
	 * prompts ask for different things, so spending one budget must not silence the other. */
	doneClaimOpenTodosAttempts: number
	/** Open-todos reminders (the celebration false positive). Persists across turns —
	 * an open list does not become finished by the model saying it is. */
	todoNudgeAttempts: number
	intentNudgeAttempts: number
	/** Set when the model's own completion signal was seen (a trailing 🎉).
	 * Latches so a finished session stops being nudged. */
	completionSignaled: boolean
	/** The session's todo list, read from the todo tool's storage key. */
	todos: Todo[]
	todosFetchedAt: number
	/** Consecutive `task_complete` acks with no new user message or other tool
	 * work between them. Guards the ack self-loop, where the ack tool-result is
	 * fed back and the model re-emits the tool instead of ending its turn. Persists
	 * across busy/idle cycles by design. */
	taskCompleteSignals: number
	/** Failed tool calls by name, for the unknown-tool suggestion. Counted, not
	 * latched: one bad call is a typo, two is a model that will not self-correct. */
	/** When the orphan watch was armed: the moment the last busy subagent of this
	 * session went idle. A parent still busy after that is the case this exists for.
	 * null means not armed. */
	orphanWatchStartAt: number | null
	/** Last time the subagents of this session were polled, so the watchdog does not
	 * ask the server on every tick. */
	lastSubagentCheckAt: number
	/** Whether this orphan episode has already tried waking its subagent. Without a
	 * budget the same prompt goes out on every watchdog tick — v1's structure
	 * assumed the subagent goes busy again, and a dead one never does. */
	orphanRecoveryTried: boolean
	/** The pending deferred pattern pass, if any. Held so a new idle can replace
	 * it rather than stack a second judgement on the same turn, and so a new turn
	 * can cancel it. */
	toolTextTimer: ReturnType<typeof setTimeout> | null
	/** The pending deferred stall-recovery inject, if any. Held so dispose
	 * can cancel it: without this, a reloaded-away instance fires its
	 * backoff timer after disposal and injects from a dead sessions map
	 * (observed 2026-10-06: twin identical prods 5ms apart). */
	recoverTimer: ReturnType<typeof setTimeout> | null
	/** Tool calls started but not finished, tracked from the tool lifecycle events.
	 * The orphan watch must never abort a session that is legitimately working. */
	pendingTools: number
	/** Snapshot of `pendingTools` taken at the `session.idle` transition, before
	 * `markIdle()` zeroes the live counter. Idle does not mean nothing is in
	 * flight — the event fires between steps while tools run — so any idle-path
	 * check that reads the live counter always sees zero. Same class of bug the
	 * `busyBefore` sample above guards against. */
	toolsInFlightAtIdle: number
	/** Rate-limit ladder state. `rateLimitedAt` is the last quota decision
	 * point, `rateLimitAttempts` counts served attempts in this episode, and
	 * `awaitingQuotaRetry` arms the watchdog-tick gate. A fresh turn resets
	 * all three: new activity means quota is available again. */
	rateLimitedAt: number
	rateLimitAttempts: number
	awaitingQuotaRetry: boolean
	unknownToolErrors: Map<string, number>
	/** Set once a suggestion has been injected, so it is sent at most once per
	 * user message rather than on every idle. */
	unknownToolSuggestionSent: boolean
	/** Tool parts already examined. The history is re-walked on every idle, so
	 * without this the same error would be counted again each time. */
	checkedToolPartIDs: Set<string>
	/** How many times a `task_complete` call was overridden because todos were
	 * still open. Bounded by `maxRetries` — past that the call is honoured, because
	 * an unbounded block is its own kind of loop. */
	taskCompleteOverrides: number
	/** Id of the newest inbound user message already acted on, so a replayed or
	 * re-delivered message does not re-arm the done-claim budgets. Identity, not
	 * clock time — see noteInboundUserMessage. */
	lastUserMessageID?: string
	/** Timestamp fallback for the same check, for messages carrying no id. */
	lastUserMessageSeenAt: number
	/** Tokens currently in the context window, from `session.usage.updated`. */
	lastTokenTotal: number
	/** Saturation intervention is one-shot per turn, like v1's `contextWrapupAttempts`. */
	contextWrapupAttempts: number
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
	/** `Model.Ref` from the last step, for the usable-context lookup. */
	modelRef?: { providerID: string; modelID: string }
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
	/**
	 * When true, a stall continue is sent via `ctx.session.prompt()` — a real
	 * user message visible in session history (cattleprod-style) — instead of
	 * the hidden `ctx.session.synthetic({resume:true})`. Default true: the
	 * intervention — and any loop — is self-evident in the transcript, which
	 * is the point. Set false for the old hidden channel. Explicit option
	 * wins; else `AUTO_RESUME_VISIBLE_CONTINUE` (`1`/`true`/`yes` = visible,
	 * anything else set = hidden) wins over the default. (Options set via
	 * the config `plugin` entry are dropped by this box's parser and the
	 * top-level `env` block never reaches the plugin process, so code
	 * default is the only live knob.)
	 */
	visibleContinue?: boolean
	/**
	 * When true (default), a stall continue names the stall reason, attempt
	 * count, and remaining todos instead of sending bare "continue". A custom
	 * `continuePrompt` always wins verbatim. Same channel and guards either way.
	 */
	richContinuePrompt?: boolean
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
	/**
	 * Append this build's log here instead of the default path
	 * (`~/.local/state/opencode-v2/auto-resume.log`).
	 *
	 * v2 removed v1's `app.log` endpoint, so this is the only retrievable
	 * record of what the plugin did. The `AUTO_RESUME_LOG_FILE` environment
	 * variable sets the same thing and wins over neither.
	 */
	logFile?: string
	/**
	 * Per-attempt cooldowns (ms) before a rate-limited session may be retried.
	 * Gates, not timers: evaluated on each failure and each watchdog tick, so
	 * nothing is lost to a reload. Past the ladder the session stays silent
	 * until a genuine user turn. Default spans ~12h for overnight coverage.
	 */
	rateLimitCooldownsMs?: number[]
	/**
	 * Inert delivery probe. Never affects behaviour; echoed in the `ready`
	 * line so a config-options change can be verified without touching a
	 * live knob. Bump the value to test delivery.
	 */
	configProbe?: string | number
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Where this build's log lines go, and why not somewhere official.
 *
 * v1 wrote through `ctx.client.app.log({ body: { service, level, message } })`,
 * a real endpoint that landed in the opencode log file. v2 removed it:
 * `ctx.app` is `{ name, version, channel }` (`packages/plugin/src/app.ts`),
 * there is no `app` group in `packages/protocol/src/groups/`, and a hosted
 * plugin's `console.log` is not captured by the OpenChamber process. Without
 * this the plugin is completely silent — you cannot tell a working watchdog
 * from a dead one, which is exactly the failure that made a stall
 * indistinguishable from "nothing happened".
 *
 * Override with AUTO_RESUME_LOG_FILE. Size-capped so an unattended run cannot
 * fill the disk.
 */
const DEFAULT_LOG_FILE = join(homedir(), ".local", "state", "opencode-v2", "auto-resume.log")
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * Append one line to `target`, best effort.
 *
 * Every failure here is swallowed on purpose: logging must never be the reason
 * the watchdog stops running. The size check races harmlessly between
 * processes — losing a line beats throwing.
 */
function appendLogFile(target: string, level: string, line: string): void {
	try {
		mkdirSync(dirname(target), { recursive: true })
		try {
			if (existsSync(target) && statSync(target).size > LOG_FILE_MAX_BYTES) {
				writeFileSync(target, "")
			}
		} catch {
			// Size check is an optimisation, not a requirement.
		}
		appendFileSync(target, `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line}\n`)
	} catch {
		// Unwritable log dir, read-only fs, quota — none of these should
		// propagate into the recovery path.
	}
}

/**
 * The command magic-context registers to reclaim context on a saturated parent.
 * Sent through `session.command` rather than as prompt text, because prompt text is
 * not expanded into a command.
 */
const CTX_WRAPUP_TRIGGER = "ctx-wrapup"

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
// v1 keeps SESSION_DISCOVERY_INTERVAL_MS as an internal constant rather than an
// option, so it is not configurable here either. 60s matches v1.
const DEFAULT_DISCOVERY_DELAY_MS = 5_000
const DEFAULT_SESSION_DISCOVERY_INTERVAL_MS = 60_000
const DEFAULT_WARMUP_MS = 15_000
const DEFAULT_MIN_ACTIVITY_GAP_MS = 1_000
const DEFAULT_TOOL_TEXT_CHECK_DELAY_MS = 3_000
const DEFAULT_SUBAGENT_WAIT_MS = 15_000
/** How long a busy subagent may go without producing anything before it counts
 * as stuck. v1 used the same number, and a tool call still outstanding triples
 * it, because a long tool is not a hung model. */
const SUBAGENT_STUCK_MS = 60_000
const SUBAGENT_RECOVERY_PROMPT =
	"It looks like you may have stalled or timed out. Please retry the last operation or continue with the task."
const DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS = 200
const DEFAULT_CONTEXT_SATURATION_THRESHOLD = 0.85
/** How long a fetched todo list is trusted before being re-read. */
const TODO_CACHE_TTL_MS = 3_000
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
/** Quota/rate-limit errors (observed: `{type:"provider.quota", message:"Rate
 * limit exceeded. Please try again later."}`). An immediate continue retries
 * straight into the ban, so these stand down on a gate ladder instead of the
 * normal backoff. Gates, not timers: armed timeouts do not survive a reload. */
const RATE_LIMIT_RE = /rate limit exceeded|too many requests|\b429\b|quota exceeded|provider\.quota/i
/** Per-attempt cooldowns before a rate-limited session may be retried: 15m,
 * 30m, 1h, then 2h out to ~12h of unattended coverage. Past the ladder the
 * session stays silent until a genuine user turn. */
const DEFAULT_RATE_LIMIT_COOLDOWNS_MS = [15, 30, 60, 120, 120, 120, 120, 120].map((m) => m * 60_000)

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
/** A user message landing within this of our last inject is treated as our
 * own prompt for budget re-arm purposes (see noteInboundUserMessage). Same
 * box, same clock; our prompt lands in about a second. A genuine user message
 * coincidentally inside the window costs one request's worth of stale
 * budgets — no loop — versus the recount loop this prevents. */
const OWN_PROMPT_TIME_MS = 30_000

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

/**
 * The `task_complete` acknowledgement texts.
 *
 * The ack is fed straight back into the model's turn, so a stuck model re-emits
 * `task_complete` instead of ending with text. That is not hypothetical: v1
 * recorded 27 consecutive acked calls with zero new user input. The first ack
 * therefore carries an explicit stop instruction, the second warns, and the third
 * throws so the turn is forced to end.
 */
const TASK_COMPLETE_ACK =
	"Task completion acknowledged. No further continuation will be sent. " +
	"End your turn now with a brief text reply — do not call task_complete or any other tool again " +
	"unless the user sends a new message."

const TASK_COMPLETE_REPEAT_WARNING =
	"Task completion acknowledged already on your previous call — completion is recorded. " +
	"End your turn now with a brief text reply. Do not call task_complete again; " +
	"further repeat calls are rejected as errors."

const TASK_COMPLETE_REPEAT_ERROR =
	"task_complete already acknowledged twice with no new user message or tool work since — " +
	"completion is recorded. End your turn with text and make no further tool calls."

/** How many times a model must call a tool that does not exist before we name a
 * replacement. One is a typo; two is a model that will not correct itself. */
const UNKNOWN_TOOL_THRESHOLD = 2
/** The tool list changes only when a plugin reloads, so a short cache is enough
 * and it keeps the check off the registry on every idle. */
const TOOL_IDS_CACHE_MS = 5 * 60_000
/** Cap on the tool list quoted back to the model. A full dump of every tool on
 * the box is itself a way to fill the context. */
const UNKNOWN_TOOL_LIST_LIMIT = 20

/** v1's wording, kept verbatim — the model has already seen this description. */
const TASK_COMPLETE_DESCRIPTION =
	"Signal that all work is complete and stop automatic continuation prompts. Call this ONLY after finishing everything requested. Call exactly once per completed round of work — repeat calls with no new user message in between are rejected."

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

/**
 * True when a done-claim already carries a concrete work report.
 *
 * v1 asks for details once per done-claim and then trusts the answer. A length
 * check cannot tell the difference between "Task done." (nothing was done) and
 * a two-line summary, so v2 replaces the 400-char threshold with the same
 * structural test v1 uses. Prompting again after a real report would loop
 * forever (#26).
 *
 * Three signals, in order of specificity:
 *   - a backticked span naming a dotted file: `src/index.ts`
 *   - a bare path with a slash and a dotted extension: /a/b.py
 *   - a report header: changed / verification / results / commands run
 */
function containsWorkDescription(text: string): boolean {
	// Backticked span mentioning a dotted filename.
	if (/`[^`\n]*\.[a-zA-Z0-9]{1,8}[^`\n]*`/.test(text)) return true
	// Bare path with a slash and a dotted extension.
	if (/[\w\-~.][\w\-.~\/]*\/[\w\-.~]*\.[a-zA-Z]{1,8}\b/.test(text)) return true
	// Report section headers.
	if (
		/^(changed|modified|deleted|created|updated|renamed|moved|files?\s+changed|verification|verified|tests?(?:\s+run|\s+passing|\s+pass)?|results?|outcome|commands?\s+(?:run|executed))/im.test(
			text,
		)
	)
		return true
	return false
}

/**
 * True when the last assistant turn closes with a celebration emoji.
 *
 * A 🎉 is the model's own "I finished" signal, used to latch completion rather
 * than keep nudging. The emoji alone is not trustworthy: a model that finishes
 * early celebrates early, and latching on that turns a false positive into
 * silence. The todo cross-check that catches it lives at the call site, where
 * the fetched list is in hand.
 */
function endsWithCelebration(text: string): boolean {
	const normalized = text.trim().replace(/[.!?]+$/, "")
	return normalized.endsWith("🎉")
}

/**
 * One entry of a session's todo list.
 *
 * Read from the todo tool that is already installed, not from a list this
 * plugin keeps. The record shape is the one `todowrite` writes —
 * `storage.set("todos/<sessionID>", {todos, updatedAt})` — so whatever todo
 * tool the session uses is what this sees, and auto-resume never has to own a
 * second copy that can drift.
 */
interface Todo {
	content: string
	status: "pending" | "in_progress" | "completed" | "cancelled"
	priority: "high" | "medium" | "low"
}

function isOpenTodo(t: Todo): boolean {
	return t.status === "pending" || t.status === "in_progress"
}

function getOpenTodos(todos: Todo[]): Todo[] {
	if (!Array.isArray(todos)) return []
	return todos.filter(isOpenTodo)
}

/**
 * The prompt for a turn that claims to be finished with work still listed.
 *
 * Names the open items rather than saying "continue", because the model has
 * already decided it is done — a bare continuation prompt gets answered with
 * another done-claim. Falls back to a plain "continue" when the list is
 * unusable, which is strictly better than sending an empty reminder.
 */
function buildOpenTodosReminder(todos: Todo[]): string {
	if (!Array.isArray(todos)) return "continue"
	const open = todos.filter(isOpenTodo)
	if (open.length === 0) return "continue"
	const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
	const plural = open.length > 1 ? "s" : ""
	const taskWord = open.length > 1 ? "tasks" : "task"
	const thisWord = open.length > 1 ? "these" : "this"
	return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on ${thisWord} ${taskWord}.`
}


/** Candidate local server base URLs: env vars first, then /proc/self/cmdline.
 *  `cmdline` is injectable so the port parsing is unit-testable without spawning
 *  a process whose argv looks like a server invocation.
 *
 *  The /proc read is not belt-and-braces: under OpenChamber the server is spawned
 *  as `opencode serve --hostname 127.0.0.1 --port <n>` and exports NO port env
 *  var, so an env-only list comes back EMPTY and the HTTP source is never
 *  attempted at all. Same mechanism the prompt-polisher uses, which is why its
 *  HTTP DELETE reaches this same server.
 */
function serverBaseUrls(cmdline?: string): string[] {
	const out: string[] = []
	const push = (v: string | undefined) => {
	if (typeof v !== "string" || !v) return
	const url = v.startsWith("http") ? v : `http://127.0.0.1:${v.replace(/^:/, "")}`
	if (!out.includes(url)) out.push(url.replace(/\/$/, ""))
	}
	const env = process.env
	push(env.OPENCODE_SERVER_URL)
	push(env.OPENCODE_URL)
	push(env.OPENCODE_SERVER_PORT)
	push(env.OPENCODE_PORT)
	push(env.PORT)
	try {
		const raw = cmdline ?? readFileSync("/proc/self/cmdline", "utf8")
		const argv = raw.split("\0")
		const portFlag = argv.indexOf("--port")
		if (portFlag !== -1 && argv[portFlag + 1]) {
			const hostFlag = argv.indexOf("--hostname")
			const host = hostFlag !== -1 && argv[hostFlag + 1] ? argv[hostFlag + 1] : "127.0.0.1"
			push(`http://${host}:${argv[portFlag + 1]}`)
		}
	} catch {
	// /proc unavailable (non-Linux): env vars only
	}
	return out
}
/** HTTP Basic for the local server, same derivation the prompt-polisher uses. */
function serverHeaders(): Record<string, string> {
	const pw = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD
	if (!pw) return {}
	return { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` }
}
/**
 * Normalize a `todowrite` tool input into a todo list, or `undefined` when it is
 * not a usable list.
 *
 * An entry with an unrecognized status is KEPT (cast, not dropped): `isOpenTodo`
 * treats only `pending`/`in_progress` as open, so an unknown status reads as
 * closed. Dropping it would shrink the list, and a shrunken list is the
 * dangerous direction - it makes real open work look finished.
 */
function normalizeTodoList(input: unknown): Todo[] | undefined {
	if (input === null || typeof input !== "object") return undefined
	const todos = (input as { todos?: unknown }).todos
	if (!Array.isArray(todos)) return undefined
	const out: Todo[] = []
	for (const entry of todos) {
	if (entry === null || typeof entry !== "object") continue
	const e = entry as { content?: unknown; status?: unknown; priority?: unknown }
	if (typeof e.content !== "string" || typeof e.status !== "string") continue
	const todo: Todo = { content: e.content, status: e.status as Todo["status"], priority: "medium" }
	if (typeof e.priority === "string") todo.priority = e.priority as Todo["priority"]
	out.push(todo)
	}
	return out.length > 0 ? out : undefined
}
/**
 * Canonical parser, mirroring opencode-todo-fork's `todosFromMessages` (the same
 * routine is called `latestTodosFromMessages` in that repo's `src/tui-data.ts`):
 * walk the messages, and for every COMPLETED `todowrite` tool part keep its
 * normalized input. `todowrite` REPLACES the whole list, so the newest such call
 * IS the current list.
 *
 * This is a deliberate copy rather than an import, and the reason is worth
 * stating because it looks like an oversight otherwise. Plugins are loaded
 * independently and there is no cross-plugin import contract: reaching into a
 * sibling plugin's directory would tie auto-resume's ability to read a todo
 * list to that plugin being installed at that exact path, and auto-resume has to
 * work without it. The cost is that a fix to one copy is not automatically a fix
 * to the other - so both copies carry the ordering note below, and both repos
 * test the ranking rather than trusting it to stay in step.
 *
 * Order note: `/api/session/{id}/message` returns NEWEST FIRST, so a
 * last-match-wins loop selects the OLDEST list - that bug shipped in two places
 * before it was caught. Rank by timestamp instead, falling back to encounter
 * order, and skip a malformed historical call while keeping the previous valid
 * list.
 *
 * Returns `undefined`, never `[]`, so "no todos exist" stays distinguishable from
 * "we could not look" - that distinction is what keeps this diagnosable instead of
 * silently degrading.
 */
function todosFromMessages(messages: unknown): Todo[] | undefined {
	if (!Array.isArray(messages)) return undefined
	const candidates: { list: Todo[]; at: number | null; order: number }[] = []
	let order = 0
	for (const message of messages) {
	if (message === null || typeof message !== "object") continue
	const content = (message as { content?: unknown }).content
	if (!Array.isArray(content)) continue
	for (const part of content) {
	if (part === null || typeof part !== "object") continue
	const p = part as { type?: unknown; name?: unknown; state?: Record<string, any>; time?: any }
	if (p.type !== "tool" || p.name !== "todowrite") continue
	if (p.state?.status !== "completed") continue
	const list = normalizeTodoList(p.state.input)
	if (!list) continue
	const t = p.state?.time ?? p.time ?? (message as { time?: any }).time ?? {}
	const at = [t?.end, t?.start, t?.created].find((v: unknown) => typeof v === "number")
	candidates.push({ list, at: typeof at === "number" ? at : null, order: order++ })
	}
	}
	if (candidates.length === 0) return undefined
	candidates.sort((a, b) => {
	if (a.at !== null && b.at !== null && a.at !== b.at) return b.at - a.at
	if ((a.at === null) !== (b.at === null)) return a.at === null ? 1 : -1
	return a.order - b.order
	})
	return candidates[0]?.list
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

/** Edit distance, v1's implementation. Kept byte-for-byte in behaviour: the
 * suggestion is only useful if it picks the same tool v1 would have. */
function levenshtein(a: string, b: string): number {
	const m = a.length
	const n = b.length
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
		const tmp = prev
		prev = curr
		curr = tmp
	}
	return prev[n]
}

/**
 * The closest registered tool name to one the model invented, or null.
 *
 * The threshold scales with the length of the wrong name — `max(2, len/2)` — so a
 * short name is held to a near-exact match while a long one is allowed to be
 * sloppy. Without that, a two-letter name would match almost anything and the
 * suggestion would be noise.
 */
/**
 * Names models invent for tools that exist under another name. Edit distance
 * cannot bridge these ("bash"→"shell" is 4 against a threshold of 2), so the
 * map is consulted before the fuzzy matcher. The target must be registered —
 * an unguarded guess names a second nonexistent tool and teaches the model
 * the registry lies.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	bash: "shell",
}

function resolveToolSuggestion(wrongName: string, available: string[]): string | null {
	const alias = TOOL_NAME_ALIASES[wrongName.toLowerCase()]
	if (alias && available.includes(alias)) return alias
	return suggestClosestTool(wrongName, available)
}

function suggestClosestTool(wrongName: string, available: string[]): string | null {
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

/**
 * The one live instance of this plugin in this process, if any.
 *
 * `setup()` is re-run by the loader on every config reload — the live log shows
 * 2523 loads of this ONE entrypoint against a single server process, and bursts
 * of SIX `ready` lines with no `stopped` between them. Every setup call builds
 * its own `sessions` map, its own watchdog interval and its own event pump, so
 * six live instances meant six private `resumeAttempts` counters: one stall
 * produced six `resume attempt 1/3` lines in the same millisecond and six
 * identical continues with no wait between them (2026-10-03, session
 * ses_efcc2ade…kJmjQR3o). The counter was never broken — each copy had its own.
 *
 * Last-wins: a fresh setup disposes the previous instance before arming its own,
 * so exactly one watchdog and one counter exist no matter how often the loader
 * re-runs setup. Disposal is deliberately not left to the host, because the
 * storms prove it does not always happen.
 */
/**
 * The one live instance of this plugin in this PROCESS, shared across every
 * evaluation of this bundle.
 *
 * It lives on `globalThis`, not in module scope, and that is the whole fix. The
 * loader re-EVALUATES the plugin file on every config reload: the live log shows
 * one entrypoint URL, one pid, and a fresh module identity each time
 * (`mod=1812055.c6d4mu`, `.72a9tl`, `.dt27x7`, … six distinct copies inside one
 * server process). Module scope cannot help, because each copy gets its own
 * `activeInstance` — a singleton fix shipped that way and the storms continued
 * (19:54:19, eight identical `resume attempt 1/3` lines in 5ms).
 *
 * `globalThis` is shared by all module instances in a process (verified on both
 * node and bun), so a key here is the one channel that survives re-evaluation.
 * Each setup finds its predecessor through the registry and disposes it before
 * arming itself: last wins, so exactly one watchdog and one `resumeAttempts`
 * counter exist however often the loader reloads us. Disposal cannot be left to
 * the host, because the storms prove it does not always happen.
 *
 * Keyed by pid + plugin id: two servers in one process cannot happen, but two
 * config trees (v1 and v2) can load different builds, and they must not dispose
 * each other.
 */
const REGISTRY_KEY = `__auto_resume_singleton__:${process.pid}`

type SingletonRegistry = { live?: { dispose: () => void } }

function singletonRegistry(): SingletonRegistry {
	const g = globalThis as unknown as Record<string, SingletonRegistry | undefined>
	let reg = g[REGISTRY_KEY]
	if (!reg) {
		reg = {}
		g[REGISTRY_KEY] = reg
	}
	return reg
}

/**
 * Identity of THIS module evaluation, stamped into the ready line.
 *
 * `pid` separates processes; `eval` separates module evaluations inside one
 * process. Six distinct values under one pid is what exposed the real cause —
 * keep this until the storms are gone, because it is the only way to tell a
 * re-evaluation apart from a genuine second server.
 */
const MODULE_INSTANCE = `${process.pid}.${Math.random().toString(36).slice(2, 8)}`

export default define({
	id: "auto-resume.v2",

	setup: async (ctx: AutoResumePluginInput) => {
		// Supersede any instance the loader left running — found through the
		// process-wide registry, so it also catches instances belonging to OTHER
		// evaluations of this bundle. Wrapped: a throwing predecessor must not
		// block the new one from arming.
		const registry = singletonRegistry()
		if (registry.live) {
			try {
				registry.live.dispose()
			} catch {
				/* predecessor already torn down */
			}
			registry.live = undefined
		}
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
		const envVisible = process.env.AUTO_RESUME_VISIBLE_CONTINUE
		const visibleContinue =
			opts.visibleContinue ??
			(envVisible === undefined || envVisible === ""
				? true
				: /^(1|true|yes)$/i.test(envVisible))
		const richContinuePrompt = opts.richContinuePrompt ?? true
		const logFile = opts.logFile ?? process.env.AUTO_RESUME_LOG_FILE ?? DEFAULT_LOG_FILE
		const rateLimitCooldownsMs =
			Array.isArray(opts.rateLimitCooldownsMs) && opts.rateLimitCooldownsMs.length > 0 &&
			opts.rateLimitCooldownsMs.every((n) => typeof n === "number" && n > 0)
				? (opts.rateLimitCooldownsMs as number[])
				: DEFAULT_RATE_LIMIT_COOLDOWNS_MS
		// Inert probe: proves `plugins[].options` reaches `ctx.options` without
		// touching a live knob. Echoed in the `ready` line only.
		const configProbe = opts.configProbe ?? null
		// How long a parent may sit busy after its last subagent went idle before
		// the orphan watch acts. v1 default, honoured for the first time here.
		const subagentWaitMs = opts.subagentWaitMs ?? DEFAULT_SUBAGENT_WAIT_MS
		// How long to let a finished turn's text settle before judging it against the
		// done/tool patterns. v1's default, and the reason v1 does not judge on idle
		// at all — see inspectOnIdle.
		const toolTextCheckDelayMs = opts.toolTextCheckDelayMs ?? DEFAULT_TOOL_TEXT_CHECK_DELAY_MS

		// ---- Ported from v1 (Mte90/opencode-auto-resume#33) ----
		const rawBusyStallStrategy = opts.busyStallStrategy ?? "continue"
		const busyStallStrategy: "continue" | "abort" | "off" =
			rawBusyStallStrategy === "abort" || rawBusyStallStrategy === "off" ? rawBusyStallStrategy : "continue"
		// Feature-gated on v2 (see FEATURE_GATED_OPTIONS): accepted for config
		// compatibility, not yet acted on. Not bound to locals so they cannot be
		// mistaken for live behaviour.
		const resumeOnActionIntent = opts.resumeOnActionIntent !== false
		const warmupMs = opts.warmupMs ?? DEFAULT_WARMUP_MS
		// Live since the v2 discovery sweep landed (see discoverSessions).
		const discoveryDelayMs = opts.discoveryDelayMs ?? DEFAULT_DISCOVERY_DELAY_MS
		const minActivityGapMs = opts.minActivityGapMs ?? DEFAULT_MIN_ACTIVITY_GAP_MS
		// Live since the v2 token read landed (see tokenTotalOf / checkContextSaturation).
		const contextSaturationThreshold = opts.contextSaturationThreshold ?? DEFAULT_CONTEXT_SATURATION_THRESHOLD
		const subagentNativeCompactionEnabled = opts.subagentNativeCompactionEnabled ?? false
		// Live since the silent-dead-stream detector landed (lastSilentDeadStream).
		const silentDeadStreamMinTokens = opts.silentDeadStreamMinTokens ?? DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS
		const streamingFailureErrorNames = opts.streamingFailureErrorNames ?? DEFAULT_STREAMING_FAILURE_ERROR_NAMES
		const streamingFailureMessagePatterns = opts.streamingFailureMessagePatterns ?? DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS
		const doneWithoutDetailsPrompt = opts.doneWithoutDetailsPrompt ?? DONE_WITHOUT_DETAILS_PROMPT
		// Live since the todo read landed (see readTodos): a done-claim with items still
		// listed gets this prompt instead of the details prompt.
		const doneWithoutWorkPrompt = opts.doneWithoutWorkPrompt ?? DONE_WITHOUT_WORK_PROMPT
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
		//
		// Empty: every v1 option this build understands is now applied. Kept as a
		// list rather than deleted because the reporting below, and the
		// accepted-but-inert= note in the startup line, are the only things a user
		// has to go on when an option is quietly ignored — so the next one that
		// arrives has somewhere to be listed.
		const FEATURE_GATED_OPTIONS = [] as const

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
			"visibleContinue",
			"richContinuePrompt",
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
			"logFile",
			"rateLimitCooldownsMs",
			"configProbe",
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

		// Debug output goes to the same file as everything else. Console-only debug
		// is invisible in v2 for the same reason the rest of the logging was, and
		// debug is exactly when you are trying to work out what the plugin did.
		const dbg = (...args: unknown[]) => {
			if (!debug) return
			appendLogFile(logFile, "debug", `[auto-resume:debug] ${args.map((a) => String(a)).join(" ")}`)
			console.log("[auto-resume:debug]", ...args)
		}

		function log(level: "info" | "warn" | "error", msg: string) {
			const line = `[auto-resume] ${msg}`
			// v2 exposes no server log sink to plugins (ctx.app is
			// {name,version,channel}), so the file is the only retrievable record.
			appendLogFile(logFile, level, line)
			// Console too: harmless when nobody captures it, and the reason the
			// startup line is visible at all when running under `opencode serve`.
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
					lastProdText: "",
					prodAssistantSnapshot: "",
					ownPromptTexts: [],
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
					doneClaimOpenTodosAttempts: 0,
					todoNudgeAttempts: 0,
					intentNudgeAttempts: 0,
					completionSignaled: false,
					todos: [],
					todosFetchedAt: 0,
					taskCompleteSignals: 0,
					taskCompleteOverrides: 0,
					orphanWatchStartAt: null,
					orphanRecoveryTried: false,
					toolTextTimer: null,
					recoverTimer: null,
					lastSubagentCheckAt: 0,
					pendingTools: 0,
					toolsInFlightAtIdle: 0,
					rateLimitedAt: 0,
					rateLimitAttempts: 0,
					awaitingQuotaRetry: false,
					unknownToolErrors: new Map(),
					unknownToolSuggestionSent: false,
					checkedToolPartIDs: new Set(),
					lastUserMessageSeenAt: 0,
					lastTokenTotal: 0,
					contextWrapupAttempts: 0,
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
				// Deliberately NOT resetting doneClaimAttempts / doneClaimOpenTodosAttempts.
				// v1 moved both out of the busy-cycle reset for a reason (#26): a model
				// that keeps re-announcing completion would get a fresh budget on every
				// turn it announced, so the nudge never stopped. They re-arm only on a
				// genuine new work cycle — an inbound user message, via
				// noteInboundUserMessage().
				// The open-todos nudge is the opposite case and does reset here: an open
				// list is new information each turn, not a model that keeps saying the
				// same thing.
				w.todoNudgeAttempts = 0
				w.intentNudgeAttempts = 0
				// A new turn means the text a pending pattern pass was going to judge is
				// superseded, and markBusy has just emptied the buffer it would have read.
				if (w.toolTextTimer) {
					clearTimeout(w.toolTextTimer)
					w.toolTextTimer = null
				}
				// A new turn re-opens the question of whether the work is finished.
				w.completionSignaled = false
				w.gaveUp = false
				// A new turn means the parent moved on, so whatever the previous orphan
				// watch was about is no longer the question. Left armed, it would fire
				// mid-turn and abort a session that is doing exactly what it should.
				w.orphanWatchStartAt = null
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
				// Idle means nothing is in flight. Any slot still held belongs to a tool
				// that will never report — a subagent killed mid-call, for instance —
				// and keeping it would make the orphan watch defer on this session
				// forever.
				w.pendingTools = 0
				// This session is not the parent the watch is about: the watch is armed on
				// the session that *stays* busy, so an idle session's own watch is void.
				w.orphanWatchStartAt = null
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

		function isRateLimitError(errType: string, errMsg: string): boolean {
			return RATE_LIMIT_RE.test(`${errType} ${errMsg}`)
		}

		/**
		 * Stand down on quota/rate-limit failures instead of retrying into the
		 * ban. Gates, not timers: the decision is re-evaluated on each failure
		 * and each watchdog tick against `rateLimitedAt`, so nothing is lost
		 * to a reload. Served cooldowns flow into the normal `recover()` path
		 * (budgets, loop guard and inject guards all apply); past the ladder
		 * the session stays silent until a genuine user turn.
		 */
		function handleRateLimitFailure(sid: string, w: SessionWatch, errType: string, errMsg: string): void {
			const ladder = rateLimitCooldownsMs
			const n = w.rateLimitAttempts
			markIdle(sid)
			if (n >= ladder.length) {
				w.awaitingQuotaRetry = false
				log("warn", `${short(sid)} rate-limit budget exhausted (${ladder.length} attempts) — standing down until user turn`)
				return
			}
			const now = Date.now()
			if (w.rateLimitedAt > 0 && now - w.rateLimitedAt >= ladder[n]) {
				w.rateLimitAttempts = n + 1
				w.rateLimitedAt = now
				w.awaitingQuotaRetry = false
				w.pendingRecoveryArmed = true
				log("info", `${short(sid)} rate-limit cooldown served — retrying (attempt ${n + 1}/${ladder.length})`)
				void recover(sid, "rate-limit cooldown served")
				return
			}
			if (w.rateLimitedAt === 0) w.rateLimitedAt = now
			w.awaitingQuotaRetry = true
			const waitMs = Math.max(0, ladder[n] - (now - w.rateLimitedAt))
			log("warn", `${short(sid)} rate limited (${errType || "error"}) — standing down, next attempt in ${Math.ceil(waitMs / 1000)}s (${n + 1}/${ladder.length})`)
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
		 * Loopback session list with parentID rows. `ctx` offers no list/get/
		 * active surface and no client in production (verified 2026-10-06:
		 * every subagent check silently degraded to false, zero refusals in
		 * log history) — but `GET /api/session` answers with parentID rows
		 * under the same auth as the message reads. Short-TTL cache: verdicts
		 * and guards call this several times per watchdog pass. Fail-open
		 * toward the pre-guard behavior (empty) on any fetch problem.
		 */
		type SessionRow = { id?: unknown; parentID?: unknown }
		let sessionRowsCache: { at: number; rows: SessionRow[] } | null = null
		const SESSION_ROWS_TTL_MS = 10_000
		async function listSessionsHttp(): Promise<SessionRow[]> {
			const now = Date.now()
			if (sessionRowsCache && now - sessionRowsCache.at < SESSION_ROWS_TTL_MS) return sessionRowsCache.rows
			for (const base of serverBaseUrls()) {
				try {
					const res = await fetch(`${base}/api/session?limit=500`, { headers: serverHeaders() })
					if (!res.ok) continue
					const body = (await res.json()) as unknown
					const data = (body as { data?: unknown } | undefined)?.data ?? body
					if (Array.isArray(data)) {
						const rows = (data as SessionRow[]).filter((r) => r !== null && typeof r === "object")
						sessionRowsCache = { at: now, rows }
						return rows
					}
				} catch {
					// Next base; exhaustion degrades to stale/empty below.
				}
			}
			return sessionRowsCache?.rows ?? []
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
			if (!sub) {
				// HTTP fallback: prod ctx has no client (verified 2026-10-06),
				// so the lookup above always misses there. Same degraded-false
				// contract on any fetch problem.
				try {
					const rows = await listSessionsHttp()
					sub = rows.some((r) => r?.id === sid && typeof r?.parentID === "string")
				} catch {
					sub = false
				}
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
		/**
		 * Cross-instance duplicate check: is our exact text already the latest
		 * user message in the session log, posted within RECENT_PROD_WINDOW_MS?
		 * Stacked watchdogs (reload churn) each hold private counters, so the
		 * in-memory soft skip cannot see a sibling's prod — the log can.
		 * Fail-open: any fetch problem means "no info", never "duplicate".
		 */
		const RECENT_PROD_WINDOW_MS = 60_000
		async function recentOwnProdInLog(sid: string, text: string): Promise<boolean> {
			const pages: unknown[] = []
			try {
				const message = (ctx.client as any)?.session?.message
				if (typeof message?.list === "function") {
					const res = await message.list.call(message, { path: { id: sid } })
					const data = (res as { data?: unknown } | undefined)?.data ?? res
					if (Array.isArray(data)) pages.push(...data)
				}
			} catch {
				// Fall through to HTTP below.
			}
			if (pages.length === 0) {
				for (const base of serverBaseUrls()) {
					try {
						const res = await fetch(
							`${base}/api/session/${encodeURIComponent(sid)}/message?limit=20`,
							{ headers: serverHeaders() },
						)
						if (!res.ok) continue
						const body = ((await res.json()) as { data?: unknown } | undefined)?.data
						if (Array.isArray(body)) {
							pages.push(...body)
							break
						}
					} catch {
						// Next candidate base.
					}
				}
			}
			if (pages.length === 0) return false
			const now = Date.now()
			for (const m of pages) {
				if (m === null || typeof m !== "object") continue
				const msg = m as { role?: unknown; text?: unknown; content?: unknown; time?: unknown }
				if (msg.role !== "user") continue
				let t = ""
				if (typeof msg.text === "string") {
					t = msg.text
				} else if (Array.isArray(msg.content)) {
					t = (msg.content as unknown[])
						.filter(
							(p): p is { type: string; text: string } =>
								!!p &&
								typeof p === "object" &&
								(p as { type?: unknown }).type === "text" &&
								typeof (p as { text?: unknown }).text === "string",
						)
						.map((p) => p.text)
						.join("")
				}
				// Newest-first: the first user message decides. Anything newer
				// than our prod (user typed after it) is progress, not a dupe.
				if (t !== text) return false
				const created = (msg.time as { created?: unknown } | undefined)?.created
				if (typeof created === "number" && now - created > RECENT_PROD_WINDOW_MS) return false
				return true
			}
			return false
		}

		/**
		 * Per-session async mutex around the whole injection. Bun is
		 * single-threaded, so a promise chain serializes overlapping callers:
		 * stacked watchdogs interleave at every await, and without this the
		 * log check below runs six-wide against the same empty log before any
		 * send lands. First holder checks-then-sends; the rest re-check after
		 * and stand down on sight of the first prod.
		 */
		const injectLocks = new Map<string, Promise<void>>()
		async function withInjectLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
			const prev = injectLocks.get(sid) ?? Promise.resolve()
			let release!: () => void
			const current = new Promise<void>((resolve) => {
				release = resolve
			})
			// The chain tail is what the NEXT caller waits on, so it must resolve only
			// after this holder's work finishes — hence `prev.then(() => current)`.
			const tail = prev.then(() => current)
			injectLocks.set(sid, tail)
			await prev
			try {
				return await fn()
			} finally {
				release()
				// Drop the key once we are the last holder, so a long-lived process
				// does not accumulate one entry per session it ever watched.
				if (injectLocks.get(sid) === tail) injectLocks.delete(sid)
			}
		}

		/**
		 * The injection body. Split out of `injectOnce` so the per-session mutex
		 * wraps the WHOLE check-then-act: every guard above (subagent, self-abort,
		 * busy, debounce, duplicate) is a read, and the send is the write. Stacked
		 * callers interleave at every `await`, so six watchdogs could each pass all
		 * six reads against pre-send state and then all six send. Serialized here,
		 * the first caller to finish sends and the rest re-read its result.
		 */
		async function injectOnceLocked(
			sid: string,
			text: string,
			notification: string,
			allowDuringSelfAbort: boolean,
			checkDuplicate: boolean,
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
			// Exact-duplicate anti-repeat (cattleprod-style soft skip, opt-in per
			// caller): an immediate re-fire with identical text and zero model
			// progress since the last successful prod means the previous nudge
			// changed nothing — skip it and let the sliding-window counter /
			// escalation own the loop. No message fetch needed: progress is
			// assistant-text growth plus tool completions. Scoped to the stall
			// path by default: the targeted nudges below own per-kind budgets
			// with re-arm semantics this must not second-guess.
			if (
				checkDuplicate &&
				!allowDuringSelfAbort &&
				w.lastProdText !== "" &&
				text === w.lastProdText &&
				w.pendingTools <= 0 &&
				w.lastAssistantText === w.prodAssistantSnapshot
			) {
				dbg(`${short(sid)} duplicate continue suppressed — identical text, no progress since last prod`)
				return false
			}
			w.lastInjectAt = Date.now()
			// Cross-instance backstop for the in-memory skip above: stacked
			// watchdogs cannot see each other's counters, but they share the
			// log. Applies to every caller except the abort+resume escalation,
			// which must go through by construction.
			if (!allowDuringSelfAbort && (await recentOwnProdInLog(sid, text))) {
				dbg(`${short(sid)} duplicate continue suppressed — identical prod already in session log`)
				return false
			}
			const sent = await notifyAndPrompt(sid, text, notification)
			if (sent) {
				w.lastProdText = text
				w.prodAssistantSnapshot = w.lastAssistantText
				w.ownPromptTexts.push(text)
				if (w.ownPromptTexts.length > 10) w.ownPromptTexts.shift()
			}
			return sent
		}

		/** `injectOnceLocked` serialized per session; see the mutex's own comment. */
		async function injectOnce(
			sid: string,
			text: string,
			notification: string,
			allowDuringSelfAbort = false,
			checkDuplicate = false,
		): Promise<boolean> {
			return withInjectLock(sid, () =>
				injectOnceLocked(sid, text, notification, allowDuringSelfAbort, checkDuplicate),
			)
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
			if (visibleContinue) {
				// Cattleprod-style: a real user message in session history, so the
				// intervention — and any loop — is self-evident in the transcript.
				// Falls back to synthetic only if the prompt call throws.
				try {
					await ctx.session.prompt({ sessionID: sid, text })
					return true
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					log("warn", `${short(sid)} visible prompt failed: ${msg}`)
				// A transport error can land AFTER the message was delivered
				// (observed: twin identical prods 5ms apart). The delivered
				// prompt is a user message in the log, so verify before
				// falling back — a second send of the same text is the dupe.
				if (await recentOwnProdInLog(sid, text)) {
					dbg(`${short(sid)} prompt threw but the text is already the newest user message — treating as delivered`)
					return true
				}
				}
			}
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
				// Same verify-before-retry: a delivered synthetic also acts as
				// a user turn, so it reads back through the same log check.
				if (await recentOwnProdInLog(sid, text)) {
					dbg(`${short(sid)} synthetic threw but the text is already the newest user message — treating as delivered`)
					return true
				}
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
		 * Build the stall-continue text. A custom `continuePrompt` always wins
		 * verbatim; otherwise, when `richContinuePrompt` is on (default), the
		 * text names the stall reason, attempt count, and remaining todos
		 * (cattleprod-style) instead of bare "continue". Same channel and
		 * guards either way — only the content changes.
		 */
		async function buildStallContinueText(sid: string, reason: string, attempt: number): Promise<string> {
			if (opts.continuePrompt !== undefined && opts.continuePrompt !== "") return opts.continuePrompt
			if (!richContinuePrompt) return CONTINUE_PROMPT
			let suffix = "Todo list unavailable."
			try {
				const todos = await readTodos(sid)
				const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
				if (open.length > 0) {
					const lines = open
						.slice(0, 5)
						.map((t) => `• [${t.status}] ${String(t.content).slice(0, 120)}`)
					if (open.length > 5) lines.push(`• …and ${open.length - 5} more`)
					suffix = `Remaining todos:\n${lines.join("\n")}`
				} else {
					suffix = "No open todos recorded."
				}
			} catch {
				// Best effort: a todo-read failure must never block recovery.
			}
			return `continue — stalled (${reason}; attempt ${attempt}/${maxRetries}).\n${suffix}`.slice(0, 2000)
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
			if (w.recoverTimer) clearTimeout(w.recoverTimer)
			w.recoverTimer = setTimeout(async () => {
				w.recoverTimer = null
				// Disposed instances must stay silent: a superseded setup's
				// backoff outlives its own dispose (which is exactly how twin
				// identical prods landed milliseconds apart).
				if (!running) return
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
					// Re-check the parent-wait guard: a child may have gone live
					// between detection and this delayed inject. Interrupting a
					// parent that is waiting on a subagent kills real work.
					if (await parentWaitingOnSubagents(sid, new Set(await getActiveSessions()))) {
						dbg(`${short(sid)} waiting on subagents at inject time — not interrupting`)
						return
					}
					// Same re-check for user input: a question asked between
					// detection and this delayed inject parks the turn.
					if (isWaitingOnUser(await loadMessages(sid))) {
						dbg(`${short(sid)} waiting on user input at inject time — not interrupting`)
						return
					}
					const stallText = await buildStallContinueText(sid, reason, attempt)
					const ok = await injectOnce(sid, stallText, "stalled — retrying", false, true)
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

		/**
		 * Read the session's todo list.
		 *
		 * v1 tracked todos from a `todo.updated` event and a server API. v2 has neither:
		 * nothing emits a todo event and no route reaches the todo table.
		 *
		 * What v2 DOES have is the session message log. Every `todowrite` call is
		 * persisted as a tool part whose input carries the entire list, so the newest
		 * completed call IS the current list. That is the real store, so it is read first
		 * - reading anything else first is what made auto-resume conclude "no todos"
		 * while the list was sitting in the log.
		 *
		 * `ctx.storage.get("todos/<sid>")` is kept LAST, and it is NOT a source of
		 * another plugin's todos. `ctx.storage` is namespaced per plugin: the key
		 * resolves to `storage/plugin/auto-resume.v2/todos/<sid>.json`, while a todo
		 * plugin writing the same key lands in its OWN directory
		 * (`storage/plugin/<its-id>/todos/<sid>.json`). Verified against the live
		 * server: `/api/plugin/storage/<PLUGIN-ID>/<key>` carries the plugin id as a
		 * path segment, and the on-disk tree is `storage/plugin/<PLUGIN-ID>/<key>.json`.
		 * So no key auto-resume does not write itself can ever hold a todo list here.
		 *
		 * Do not promote it back to primary, and do not "fix" the mismatch by writing
		 * the key: a reader cannot make another plugin's data appear in its namespace,
		 * and duplicating that data would create a second writer racing the first. The
		 * message log above is the only store both plugins can agree on.
		 *
		 * Cached for a short TTL: this is read on every idle inspection, and the list can
		 * only change while the model is working, which is not when we ask. Returns `[]` on
		 * any failure - every caller treats "no list" as "cannot conclude", never as
		 * "nothing is open".
		 */
		async function readTodos(sid: string): Promise<Todo[]> {
			const w = ensureWatch(sid)
			const now = Date.now()
			if (w.todosFetchedAt && now - w.todosFetchedAt < TODO_CACHE_TTL_MS) return w.todos
			const fromMessages = await todosFromMessageSources(sid)
			if (fromMessages) {
			w.todos = fromMessages
			w.todosFetchedAt = now
			return w.todos
			}
			if (!ctx.storage) return w.todos
			try {
			const raw = await ctx.storage.get(`todos/${sid}`)
			const record = raw as { todos?: unknown; updatedAt?: unknown } | null | undefined
			const list = Array.isArray(record?.todos) ? record.todos : []
			w.todos = list.filter(
			(t): t is Todo =>
			!!t && typeof t === "object" && typeof (t as Todo).content === "string" &&
			typeof (t as Todo).status === "string",
			)
			w.todosFetchedAt = now
			return w.todos
			} catch (e) {
			dbg(`${short(sid)} todo read failed:`, e instanceof Error ? e.message : String(e))
			return w.todos
			}
		}
		/**
		 * Try every plausible source of a session's messages, in order, returning the
		 * parsed todo list from the first that yields a `todowrite` tool part.
		 *
		 * Requires host access beyond the plugin ctx: `readFileSync` on
		 * `/proc/self/cmdline`, and a loopback HTTP GET. Both are best-effort - a host
		 * that refuses either degrades to the storage fallback rather than throwing.
		 */
		async function todosFromMessageSources(sid: string): Promise<Todo[] | undefined> {
			// 1. The SDK client, if this plugin ctx was given one. Unwrap the `{data,cursor}`
			// envelope: handing it straight to the parser trips its Array.isArray guard and
			// silently resolves nothing.
			try {
			const message = (ctx.client as any)?.session?.message
			if (typeof message?.list === "function") {
			const res = await message.list.call(message, { path: { id: sid } })
			const got = todosFromMessages(res?.data ?? res)
			if (got) {
			dbg(`${short(sid)} todos via ctx.client.session.message.list (${got.length})`)
			return got
			}
			}
			} catch (e) {
			dbg(`${short(sid)} client message.list failed:`, e instanceof Error ? e.message : String(e))
			}
			// 2. The local HTTP server. Same shape the prompt-polisher already uses, so the
			// auth and base-URL derivation are proven rather than guessed.
			for (const base of serverBaseUrls()) {
			try {
			// `limit` matters: the default page is 50 messages and 200 is the server's
			// ceiling (probed - 250 returns 400). Newest first, so a recent `todowrite` is
			// always inside the page.
			const res = await fetch(`${base}/api/session/${encodeURIComponent(sid)}/message?limit=200`, {
			headers: serverHeaders(),
			})
			if (!res.ok) {
			dbg(`${short(sid)} HTTP message read ${res.status} from ${base}`)
			continue
			}
			// Same envelope trap as source 1: `{data, cursor}`, never a bare array.
			const body = await res.json()
			const got = todosFromMessages(body?.data ?? body)
			if (got) {
			dbg(`${short(sid)} todos via HTTP ${base} (${got.length})`)
			return got
			}
			} catch (e) {
			dbg(`${short(sid)} HTTP message read failed:`, e instanceof Error ? e.message : String(e))
			}
			}
			return undefined
		}


		/**
		 * Arm the deferred pattern pass, replacing any already pending.
		 *
		 * Replacement rather than stacking is the point: two idles inside one delay
		 * window would otherwise judge the same turn twice, and a turn that matches
		 * would spend two attempts of its budget on one piece of text.
		 */
		function schedulePatternPass(sid: string): void {
			const w = ensureWatch(sid)
			if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
			w.toolTextTimer = setTimeout(() => {
				w.toolTextTimer = null
				// v1's own guard, and it is doing real work here: a turn that started
				// during the delay has its own idle, and its own armed pass. Judging
				// this one now would read the live buffer, which markBusy has already
				// emptied for the new turn.
				if (w.status !== "idle") {
					dbg(`${short(sid)} pattern pass skipped — session is ${w.status}, not idle`)
					return
				}
				if (w.userCancelled) return
				void inspectOnIdle(sid, "pattern")
			}, toolTextCheckDelayMs)
			dbg(`${short(sid)} pattern pass armed for +${toolTextCheckDelayMs}ms`)
		}

		async function targetedRecovery(
			sid: string,
			kind: string,
			prompt: string,
			budgetKey: "toolTextAttempts" | "doneClaimAttempts" | "doneClaimOpenTodosAttempts" | "todoNudgeAttempts" | "intentNudgeAttempts",
		) {
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
		 * Fetch a session's message history once per idle inspection.
		 *
		 * Four separate checks below want the same array — the dead-stream
		 * detector, the text fallback, the pending-tool and active-user lookups —
		 * and `ctx.session.context()` is the expensive call in all of them (it is
		 * every message since the last compaction). v1 fetched once for the same
		 * reason. The cache lives only for the duration of one inspection, so a
		 * later idle always sees the freshest history.
		 *
		 * Returns `[]` on any failure: this is forensic, and every caller already
		 * treats "no history" as "cannot conclude".
		 */
		async function loadMessages(sid: string): Promise<unknown[]> {
			try {
				const res = await ctx.session.context({ sessionID: sid })
				return Array.isArray(res) ? res : ((res as { messages?: unknown[] })?.messages ?? [])
			} catch (e) {
				dbg(`${short(sid)} session.context() failed:`, e instanceof Error ? e.message : String(e))
				return []
			}
		}

		/** The newest assistant message that delivered text, joined. "" when none. */
		function lastAssistantTextFrom(messages: unknown[]): string {
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
		}

		/**
		 * The newest assistant message's reasoning text, joined. "" when none.
		 *
		 * A reasoning block is the one place a model writes a tool call that never
		 * becomes one: the raw markup lands in the reasoning and nothing executes.
		 * v1 caught that on the same pass as the text variant and answered with a
		 * different prompt, because the fix is different — the model is not
		 * forgetting the mechanism, it is writing in the wrong channel.
		 *
		 * v2 separates the two cleanly, since `AssistantContent` tags reasoning and
		 * text distinctly where v1 filtered them together into one string.
		 */
		function lastAssistantReasoning(messages: unknown[]): string {
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i] as {
					type?: string
					content?: Array<{ type?: string; text?: string }>
				}
				if (!msg || msg.type !== "assistant" || !Array.isArray(msg.content)) continue
				const reasoning = msg.content
					.filter((part) => part?.type === "reasoning" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join("")
				if (reasoning) return reasoning
			}
			return ""
		}

		/**
		 * v1's `getLastSilentDeadStream`, on the v2 message shape.
		 *
		 * The model can finish a turn having produced no text at all — reasoning
		 * only, or a `finish=unknown` that the provider did not describe. The
		 * turn looks complete, so nothing raises, and the session simply stops.
		 * A `finish` with real text behind it means the session answered normally
		 * and there is nothing to recover.
		 *
		 * Only the newest assistant message that *has* a finish is judged, and the
		 * walk skips messages without one — an intermediate tool-call step has no
		 * finish, and walking back past a delivered answer to one of those would
		 * recover a session that just used a tool.
		 *
		 * Returns `null` when the newest finished message carried text — or when it
		 * carried tool calls, which are delivered work, not silence. A thinking
		 * model doing tool work ends turns with a finish reason, spent output
		 * tokens, and no text parts; judging that "silent" fires a continue
		 * into active work (ses_efaec2f99ffexosULGDJJ8i6sA, 2026-10-04).
		 * Returns `null` as well when there is no finished message at all.
		 */
		function lastSilentDeadStream(messages: unknown[]): { finish: string; outputTokens: number } | null {
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i] as {
					type?: string
					content?: Array<{ type?: string; text?: string }>
					finish?: string
					tokens?: { output?: number }
				}
				if (msg?.type !== "assistant") continue
				const finish = typeof msg.finish === "string" ? msg.finish : undefined
				if (!finish) continue
				const parts = Array.isArray(msg.content) ? msg.content : []
				const hasText = parts.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.length > 0)
				if (hasText) return null
				// Same tool-part convention as hasPendingUserInput: a finished
				// turn that issued tool calls did work, even with no chatter.
				const hasToolCalls = parts.some((p) => {
					const t = p?.type ?? ""
					return t === "tool_use" || t === "tool" || t === "tool_call" || t.startsWith("tool")
				})
				if (hasToolCalls) return null
				return { finish, outputTokens: posNum(msg.tokens?.output) }
			}
			return null
		}

		/**
		 * Recover a stream that finished without ever delivering text.
		 *
		 * Ported from v1 including its guard: re-check the server's own status
		 * first, because a provider that is quietly retrying looks identical from
		 * the event stream, and interrupting that would turn a recovering session
		 * into a stalled one. Then arm the pending-recovery latch — without it
		 * `recover()`'s inject-time check reads an idle session as "recovered by
		 * itself" and drops the injection.
		 *
		 * Returns true when it took action, so the caller stops looking.
		 */
		async function recoverSilentDeadStream(sid: string, messages: unknown[]): Promise<boolean> {
			const dead = lastSilentDeadStream(messages)
			if (!dead) return false
			if (dead.outputTokens < silentDeadStreamMinTokens) {
				dbg(
					`${short(sid)} last finished message has no text, but only ${dead.outputTokens} output tokens (floor ${silentDeadStreamMinTokens}) — not treating it as a dead stream`,
				)
				return false
			}
			const w = ensureWatch(sid)
			// Tools still awaiting results are working, not stalled — even when
			// the finished message predates the tool events and looks dead.
			// Reads the at-idle snapshot, not the live counter: markIdle zeroes
			// it on the transition, and idle fires while tools run.
			if (w.toolsInFlightAtIdle > 0) {
				dbg(`${short(sid)} silent dead stream, but ${w.toolsInFlightAtIdle} tool(s) still in flight — working, not stalled`)
				return true
			}
			// Ask the server before injecting, not just our own flag. A provider
			// that is quietly retrying looks exactly like a dead stream from the
			// event stream, and the event may not have arrived yet when the turn
			// ends — which is v1's own reason for re-checking live status here.
			if (w.status === "busy" || (await getActiveSessions()).includes(sid)) {
				dbg(`${short(sid)} silent dead stream, but the session is running again — likely a provider retry`)
				return true
			}
			w.pendingRecoveryArmed = true
			log(
				"info",
				`${short(sid)} silent dead stream: finish=${dead.finish}, ${dead.outputTokens} output tokens, no text parts; resuming`,
			)
			await recover(sid, `Silent dead stream (${dead.finish})`)
			return true
		}

		/**
		 * True when the session is holding the ball: a tool call whose result is
		 * still outstanding.
		 *
		 * A synthetic nudge in that state starts a step the user's real reply then
		 * interrupts ("Step interrupted"), so every idle recovery path stands down.
		 *
		 * This used to test `state.status === "pending"`, which v2 never emits, so
		 * the branch was unreachable and the nudge fired with an unanswered
		 * `question` on screen. See TOOL_STATE_* above.
		 */
		function hasPendingUserInput(messages: unknown[]): boolean {
			const newest = messages[messages.length - 1] as {
				type?: string
				content?: { type?: string; name?: string; state?: { status?: string } }[]
			}
			if (newest?.type !== "assistant") return false
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
			return false
		}

		/**
		 * Narrow user-wait check for the busy-stall path. Unlike
		 * `hasPendingUserInput` (any unfinished tool means the idle turn
		 * isn't over), a busy session with a wedged bare tool and zero events
		 * IS a stall — so only tools whose completion is the user answering
		 * (`question`, `permission`, `ask`, `confirm`) count. A turn parked
		 * on one of those is waiting, not stalled (ses_ef72c5f3 2026-10-05: a
		 * stall continue fired into a session parked on a `question`).
		 */
		function isWaitingOnUser(messages: unknown[]): boolean {
			const newest = messages[messages.length - 1] as {
				type?: string
				content?: { type?: string; name?: string; state?: { status?: string } }[]
			}
			if (newest?.type !== "assistant") return false
			for (const part of newest.content ?? []) {
				const t = part?.type ?? ""
				if (!(t === "tool_use" || t === "tool" || t === "tool_call" || t.startsWith("tool"))) continue
				if (!AWAITING_USER_TOOLS.has(part?.name ?? "")) continue
				// As in `hasPendingUserInput`: "error" means interrupted, not
				// answered — only a completed user-awaiting tool ends the wait.
				if (part?.state?.status !== TOOL_STATE_COMPLETED) return true
			}
			return false
		}

		async function shouldStandDownForUser(
			sid: string,
			messages: unknown[],
			activeUserWindowMs: number,
		): Promise<boolean> {
	try {
		if (messages.length === 0) return false
		// (a) A tool call still awaiting its result — see hasPendingUserInput.
		if (hasPendingUserInput(messages)) return true
		// (b) The user was recently active — they are mid-conversation, not stuck.
		//
		// v1 stamps `lastUserMessageAt` on ANY inbound user message and asks
		// "was there one inside activeUserWindowMs?". This used to ask "is the
		// newest message a user message?", which at idle time is essentially never
		// true — the newest message is the assistant turn that just finished — so
		// the whole window was dead. Walk back for the most recent user message.
		let lastUserAt: number | undefined
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as {
				type?: string
				role?: string
				time?: { created?: number }
				info?: { time?: { created?: number }; role?: string }
			}
			const isUser = m?.type === "user" || m?.role === "user" || m?.info?.role === "user"
			if (!isUser) continue
			const ts = m.time?.created ?? m.info?.time?.created
			if (typeof ts === "number") lastUserAt = ts
			break
		}
		if (lastUserAt !== undefined && Date.now() - lastUserAt < activeUserWindowMs) return true
		return false
	} catch {
		return false
	}
}

/**
		 * Re-arm the done-claim budgets when a genuinely new work cycle starts.
		 *
		 * The signal is an inbound user message, and what makes one genuine is that
		 * it is a *different* message — identified by id, not by timestamp. A
		 * re-delivered or replayed message has the same id and is not new work;
		 * comparing clock times instead would treat any drift between two reads of
		 * the history as a new request and hand the model a fresh budget every time
		 * it repeated itself, which is exactly what #26 was. Timestamps are only the
		 * fallback, for messages that carry no id.
		 *
		 * The history is already loaded, so this costs nothing extra.
		 *
		 * Doing this only here (and not on every busy cycle) is the #26 fix: a model
		 * that re-announces completion each turn would otherwise be handed a fresh
		 * budget each time it announced, and the nudge would never stop.
		 */
		function noteInboundUserMessage(sid: string, w: SessionWatch, messages: unknown[]): void {
			let latest: { id?: string; at?: number; text?: string } | null = null
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as {
					id?: string
					type?: string
					role?: string
					time?: { created?: number }
					info?: { time?: { created?: number }; role?: string }
					content?: Array<{ type?: string; text?: string }>
				}
				const isUser = m?.type === "user" || m?.role === "user" || m?.info?.role === "user"
				if (!isUser) continue
				const text = Array.isArray(m?.content)
					? m.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n")
					: undefined
				latest = { id: typeof m.id === "string" ? m.id : undefined, at: m.time?.created ?? m.info?.time?.created, text }
				break
			}
			if (!latest) return
			const isNew = latest.id
				? latest.id !== w.lastUserMessageID
				: typeof latest.at === "number" && latest.at > w.lastUserMessageSeenAt
			if (!isNew) return
			w.lastUserMessageID = latest.id
			if (typeof latest.at === "number") w.lastUserMessageSeenAt = latest.at
			// Our own injections travel the visible channel as real user messages.
			// They start a new turn but carry no new instructions: re-arming on
			// them clears the budgets just spent and the same errors refire on
			// the next idle (ses_ef81e8561ffeXyx3jAzKl5lltv, 2026-10-04 — four
			// identical unknown-tool prompts, each "2x"). Tracking above stays
			// truthful; only the clearing is skipped. Two signals: exact text
			// match, and recency to our last inject — the live projection can
			// carry user messages with no readable body (content null), which
			// defeats text matching, but our prompt always lands within seconds
			// of the inject on the same box clock.
			const ownByText = typeof latest.text === "string" && latest.text.length > 0 && w.ownPromptTexts.includes(latest.text)
			const ownByTime =
				typeof latest.at === "number" &&
				w.lastInjectAt > 0 &&
				latest.at >= w.lastInjectAt &&
				latest.at - w.lastInjectAt < OWN_PROMPT_TIME_MS
			if (ownByText || ownByTime) {
				dbg(`${short(sid)} newest user message is our own prompt — not re-arming budgets`)
				return
			}
			if (w.doneClaimAttempts > 0 || w.doneClaimOpenTodosAttempts > 0) {
				dbg(`${short(sid)} new user message — re-arming the done-claim budgets`)
			}
			w.doneClaimAttempts = 0
			w.doneClaimOpenTodosAttempts = 0
			// A new request is new work: the ack self-loop counter starts clean,
			// because the model re-announcing completion after the user asked for
			// more is not the stuck case this counts.
			w.taskCompleteSignals = 0
			// The unknown-tool budget is scoped to one request for the same reason:
			// a model told to do something new gets a fresh tool list, and one
			// invented name in the previous round says nothing about this one.
			if (w.unknownToolErrors.size > 0 || w.unknownToolSuggestionSent) {
				dbg(`${short(sid)} new user message — re-arming the unknown-tool budget`)
			}
			w.unknownToolErrors.clear()
			w.unknownToolSuggestionSent = false
			// Deliberately NOT clearing checkedToolPartIDs: already-reported
			// errors must never be recounted. Clearing it made every genuine
			// user message re-suggest the same stale errors (2026-10-04: one
			// bash suggestion per message, long after the model moved to shell).
			// New error parts still count fresh toward the threshold.
		}

		/** Registered tool names, cached briefly — the registry only changes when a
		 * plugin reloads, and this runs on every idle. */
		let cachedToolIds: string[] | null = null
		let cachedToolIdsAt = 0

		async function getAvailableToolIds(): Promise<string[]> {
			if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) return cachedToolIds
			if (!ctx.tool?.list) return cachedToolIds ?? []
			try {
				const listed = await ctx.tool.list()
				// `id` is the effective name — the namespaced form when the tool sits
				// in a namespace — which is exactly the string a model would have to
				// call, so it is what the suggestion has to quote back.
				const ids = (listed as Array<{ id?: string; name?: string }>)
					.map((t) => (typeof t?.id === "string" && t.id ? t.id : typeof t?.name === "string" ? t.name : ""))
					.filter((n) => n.length > 0)
				cachedToolIds = ids
				cachedToolIdsAt = Date.now()
				return ids
			} catch (e) {
				log("warn", `failed to list tools: ${e instanceof Error ? e.message : String(e)}`)
				// Stale names are better than none for a "does this exist" check: a
				// tool added since the cache would be wrongly called unknown, but
				// that costs one extra suggestion, while an empty list skips the
				// check entirely and loses the feature.
				return cachedToolIds ?? []
			}
		}

		/**
		 * Name a replacement when a model keeps calling a tool that does not exist.
		 *
		 * v1 asks `ctx.client.tool.ids()`. v2 has no such route; `ctx.tool.list()`
		 * returns the same set of effective names, which is all this needs.
		 *
		 * The tool parts come from the message history rather than from events,
		 * because the whole point is a part that already *errored* — by the time the
		 * error lands, the `session.tool.called` event for that part is long gone,
		 * and this code only runs on idle anyway.
		 */
		async function checkForUnknownToolCalls(sid: string, w: SessionWatch): Promise<boolean> {
			if (w.userCancelled || w.completionSignaled) return false
			try {
				const messages = await loadMessages(sid)
				// The history is read before the "already suggested" guard, and the
				// per-request reset rides on that read. The guard used to come first,
				// and since this runs alongside inspectOnIdle the ordering was undefined
				// — on a re-armed turn the guard could see the previous turn's latch
				// still standing and skip the check that was supposed to re-arm it.
				noteInboundUserMessage(sid, w, messages)
				if (w.unknownToolSuggestionSent) return false
				const available = await getAvailableToolIds()
				// No registry, or nothing registered: every name would look unknown.
				if (available.length === 0) return false
				for (const msg of messages) {
					const content = (msg as { content?: unknown })?.content
					if (!Array.isArray(content)) continue
					for (const part of content as Array<Record<string, unknown>>) {
						if (part?.type !== "tool") continue
						// v2's tool part identifies itself by `id` and names the tool in
						// `name` — v1 read `part.tool`, which v2 never emits, so the
						// comparison there would have been against "" and never matched.
						const partId = typeof part.id === "string" ? part.id : ""
						if (!partId || w.checkedToolPartIDs.has(partId)) continue
						w.checkedToolPartIDs.add(partId)
						const state = part.state as { status?: string } | undefined
						if (state?.status !== "error") continue
						const toolName = typeof part.name === "string" ? part.name : ""
						if (!toolName || available.includes(toolName)) continue
						const count = (w.unknownToolErrors.get(toolName) ?? 0) + 1
						w.unknownToolErrors.set(toolName, count)
						if (count < UNKNOWN_TOOL_THRESHOLD) continue
						const suggestion = resolveToolSuggestion(toolName, available)
						const toolList = available.slice(0, UNKNOWN_TOOL_LIST_LIMIT).join(", ")
						const prompt = suggestion
							? `You tried to use the tool "${toolName}" ${count} times, but it does not exist. ` +
								`The closest matching tool is "${suggestion}". ` +
								`Please use "${suggestion}" instead and adjust your arguments accordingly. ` +
								`Available tools include: ${toolList}.`
							: `You tried to use the tool "${toolName}" ${count} times, but it does not exist. ` +
								`Please check the available tools and use the correct one. ` +
								`Available tools include: ${toolList}.`
						w.unknownToolSuggestionSent = true
						log(
							"warn",
							`${short(sid)} unknown tool "${toolName}" called ${count}x, suggesting "${suggestion ?? "(none)"}"`,
						)
						await injectOnce(sid, prompt, "unknown-tool")
						return true
					}
				}
				return false
			} catch (e) {
				log("warn", `${short(sid)} unknown-tool check failed: ${e instanceof Error ? e.message : String(e)}`)
				return false
			}
		}

		/**
		 * `task_complete`: the model's explicit "I am finished".
		 *
		 * v2 has no built-in equivalent — `grep -rl task_complete packages` finds
		 * nothing — so registering it here is the only way it exists at all, and
		 * this is a real feature rather than a compatibility shim: it is the
		 * strongest completion signal available, stronger than a trailing 🎉,
		 * because the model chose to call it.
		 *
		 * Ported from v1 with its escalation intact. The ack tool-result is fed
		 * straight back into the turn, and a stuck model answers it by calling the
		 * tool again rather than ending with text — v1 logged 27 consecutive acked
		 * calls with zero new user input. So: first call acks with an explicit stop
		 * instruction, second warns, third throws and the turn is forced to end.
		 *
		 * The counter is reset by a new inbound user message and by any other tool
		 * call, so the escalation only ever measures a genuinely stuck loop rather
		 * than several legitimate rounds of work.
		 */
		async function registerTaskCompleteTool(): Promise<void> {
			if (!ctx.tool?.transform) {
				dbg("tool registry unavailable — task_complete not offered")
				return
			}
			try {
				await ctx.tool.transform((editor) => {
					editor.add({
						name: "task_complete",
						description: TASK_COMPLETE_DESCRIPTION,
						// No arguments. v1's `args: {}` is the same thing: the signal
						// is the call, not a payload.
						input: { type: "object", properties: {}, additionalProperties: false },
						execute: async (_input, toolCtx) => {
							const sid = toolCtx?.sessionID
							if (!sid) return { content: TASK_COMPLETE_ACK }
							const w = ensureWatch(sid)

							// A subagent reporting completion is not a parent finishing,
							// and gating a child's report on the parent's todo list would
							// block it on work it was never asked to do. v1 skips the
							// todo gate for subagents for the same reason.
							if (!(await isSubAgentSession(sid))) {
								const open = getOpenTodos(await readTodos(sid))
								if (open.length > 0 && w.taskCompleteOverrides < maxRetries) {
									w.taskCompleteOverrides++
									// Work remains, so a later completion is legitimate: reset the
									// repeat-signal counter rather than letting this override feed
									// the escalation.
									w.taskCompleteSignals = 0
									const reminder = buildOpenTodosReminder(open)
									const blockMsg = `Mark any finished todos complete and do not redo completed work.\n${reminder}`
									log(
										"info",
										`${short(sid)} task_complete blocked: ${open.length} open todos remain (override ${w.taskCompleteOverrides}/${maxRetries})`,
									)
									// Also fire a visible nudge naming the blocking todos, in case
									// the tool result collapses to an invisible one-liner. Skipped
									// when the user holds the ball — injecting then would start a
									// step their real reply interrupts. The tool result already
									// carries the todo names either way.
									let awaitingInput = false
									try {
										awaitingInput = hasPendingUserInput(await loadMessages(sid))
									} catch (e) {
										dbg(`${short(sid)} task_complete block: awaiting-input check failed:`, e instanceof Error ? e.message : String(e))
									}
									if (awaitingInput) {
										log("info", `${short(sid)} task_complete blocked but user input pending — skipping visible nudge`)
									} else {
										await injectOnce(sid, blockMsg, "task-complete-blocked")
									}
									return { content: blockMsg }
								}
							}

							w.completionSignaled = true
							log("info", `${short(sid)} task_complete called, ${(await isSubAgentSession(sid)) ? "subagent" : "agent"} done`)
							w.taskCompleteSignals++
							if (w.taskCompleteSignals === 2) return { content: TASK_COMPLETE_REPEAT_WARNING }
							if (w.taskCompleteSignals > 2) throw new Error(TASK_COMPLETE_REPEAT_ERROR)
							return { content: TASK_COMPLETE_ACK }
						},
					})
				})
				log("info", "registered the task_complete tool")
			} catch (e) {
				// A failed registration must not take the watchdog down with it.
				const msg = e instanceof Error ? e.message : String(e)
				log("warn", `task_complete registration failed (${msg}) — continuing without it`)
			}
		}

		/**
		 * Judge a finished turn — in two phases, because the text may not have settled.
		 *
		 * v1 evaluates the done/tool patterns from a timer armed on the idle event
		 * (`toolTextCheckDelayMs`, 3s by default) rather than on the event itself, and
		 * the delay is the feature: `session.idle` can arrive while the assistant's
		 * final text is still being written into the message history, and a check that
		 * reads too early sees a half-finished turn and either misses the pattern or
		 * judges a turn that was not over.
		 *
		 * v2 already avoids most of that race with the live delta buffer, which is
		 * why this port was able to judge on idle for as long as it did. It does not
		 * remove it: the buffer is empty when the plugin loaded mid-turn, and the
		 * fallback is exactly the history that may not have flushed. So the option is
		 * honoured by splitting the work:
		 *
		 * - **structural** (immediately): is this a dead stream, is it handing control
		 *   to the user, is the user already busy. None of these depend on the final
		 *   text, and a dead stream must be caught before anything that reads text.
		 * - **pattern** (after the delay): the celebration, tool-call-as-text, ready-to-
		 *   continue, action-intent and done-claim detectors. These are exactly the
		 *   ones that read the last text and so are exactly the ones the settle delay
		 *   exists for.
		 *
		 * The guards above the split run again in the pattern phase, deliberately: three
		 * seconds is long enough for the user to have replied, and a nudge fired through
	 *   their reply is the bug the hand-off and stand-down guards exist to prevent.
		 */
		async function inspectOnIdle(sid: string, phase: "structural" | "pattern" = "structural") {
			const w = ensureWatch(sid)
			const messages = await loadMessages(sid)
			noteInboundUserMessage(sid, w, messages)

			// Judged first, and before anything that needs text: a stream that died
			// before delivering any text is precisely the case where every
			// text-based check below would find nothing to look at.
			if (await recoverSilentDeadStream(sid, messages)) return

			// Prefer the live delta buffer; fall back to the authoritative message
			// history when it is empty (e.g. the plugin loaded mid-turn) or stale.
			let text = w.lastAssistantText
			if (!text) text = lastAssistantTextFrom(messages)
			if (!text) return

			// A turn that ends by handing control back to the user (a question or an
			// explicit prompt) is awaiting their reply; a synthetic nudge here starts
			// an in-flight step that their real reply then interrupts ("Step
			// interrupted"). Never nudge a hand-off turn.
			if (isUserHandoff(text)) {
				dbg(`${short(sid)} idle turn ends with a user hand-off — skipping targeted recovery`)
				return
			}

			if (await shouldStandDownForUser(sid, messages, activeUserWindowMs)) {
				dbg(`${short(sid)} user has pending input or was recently active — standing down`)
				return
			}

			if (phase === "structural") {
				schedulePatternPass(sid)
				return
			}

			// The model's own completion signal. A trailing 🎉 means it considers the
			// work finished, so nudging here would talk over a deliberate stop.
			// Latched rather than re-derived, because the next idle with no new text
			// would otherwise re-check the same turn forever.
			//
			// Cross-checked against the todo list, because the emoji alone is not
			// trustworthy: a model that finishes early celebrates early, and latching
			// on that turns a false positive into permanent silence. With work still
			// listed, the celebration is a false positive and the right answer is to
			// name what is unfinished.
			if (endsWithCelebration(text)) {
				const open = getOpenTodos(await readTodos(sid))
				if (open.length > 0) {
					// Deliberately not latching: the list is still open, so this turn is
					// not a completion and the next one must be free to judge again.
					await targetedRecovery(
						sid,
						"open-todos-celebration-false-positive",
						buildOpenTodosReminder(open),
						"todoNudgeAttempts",
					)
					return
				}
				if (!w.completionSignaled) {
					w.completionSignaled = true
					log("info", `${short(sid)} turn ends with a celebration and no open todos — latching completion, not nudging`)
				} else {
					dbg(`${short(sid)} completion already latched — skipping`)
				}
				return
			}

			// A raw tool call written into the reasoning block never executes: no
			// part is tagged as a tool call, so nothing on the session side ever
			// runs it. Judged before the text variant because a message can have
			// both, and the reasoning one is the one that silently does nothing.
			const reasoning = lastAssistantReasoning(messages)
			if (reasoning && containsToolCallAsText(reasoning)) {
				await targetedRecovery(sid, "tool-call-in-reasoning", thinkingToolRecoveryPrompt, "toolTextAttempts")
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
			if (containsDoneClaimPattern(text, doneClaimPatterns)) {
				// Two different prompts for two different situations, which is why the
				// budgets are separate: spending the details prompt must not silence the
				// one that says work is still listed.
				const open = getOpenTodos(await readTodos(sid))
				if (open.length > 0) {
					await targetedRecovery(sid, "done-claim-open-todos", doneWithoutWorkPrompt, "doneClaimOpenTodosAttempts")
					return
				}
				if (w.doneClaimAttempts < maxRetries) {
					// Ask once for the work report. v2 used to gate this on a 400-char
					// length, which cannot tell "Task done." from a real summary and so
					// both over-nudged terse reports and let short-but-real ones pass.
					// containsWorkDescription is the same structural test v1 uses, and
					// prompting again after a real report loops forever (#26).
					if (!containsWorkDescription(text)) {
						await targetedRecovery(sid, "done-claim-no-details", doneWithoutDetailsPrompt, "doneClaimAttempts")
					} else {
						dbg(`${short(sid)} done-claim carries a work description — skipping details prompt`)
					}
				}
			}

			// A full context window is a separate failure mode from a stalled one: the
			// session keeps working happily until it chokes. Judged last, because it is
			// the only check here that acts on the session rather than the text, and a
			// saturated session that also produced a terse done-claim wants the
			// reclamation, not the details prompt.
			await checkContextSaturation(sid)
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

		/** Busy sessions we are tracking, excluding cancelled ones. The orphan watch
		 * keys on this count: a subagent finishing is only interesting because it
		 * leaves exactly one session busy. */
		function busySessionsForOrphanWatch(): string[] {
			const out: string[] = []
			for (const [sid, w] of sessions) {
				if (w.status === "busy" && !w.userCancelled) out.push(sid)
			}
			return out
		}

		/**
		 * The subagents of `parentSid`, by v2's own parent link.
		 *
		 * v1 had no way to ask, so it treated *any other busy session* as a subagent of
		 * the one in hand. That works on a single-project box and misfires on a busy
		 * one: a second unrelated session looks like a child, and the parent gets
		 * aborted for someone else's work. v2 stores `parent_id` on the session row, so
		 * the question can simply be asked.
		 *
		 * The filter is requested *and* verified client-side. `parentID` is part of
		 * the list input, but the only consequence of it being quietly ignored would be
		 * aborting real sessions, so the returned rows are checked rather than trusted.
		 */
		async function listSubagentIds(parentSid: string): Promise<string[]> {
			const listed = unwrapList(await callSessionApi<unknown>("list", { parentID: parentSid }))
			const out: string[] = []
			for (const row of listed) {
				const sid = row?.id
				if (typeof sid !== "string" || !sid.startsWith("ses_")) continue
				if (sid === parentSid) continue
				if ((row as { parentID?: unknown }).parentID !== parentSid) continue
				out.push(sid)
			}
			if (out.length === 0) {
				// HTTP fallback: prod ctx has no list surface, so the call
				// above always misses there (verified 2026-10-06). Same
				// client-side verification as above.
				for (const row of await listSessionsHttp()) {
					const sid = row?.id
					if (typeof sid !== "string" || !sid.startsWith("ses_")) continue
					if (sid === parentSid) continue
					if (row?.parentID !== parentSid) continue
					out.push(sid)
				}
			}
			return out
		}

		type SubagentVerdict = { status: "crashed" | "idle" | "busy"; stuckSid?: string }

		/**
		 * What a parent's subagents are doing, in v1's three-way shape.
		 *
		 * v1 scans the global status map for any other *busy* session and treats a
		 * quiet one as "idle" — the parent is stuck with nothing to wait for. That
		 * reading cannot work on v2, and the reason is worth stating: this function is
		 * only ever reached *after* a child went idle, so a child being absent from
		 * the active set is the premise, not the finding. Reading that absence as
		 * "idle" would make every crashed subagent look like a healthy one, and the
		 * whole feature would abort the parent without ever trying to wake the child.
		 *
		 * So a child is judged on what it last did, not on whether the server still
		 * lists it:
		 *
		 * - **active, and recent** — running. Wait.
		 * - **active, and silent past the threshold** — hung. The fuse is tripled while
		 *   a tool call is still outstanding, because a five-minute build is not a
		 *   dead model and killing the parent there loses the work.
		 * - **not active, recent** — it finished. Nothing to wait for.
		 * - **not active, silent past the threshold** — it stopped without ever
		 *   reporting. Waking it is worth one attempt.
		 */
		async function subagentVerdict(parentSid: string, activeIDs: Set<string>): Promise<SubagentVerdict> {
			try {
				const children = await listSubagentIds(parentSid)
				if (children.length === 0) return { status: "idle" }
				const now = Date.now()
				let sawBusy = false
				for (const child of children) {
					const messages = await loadMessages(child)
					const last = messages[messages.length - 1] as
						| {
							type?: string
							error?: unknown
							time?: { created?: number }
							content?: Array<{ type?: string; state?: { status?: string } }>
						}
						| undefined
					if (last?.type === "assistant" && last.error !== undefined) {
						dbg(`subagent ${short(child)} reported an error`)
						return { status: "crashed" }
					}
					const msgTime = last?.time?.created
					const silentFor = typeof msgTime === "number" ? now - msgTime : Infinity
					// An unanswered tool part is the "still working, slowly" case.
					const hasToolCall = (last?.content ?? []).some(
						(p) => p?.type === "tool" && p.state?.status !== "completed" && p.state?.status !== "error",
					)
					const limit = hasToolCall ? SUBAGENT_STUCK_MS * 3 : SUBAGENT_STUCK_MS
					if (silentFor <= limit) {
						// Recent enough to be believed, whatever the server thinks.
						if (activeIDs.has(child)) sawBusy = true
						continue
					}
					dbg(
						`subagent ${short(child)} silent for ${Math.round(silentFor / 1000)}s (active=${activeIDs.has(child)})`,
					)
					return { status: "crashed", stuckSid: child }
				}
				return sawBusy ? { status: "busy" } : { status: "idle" }
			} catch (e) {
				dbg(`subagent check failed for ${short(parentSid)}:`, e instanceof Error ? e.message : String(e))
				// Unknown is treated as busy: the cost of waiting is a later abort, and
				// the cost of guessing wrong is a killed session.
				return { status: "busy" }
			}
		}

		/**
		 * Nudge a stuck subagent directly.
		 *
		 * v1 uses the client prompt route. v2's plugin-scoped `session.synthetic`
		 * takes an explicit sessionID and appends the message to that session, which is
		 * the same effect without needing a cross-session route the plugin API does
		 * not expose.
		 *
		 * The general `injectOnce` refuses subagents, and correctly so: a child is
		 * not ours to recover. This is the one exception, and it is deliberate — the
		 * parent is stuck *because* the child is, so waking the child is cheaper than
		 * killing the parent and its whole turn.
		 */
		async function recoverStuckSubagent(sid: string): Promise<boolean> {
			try {
				await callSessionApi("synthetic", { sessionID: sid, text: SUBAGENT_RECOVERY_PROMPT })
				log("info", `${short(sid)} recovery prompt sent to stuck subagent`)
				return true
			} catch (e) {
				log("warn", `failed to recover subagent ${short(sid)}: ${e instanceof Error ? e.message : String(e)}`)
				return false
			}
		}

		/**
		 * The orphan watch.
		 *
		 * The failure it exists for: a parent dispatches a subagent, the subagent dies
		 * without a terminal event, and the parent waits forever on a result that is
		 * never coming. Nothing is busy, nothing is idle-from-the-runtime's-point-of-view,
		 * and every ordinary watchdog path declines to act because the silence is shorter
		 * than `chunkTimeoutMs`.
		 *
		 * Armed from `session.idle`: when the busy count drops from more than one to
		 * exactly one, the survivor is a parent whose children have all gone quiet.
		 * After `subagentWaitMs` the watchdog asks what the children are doing and, if
		 * there is no live work left, aborts and resumes the parent.
		 */
		/**
		 * Arm the watch on a session that just outlived its subagents — but only if it
		 * really had some.
		 *
		 * The busy-count drop alone is not evidence. Two unrelated conversations open
		 * at once, one of them finishes, and the survivor looks identical to a parent
		 * whose child died: one session left, busy. v1 has no way to tell them apart
		 * and aborts the survivor either way, which on a busy box means killing
		 * somebody's conversation for a colleague's finishing turn.
		 *
		 * v2 can tell them apart, so it does: one listing call at arm time turns a
		 * guess into a fact. The cost is one query per 2-to-1 transition, and the
		 * alternative is an abort that cannot be undone.
		 */
		async function armOrphanWatch(sid: string): Promise<void> {
			const w = sessions.get(sid)
			if (!w || w.orphanWatchStartAt !== null) return
			if (w.status !== "busy" || w.userCancelled || w.completionSignaled) return
			try {
				if (await isSubAgentSession(sid)) return
				const children = await listSubagentIds(sid)
				// Re-checked after the await: the session may have gone idle, been
				// cancelled, or been picked up by another arming while we were listing.
				if (w.orphanWatchStartAt !== null || w.status !== "busy" || w.userCancelled) return
				if (children.length === 0) {
					dbg(`${short(sid)} outlived a busy session but has no subagents — not an orphan parent`)
					return
				}
				w.orphanWatchStartAt = Date.now()
				w.orphanRecoveryTried = false
				log(
					"info",
					`subagents of ${short(sid)} fell quiet while it stayed busy. orphan watch (${subagentWaitMs / 1000}s, ${children.length} subagent(s))`,
				)
			} catch (e) {
				dbg(`orphan arming check failed for ${short(sid)}:`, e instanceof Error ? e.message : String(e))
			}
		}

		async function runOrphanWatch(sid: string, w: SessionWatch, now: number, activeIDs: Set<string>): Promise<void> {
			if (now - w.orphanWatchStartAt! < subagentWaitMs + gracePeriodMs) return
			if (w.resumeAttempts >= maxRetries) {
				if (!w.gaveUp) {
					w.gaveUp = true
					w.orphanWatchStartAt = null
					log("warn", `${short(sid)} orphan watch gave up after ${w.resumeAttempts} attempts`)
				}
				return
			}
			// Never abort a parent that is running a tool. Two independent sources,
			// because the counter can miss a tool that started before the plugin loaded:
			// our own event-derived count, and the tool parts in the message history.
			if (w.pendingTools > 0) {
				dbg(`${short(sid)} parent has ${w.pendingTools} tool(s) in flight — deferring orphan abort`)
				w.orphanWatchStartAt = now
				return
			}
			if (hasPendingUserInput(await loadMessages(sid))) {
				dbg(`${short(sid)} parent is waiting on the user — deferring orphan abort`)
				w.orphanWatchStartAt = now
				return
			}

			const verdict = await subagentVerdict(sid, activeIDs)
			if (verdict.status === "crashed") {
				// Waking the child is cheaper than killing the parent, so it is tried
				// first — but exactly once. If the child does not come back, the parent
				// is the only thing left to save and the watch stops asking.
				if (verdict.stuckSid && !w.orphanRecoveryTried) {
					w.orphanRecoveryTried = true
					if (await recoverStuckSubagent(verdict.stuckSid)) {
						w.orphanWatchStartAt = now
						return
					}
				}
				log("info", `${short(sid)} subagent crashed and did not recover — aborting and resuming the parent`)
				tryAbortAndResume(sid, w)
				return
			}
			if (verdict.status === "busy") {
				dbg(`${short(sid)} subagents still working — waiting`)
				w.orphanWatchStartAt = now
				return
			}
			// No subagent is active and none is stuck enough to name. v1 aborts here,
			// and so does this — the thing standing between that and a wrong kill is
			// subagentWaitMs, which is how long the parent was given to consume a
			// finished child's result before this runs at all. Set it to something
			// small and this becomes a blunt instrument; the option's own default is
			// 15s, and its name is the warning.
			log("info", `${short(sid)} stuck with no live subagents — aborting and resuming`)
			tryAbortAndResume(sid, w)
		}

		/**
		 * Parent-wait guard for the busy-stall path. A parent blocked on a live
		 * subagent is quiet on its own sessionID by construction — the child's
		 * events belong to the child — so "no activity for Ns" must not by itself
		 * trigger recovery. Deliberately independent of the `lastWasTaskTool`
		 * heuristic below: native dispatches may never emit `session.tool.called`,
		 * and the server active set may lag the parentID link.
		 *
		 * Waits when the verdict confirms a live child, or when the parent still
		 * holds tools in flight against children that are neither confirmed live
		 * nor proven dead. A crashed verdict, or tools held with no children on
		 * the link at all (wedged bare tool), falls through to normal recovery.
		 */
		async function parentWaitingOnSubagents(sid: string, activeIDs: Set<string>): Promise<boolean> {
			const verdict = await subagentVerdict(sid, activeIDs)
			if (verdict.status === "busy") return true
			if (verdict.status !== "idle") return false
			const w = ensureWatch(sid)
			if (w.pendingTools <= 0) return false
			const children = await listSubagentIds(sid)
			return children.length > 0
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
			const activeSet = new Set(activeIDs)

			for (const [sid, w] of sessions) {
				if (w.status !== "busy" || w.userCancelled) continue
				// Warmup: a session that only just went busy has not had a chance to
				// emit anything. Without this a freshly-started turn can be declared
				// stalled while it is still queueing its first model call.
				if (now - w.createdAt < warmupMs) continue
				// The orphan watch comes first, ahead of the silence check below,
				// because that is the whole point of it: a parent waiting on a dead
				// subagent has been quiet for less than chunkTimeoutMs, so every
				// ordinary path would decline to act.
				if (w.orphanWatchStartAt !== null) {
					if (!w.aborting && !w.gaveUp && !w.completionSignaled) {
						await runOrphanWatch(sid, w, now, activeSet)
					}
					continue
				}
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
				// A parent waiting on a live subagent is working, not stalled. The
				// heuristic above misses native dispatches (no tool.called event)
				// and active-set lag; the parentID link does not (see
				// parentWaitingOnSubagents, ses_ef73a206 2026-10-04).
				if (await parentWaitingOnSubagents(sid, activeSet)) {
					dbg(`${short(sid)} waiting on subagents — skipping stall detection`)
					continue
				}
				// A turn parked on user input (a `question` awaiting an answer,
				// an unanswered permission beyond the event flow) is waiting,
				// not stalled. Narrower than the idle-path check on purpose: a
				// wedged bare tool with zero events is still a stall.
				if (isWaitingOnUser(await loadMessages(sid))) {
					dbg(`${short(sid)} waiting on user input — skipping stall detection`)
					continue
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
			// Rate-limit gate: sessions stood down on quota get one attempt per
			// served cooldown, evaluated here so no armed timer can be lost to
			// a reload. Guards mirror the failure handler; `recover()` applies
			// its own budget, loop and inject guards on top.
			for (const [rsid, rw] of sessions) {
				if (!rw.awaitingQuotaRetry) continue
				const rn = rw.rateLimitAttempts
				if (rn >= rateLimitCooldownsMs.length) {
					rw.awaitingQuotaRetry = false
					continue
				}
				if (rw.userCancelled || rw.gaveUp || rw.compacting || rw.permissionPending) continue
				if (selfAbortActive(rw)) continue
				if (Date.now() - rw.rateLimitedAt < rateLimitCooldownsMs[rn]) continue
				rw.awaitingQuotaRetry = false
				rw.rateLimitAttempts = rn + 1
				rw.rateLimitedAt = Date.now()
				rw.pendingRecoveryArmed = true
				log("info", `${short(rsid)} rate-limit cooldown served — retrying (attempt ${rn + 1}/${rateLimitCooldownsMs.length})`)
				void recover(rsid, "rate-limit cooldown served")
			}
			cleanupIdleSessions()
		}

		const watchdog = setInterval(() => {
			checkActiveSessions().catch((e) =>
				log("error", `watchdog failed: ${e instanceof Error ? e.message : String(e)}`),
			)
		}, checkIntervalMs)

		// Discovery sweep. Separate timer from the watchdog because the two have
		// different jobs and different costs: the watchdog runs every few seconds
		// and must stay cheap, discovery lists every session and runs every 60s.
		// The initial sweep waits out discoveryDelayMs so plugin load does not
		// compete with the turn that triggered it.
		const discoveryTimer = setInterval(() => {
			discoverSessions().catch((e) =>
				log("error", `discovery failed: ${e instanceof Error ? e.message : String(e)}`),
			)
		}, DEFAULT_SESSION_DISCOVERY_INTERVAL_MS)
		const initialDiscovery = setTimeout(() => {
			discoverSessions().catch(() => {})
		}, discoveryDelayMs)

		// Offered to the model before the first turn, so it can actually be called.
		// Awaited, but guarded: a registry that refuses the registration must not
		// stop the watchdog from starting.
		await registerTaskCompleteTool()

		// ---------------------------------------------------------------------
		// Context saturation
		// ---------------------------------------------------------------------

		/**
		 * v2 emits `session.usage.updated` with the session's current usage, so the
		 * token count is read rather than reconstructed. `TokenUsage.total` in the
		 * schema sums input + output + reasoning + cache read + cache write; v1
		 * accumulated the same way.
		 */
		function tokenTotalOf(tokens: unknown): number {
			if (!tokens || typeof tokens !== "object") return 0
			const t = tokens as {
				input?: number
				output?: number
				reasoning?: number
				cache?: { read?: number; write?: number }
			}
			const cache = t.cache ?? {}
			return posNum(t.input) + posNum(t.output) + posNum(t.reasoning) + posNum(cache.read) + posNum(cache.write)
		}
		function posNum(v: unknown): number {
			return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
		}

		/**
		 * The usable context window for a session's model: the full window minus the
		 * smaller of a 20k output reserve and the model's own output limit. This is
		 * v1's arithmetic (`limit.context - Math.min(20_000, limit.output)`), kept
		 * identical so the same threshold means the same thing on both builds.
		 *
		 * v2 hands the limit over directly on `ctx.model.get()` — `Model.Info.limit`
		 * is `{ context, input?, output }` — where v1 had to walk the raw provider
		 * list. Cached per model, because the answer never changes at runtime.
		 */
		const usableLimitCache = new Map<string, number>()
		async function getUsableContextLimit(sid: string): Promise<number | null> {
			try {
				let ref = sessions.get(sid)?.modelRef
				if (!ref) {
					// No step observed yet (plugin loaded mid-session): take the ref off
					// the newest assistant message instead.
					const msgs = await ctx.session.context({ sessionID: sid })
					if (Array.isArray(msgs)) {
						for (let i = msgs.length - 1; i >= 0; i--) {
							const m = msgs[i] as {
								type?: string
								model?: { providerID?: string; id?: string; modelID?: string }
							}
							if (m?.type !== "assistant" || !m.model) continue
							const providerID = m.model.providerID
							const modelID = m.model.modelID ?? m.model.id
							if (typeof providerID === "string" && typeof modelID === "string") {
								ref = { providerID, modelID }
								const w = sessions.get(sid)
								if (w) w.modelRef = ref
							}
							break
						}
					}
				}
				if (!ref) return null
				const key = `${ref.providerID}/${ref.modelID}`
				const cached = usableLimitCache.get(key)
				if (cached !== undefined) return cached

				const info = (ctx.model as any)?.get?.(ref.providerID, ref.modelID)
				if (!info) return null
				const limit = (info as { limit?: { context?: number; output?: number } }).limit
				if (!limit || typeof limit.context !== "number" || limit.context === 0) return null
				const usable = limit.context - Math.min(20_000, limit.output ?? 0)
				if (!Number.isFinite(usable) || usable <= 0) return null
				usableLimitCache.set(key, usable)
				return usable
			} catch (e) {
				dbg(`usable-context-limit lookup failed for ${short(sid)}:`, e instanceof Error ? e.message : String(e))
				return null
			}
		}

		/**
		 * v2 hands plugins a narrowed `ctx.session` domain (see
		 * `packages/plugin/src/promise/session.ts`) that omits `list`, `active` and
		 * `compact`, so those are read defensively: off the session domain first,
		 * then off the raw client. A host that supplies neither degrades to the
		 * event-derived busy set rather than failing.
		 *
		 * `args` matters for the client's methods, which take a request object
		 * (`{ sessionID }`), unlike the plugin-domain wrappers.
		 */
		async function callSessionApi<T>(name: string, args?: Record<string, unknown>): Promise<T | undefined> {
			const fromDomain = (ctx.session as any)[name]
			if (typeof fromDomain === "function") {
				try {
					return (await fromDomain.call(ctx.session, args)) as T
				} catch (e) {
					dbg(`ctx.session.${name}() failed:`, e instanceof Error ? e.message : String(e))
				}
			}
			const fromClient = ctx.client?.session?.[name as "get"]
			if (typeof fromClient === "function") {
				try {
					return (await (fromClient as any).call(ctx.client!.session, args)) as T
				} catch (e) {
					dbg(`ctx.client.session.${name}() failed:`, e instanceof Error ? e.message : String(e))
				}
			}
			return undefined
		}

		/**
		 * Is magic-context installed?
		 *
		 * v1 read `config.get().plugin`. v2 has no `config` domain on the plugin
		 * context, but `ctx.plugin.list()` carries the same information in the
		 * server's own words: `Plugin.Info[]` with an `id` plus a `source` that is a
		 * package spec, a local path, or an SDK module. Matching id *and* source is
		 * what makes this work regardless of how the plugin was installed.
		 *
		 * Cached, negative verdict included — an idle check must not re-list plugins.
		 */
		let magicContextDetected: boolean | null = null
		async function isMagicContextInstalled(): Promise<boolean> {
			if (magicContextDetected !== null) return magicContextDetected
			try {
				const list = (ctx.plugin as any)?.list
				if (typeof list !== "function") {
					dbg("magic-context detection: ctx.plugin.list unavailable, treating as not installed")
					return false
				}
				const plugins = unwrapList(await list.call(ctx.plugin)) as Array<{ id?: string; source?: unknown }>
				magicContextDetected = plugins.some((p) => {
					const id = typeof p?.id === "string" ? p.id : ""
					if (id.toLowerCase().includes("magic-context")) return true
					const src = p?.source as { target?: string; path?: string } | undefined
					const spec = src?.target ?? src?.path ?? ""
					return typeof spec === "string" && spec.toLowerCase().includes("magic-context")
				})
				dbg(`magic-context detection: ${magicContextDetected ? "installed" : "not installed"}`)
				return magicContextDetected
			} catch (e) {
				dbg("magic-context detection failed, treating as not installed:", e instanceof Error ? e.message : String(e))
				return false
			}
		}

		/** Unwrap the `{ data }` envelope the client uses, or pass an array through. */
		function unwrapList(response: unknown): Array<Record<string, unknown>> {
			if (Array.isArray(response)) return response as Array<Record<string, unknown>>
			if (response && typeof response === "object") {
				const data = (response as { data?: unknown }).data
				if (Array.isArray(data)) return data as Array<Record<string, unknown>>
			}
			return []
		}

		/**
		 * v1's saturation routing, ported to the v2 API.
		 *
		 * A session can fill its window without stalling — it just keeps working
		 * until it chokes. On idle, when used/usable crosses the threshold, routing
		 * depends on session kind:
		 *
		 *   subagent — opt-in only (`subagentNativeCompactionEnabled`). v1 called
		 *             `session.summarize()`; v2 spells it `session.compact`, which
		 *             is NOT in the plugin `session` Pick, so it goes through the same
		 *             defensive lookup as `list`/`active`.
		 *   parent   — only when magic-context is installed, because its setup
		 *             disables native compaction and compacting here would
		 *             double-compress. v1 sent the `ctx-wrapup` command through the
		 *             client; `session.command` IS on the plugin domain in v2.
		 *
		 * Fail-safe, as in v1: a missing limit, a missing token count, a user
		 * cancellation, or a signalled completion means no intervention at all.
		 * The intervention is one-shot per turn.
		 */
		async function checkContextSaturation(sid: string): Promise<void> {
			const w = sessions.get(sid)
			if (!w) return
			if (w.lastTokenTotal <= 0) return
			if (w.contextWrapupAttempts >= 1) return
			if (w.userCancelled || w.completionSignaled || w.aborting) return

			const usable = await getUsableContextLimit(sid)
			if (!usable) return
			if (w.lastTokenTotal / usable < contextSaturationThreshold) return

			const pct = Math.round((w.lastTokenTotal / usable) * 100)
			if (await isSubAgentSession(sid)) {
				if (!subagentNativeCompactionEnabled) {
					dbg(`${short(sid)} subagent at ${pct}% of usable context; native compaction is opt-in`)
					return
				}
				w.contextWrapupAttempts++
				log(
					"warn",
					`${short(sid)} context saturation (subagent): ${w.lastTokenTotal}/${usable} tokens (${pct}% of usable); triggering native compaction`,
				)
				// Re-check the latches: the awaits above left a window for the user
				// to cancel in.
				if (w.userCancelled || w.completionSignaled) return
				const compacted = await callSessionApi<unknown>("compact", { sessionID: sid })
				if (compacted === undefined) {
					log("warn", `${short(sid)} native compaction is not exposed on this host — skipping`)
				}
				return
			}

			if (!(await isMagicContextInstalled())) {
				dbg(`${short(sid)} at ${pct}% of usable context; magic-context not installed, not intervening`)
				return
			}
			w.contextWrapupAttempts++
			log(
				"warn",
				`${short(sid)} context saturation: ${w.lastTokenTotal}/${usable} tokens (${pct}% of usable); sending magic-context wrapup command`,
			)
			if (w.userCancelled || w.completionSignaled) return
			try {
				await (ctx.session as any).command({ sessionID: sid, name: CTX_WRAPUP_TRIGGER })
			} catch (e) {
				log(
					"warn",
					`${short(sid)} magic-context wrapup command failed: ${e instanceof Error ? e.message : String(e)}`,
				)
			}
		}

		/**
		 * Seed watch state for sessions that already exist, and mark the ones
		 * currently running as busy.
		 *
		 * v1 did this by polling `session.list()` and trusting a `status` field
		 * on each row. v2 has something better: `session.active()` is the
		 * server's own record of what is running right now, so "busy" is read
		 * rather than guessed. A session that was already mid-turn when the
		 * plugin loaded would otherwise be invisible — no `execution.started`
		 * ever reaches us for it, so the stall watchdog would have nothing to
		 * watch.
		 */
		async function discoverSessions() {
			try {
				const listed = unwrapList(await callSessionApi<unknown>("list"))
				let seeded = 0
				for (const row of listed) {
					const sid = row?.id
					if (typeof sid !== "string" || !sid.startsWith("ses_")) continue
					if (!sessions.has(sid)) {
						ensureWatch(sid)
						seeded++
					}
				}

				// Authoritative busy set. Anything listed as running but not
				// already tracked busy starts its stall clock now, not from
				// whenever the plugin happened to attach.
				const active = await callSessionApi<Record<string, unknown>>("active")
				let adopted = 0
				if (active && typeof active === "object") {
					for (const [sid, val] of Object.entries(active)) {
						if (!sid.startsWith("ses_")) continue
						const w = ensureWatch(sid)
						if (w.status !== "busy") {
							markBusy(sid)
							adopted++
						} else {
							// Already busy from events; refresh nothing, but make
							// sure the session is not left `createdAt`-stale so
							// the warmup window does not swallow its first stall.
							void val
						}
					}
				}

				if (seeded > 0 || adopted > 0) {
					log("info", `discovery: seeded ${seeded} session(s), adopted ${adopted} already running`)
				} else {
					dbg("discovery: nothing new")
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				dbg(`session discovery failed: ${msg}`)
			}
		}

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
					} else {
						if (w.oocLocked) {
							w.oocLocked = false
							w.oocLockReason = null
							log("info", `${short(sid)} genuine execution — clearing OOC lock`)
						}
						// A genuine turn is activity, and activity means quota is
						// available again: the rate-limit ladder starts over. Our
						// own recovery turns (selfRecovery) do not reset it.
						w.rateLimitedAt = 0
						w.rateLimitAttempts = 0
						w.awaitingQuotaRetry = false
					}
					markBusy(sid)
					return
				}
				case "session.usage.updated": {
					// The session's current context usage. `tokenTotalOf` mirrors
					// `TokenUsage.total` in the schema (input + output + reasoning +
					// cache read + cache write) so the ratio means the same thing here
					// as in v1, which accumulated the same five fields.
					const sid = sidOf(ev)
					if (!sid) return
					const total = tokenTotalOf(ev.data?.tokens)
					if (total <= 0) return
					const w = ensureWatch(sid)
					w.lastTokenTotal = total
					dbg(`${short(sid)} usage: ${total} tokens`)
					return
				}

				case "session.execution.succeeded":
				case "session.idle": {
					const sid = sidOf(ev)
					if (!sid) return
					// Counted across every tracked session, and read *before* this one goes
					// idle, because the transition is the signal: a session leaving a crowd
					// of busy sessions behind it. Sampling after markIdle would make every
					// idle look like a drop to zero and the arming condition unreachable.
					const busyBefore = busySessionsForOrphanWatch().length
					// Snapshot before the transition for the same reason: markIdle
					// zeroes the live counter, and idle fires while tools run.
					const wPre = ensureWatch(sid)
					wPre.toolsInFlightAtIdle = wPre.pendingTools
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
					// Arm the orphan watch. A subagent going idle is only interesting because
					// of what it leaves behind: when the busy count drops from more than one
					// to exactly one, the survivor is a parent whose children have all gone
					// quiet, and it may be waiting for a result that is never coming.
					//
					// Re-arming is guarded: an already-armed watch keeps its start time, or a
					// stream of child idles would keep pushing the deadline out.
					const busyNow = busySessionsForOrphanWatch()
					if (busyBefore > 1 && busyNow.length === 1) {
						void armOrphanWatch(busyNow[0])
					}

					void inspectOnIdle(sid)
					// Independent of the idle heuristics above: this looks at tool parts
					// that already errored, which none of those read. Fire-and-forget
					// so it cannot delay them. The latch check lives inside the function
					// rather than here, because the per-request re-arm is derived from the
					// history and only happens once the history has been read.
					if (!w.completionSignaled && !w.userCancelled) {
						void checkForUnknownToolCalls(sid, w)
					}
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
				// v1.18.34 (verified live, 2026-10-01, on an arch LXC with the real
				// v1 plugin loaded): v1 has NO revert-named event. A revert arrives as
				// `session.updated` whose `properties.info.revert` is populated with
				// { messageID, partID?, snapshot?, diff? }, preceded by `session.diff`.
				// So on v1 a plugin that only switches on the event *name* never sees a
				// rewind at all — which is exactly why the v1 port never dropped its
				// watch state on one. (An earlier comment here claimed v1 emitted
				// `session.reverted`; that was wrong, and the case it defended is gone.)
				//
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
					{
						const m = ev.data?.model as { providerID?: string; provider?: string; modelID?: string; id?: string } | undefined
						const providerID = m?.providerID ?? m?.provider
						const modelID = m?.modelID ?? m?.id
						if (typeof providerID === "string" && typeof modelID === "string") {
							w.modelRef = { providerID, modelID }
							w.model = `${providerID}/${modelID}`
						} else if (m) {
							w.model = `${providerID ?? "?"}/${modelID ?? "?"}`
						} else {
							w.model = w.model
						}
					}
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
					w.pendingTools++
					// Any real tool work between completions legitimises the next
					// task_complete — reset the repeat-signal counter. task_complete
					// itself is excluded; it manages the counter inside its execute.
					//
					// Without this, a model that finishes, calls the tool, then does one
					// more piece of work and finishes again would be counted as a repeat,
					// and the escalation would fire against a legitimate second round.
					if (name !== "task_complete") w.taskCompleteSignals = 0
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
					w.pendingTools = Math.max(0, w.pendingTools - 1)
					touch(sid)
					return
				}
				case "session.tool.failed": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.lastWasTaskTool = false
					w.pendingTools = Math.max(0, w.pendingTools - 1)
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
					// Quota/rate-limit failures stand down on the gate ladder — an
					// immediate continue retries straight into the ban.
					if (isRateLimitError(errType, errMsg)) {
						handleRateLimitFailure(sid, w, errType, errMsg)
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
			`ready (opencode v2). timeout=${chunkTimeoutMs}ms interval=${checkIntervalMs}ms retries=${maxRetries} loop=${loopMaxContinues}/${loopWindowMs / 1000}s warmup=${warmupMs}ms stall=${busyStallStrategy} visibleContinue=${visibleContinue} probe=${configProbe ?? "-"} mod=${MODULE_INSTANCE}` +
				(gatedInUse.length > 0 ? ` accepted-but-inert=${gatedInUse.join(",")}` : ""),
		)

		// Cleanup: stop timers and the event pump; OpenCode awaits this on disable/reload/shutdown.
		const dispose = () => {
			running = false
			eventAbort.abort()
			clearInterval(watchdog)
			clearInterval(discoveryTimer)
			clearTimeout(initialDiscovery)
			// A pending pattern pass outlives the plugin otherwise, and would judge a
			// session against a history this build is no longer watching.
			for (const w of sessions.values()) {
				if (w.toolTextTimer) clearTimeout(w.toolTextTimer)
				w.toolTextTimer = null
				if (w.recoverTimer) clearTimeout(w.recoverTimer)
				w.recoverTimer = null
			}
			sessions.clear()
			// Only clear the registry slot if it is still OURS: a later setup may
			// already have superseded us, and unregistering it would strand a live
			// watchdog. The identity check matters across copies too, since they
			// share one registry.
			const reg = singletonRegistry()
			if (reg.live?.dispose === dispose) reg.live = undefined
			log("info", `stopped mod=${MODULE_INSTANCE}`)
		}
		registry.live = { dispose }
		return dispose
	},
})
