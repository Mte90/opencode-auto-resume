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

import { Plugin } from "@opencode/plugin"

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
	recovering: boolean

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
	waitingOnSubagent: boolean
	lastWasTaskTool: boolean
	idleSince: number | null

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
	maxRecoveryRetries?: number
	continuePrompt?: string
	toolTextRecoveryPrompt?: string
	doneWithoutWorkPrompt?: string
	actionIntentPrompt?: string
	debug?: boolean
}

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_TIMEOUT_MS = 45_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000
const DEFAULT_GRACE_PERIOD_MS = 3_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 8_000
const DEFAULT_LOOP_MAX_CONTINUES = 3
const DEFAULT_LOOP_WINDOW_MS = 10 * 60_000
const DEFAULT_MAX_RECOVERY_RETRIES = 2
const DEFAULT_DEBUG = false

const MAX_IDLE_SESSIONS = 50
const IDLE_CLEANUP_MS = 10 * 60_000
const TEXT_BUFFER_TRIM_LEN = 20_000

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

function containsReadyToContinuePattern(text: string): boolean {
	const lines = text.split("\n")
	const lastLines = lines.slice(-3).join("\n")
	return READY_TO_CONTINUE_PATTERNS.some((pat) => pat.test(lastLines))
}

function containsDoneClaimPattern(text: string): boolean {
	const lines = text.split("\n")
	const lastLines = lines.slice(-5).join("\n")
	return DONE_CLAIM_PATTERNS.some((pat) => pat.test(lastLines))
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

function backoffMs(attempt: number, base: number, max: number): number {
	return Math.min(base * Math.pow(2, attempt - 1), max)
}

function isStreamingFailure(message: string): boolean {
	const lower = message.toLowerCase()
	if (!lower) return false
	return STREAMING_FAILURE_MESSAGE_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern, "i").test(lower)
		} catch {
			return lower.includes(pattern.toLowerCase())
		}
	})
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

export default Plugin.define({
	id: "auto-resume.v2",

	setup: async (ctx) => {
		const opts = (ctx.options ?? {}) as AutoResumeOptions

		const chunkTimeoutMs = opts.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
		const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
		const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
		const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
		const baseBackoff = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
		const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
		const loopMaxContinues = opts.loopMaxContinues ?? DEFAULT_LOOP_MAX_CONTINUES
		const loopWindowMs = opts.loopWindowMs ?? DEFAULT_LOOP_WINDOW_MS
		const maxRecoveryRetries = opts.maxRecoveryRetries ?? DEFAULT_MAX_RECOVERY_RETRIES
		const debug = opts.debug ?? DEFAULT_DEBUG

		const dbg = (...args: unknown[]) => {
			if (debug) console.log("[auto-resume:debug]", ...args)
		}

		function log(level: "info" | "warn" | "error", msg: string) {
			const line = `[auto-resume] ${msg}`
			if (level === "error") console.error(line)
			else if (level === "warn") console.warn(line)
			else console.log(line)
		}

		// ---------------------------------------------------------------------
		// State
		// ---------------------------------------------------------------------

		const sessions = new Map<string, SessionWatch>()

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
					recovering: false,
					textParts: new Map(),
					lastAssistantText: "",
					lastAssistantMessageID: null,
					toolTextAttempts: 0,
					continueTimestamps: [],
					doneClaimAttempts: 0,
					intentNudgeAttempts: 0,
					pendingRecoveryArmed: false,
					permissionPending: false,
					waitingOnSubagent: false,
					lastWasTaskTool: false,
					idleSince: null,
					recentToolCalls: [],
				}
				sessions.set(sid, w)
			}
			return w
		}

		function touch(sid: string) {
			const w = ensureWatch(sid)
			w.lastActivityAt = Date.now()
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
				w.waitingOnSubagent = false
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
			w.permissionPending = false
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
			for (const sid of toDelete) sessions.delete(sid)
			if (toDelete.length > 0) dbg(`cleaned ${toDelete.length} idle sessions, total=${sessions.size}`)
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
			if (w.aborting) return false
			w.aborting = true
			log("warn", `${short(sid)} escalating: interrupt + fresh continue`)
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
			const ok = await notifyAndPrompt(sid, opts.continuePrompt ?? CONTINUE_PROMPT, "abort+resume escalation")
			if (ok) {
				recordContinue(sid)
				w.lastRetryAt = Date.now()
				log("info", `${short(sid)} resumed after abort`)
			}
			return ok
		}

		/**
		 * Core recovery ladder for a stuck/failed session.
		 * plain continue with backoff -> more attempts -> abort+resume escalation.
		 */
		async function recover(sid: string, reason: string) {
			const w = ensureWatch(sid)
			if (w.recovering || w.aborting || w.gaveUp || w.userCancelled || w.permissionPending) return
			// Record intent first, then evaluate the loop guard, so the Nth
			// continue within the window is the one that escalates.
			recordContinue(sid)
			if (continuesInWindow(w) >= loopMaxContinues) {
				log("warn", `${short(sid)} hallucination loop (${loopMaxContinues} continues/${loopWindowMs / 1000}s) — abort+resume`)
				await tryAbortAndResume(sid, w)
				w.continueTimestamps = []
				return
			}
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
					const ok = await notifyAndPrompt(sid, opts.continuePrompt ?? CONTINUE_PROMPT, "stalled — retrying")
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
			recordContinue(sid)
			if (continuesInWindow(w) >= loopMaxContinues) {
				log("warn", `${short(sid)} loop guard before ${kind} nudge — abort+resume`)
				await tryAbortAndResume(sid, w)
				w.continueTimestamps = []
				return
			}
			if (w[budgetKey] >= maxRetries) {
				dbg(`${short(sid)} ${kind} budget exhausted`)
				return
			}
			w[budgetKey]++
			log("info", `${short(sid)} ${kind} detected — sending targeted prompt (${w[budgetKey]}/${maxRetries})`)
			w.recovering = true
			const ok = await notifyAndPrompt(sid, prompt, "recovering: " + kind)
			w.recovering = false
			if (ok) {
				recordContinue(sid)
				touch(sid)
				markBusy(sid)
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

		async function inspectOnIdle(sid: string) {
			const w = ensureWatch(sid)
			// Prefer the live delta buffer; fall back to the authoritative message
			// history when it is empty (e.g. the plugin loaded mid-turn) or stale.
			let text = w.lastAssistantText
			if (!text) text = await lastAssistantTextFromContext(sid)
			if (!text) return

			if (containsToolCallAsText(text)) {
				await targetedRecovery(sid, "tool-call-as-text", opts.toolTextRecoveryPrompt ?? TOOL_TEXT_RECOVERY_PROMPT, "toolTextAttempts")
				return
			}
			if (containsReadyToContinuePattern(text)) {
				await targetedRecovery(sid, "ready-to-continue", opts.continuePrompt ?? CONTINUE_PROMPT, "intentNudgeAttempts")
				return
			}
			if (containsActionIntent(text)) {
				await targetedRecovery(sid, "action-intent", opts.actionIntentPrompt ?? opts.continuePrompt ?? CONTINUE_PROMPT, "intentNudgeAttempts")
				return
			}
			if (containsDoneClaimPattern(text) && w.doneClaimAttempts < 1) {
				// Single verification nudge for suspiciously terse completions
				const trimmed = text.trim()
				if (trimmed.length < 400) {
					await targetedRecovery(sid, "done-claim-no-details", opts.doneWithoutWorkPrompt ?? DONE_WITHOUT_WORK_PROMPT, "doneClaimAttempts")
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
		async function getActiveSessions(): Promise<string[]> {
			try {
				const fn = (ctx.session as any).active
				if (typeof fn !== "function") return []
				const active = await fn.call(ctx.session)
				return Object.keys(active ?? {}).filter((k) => typeof k === "string")
			} catch {
				return []
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
				const silence = now - w.lastActivityAt
				if (silence < chunkTimeoutMs + gracePeriodMs) continue
				if (w.permissionPending) {
					dbg(`${short(sid)} silent but permission pending — skipping`)
					continue
				}
				if (w.waitingOnSubagent) {
					dbg(`${short(sid)} silent but waiting on subagent — skipping`)
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
				await recover(sid, `no activity for ${Math.ceil(silence / 1000)}s`)
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
					markBusy(sid)
					return
				}
				case "session.execution.succeeded":
				case "session.idle": {
					const sid = sidOf(ev)
					if (!sid) return
					markIdle(sid)
					ensureWatch(sid).pendingRecoveryArmed = false
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
					w.userCancelled = !w.aborting && (reason === undefined || reason === "user")
					w.recovering = false
					markIdle(sid)
					return
				}
				case "session.deleted": {
					const sid = sidOf(ev)
					if (!sid) return
					sessions.delete(sid)
					return
				}
				// v1 legacy: not emitted in v2 (reverts now surface as
				// `session.revert.cleared` / `session.revert.committed`). Kept
				// defensively so older runtimes still drop their watch state.
				case "session.reverted": {
					const sid = sidOf(ev)
					if (!sid) return
					sessions.delete(sid)
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
					ensureWatch(sid).permissionPending = true
					return
				}
				case "permission.replied": {
					const sid = sidOf(ev)
					if (!sid) return
					const w = ensureWatch(sid)
					w.permissionPending = false
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
					log("info", `${short(sid)} provider retry #${ev.data?.attempt ?? "?"}: ${errType || errMsg}`)
					if (!isStreamingFailure(errMsg) && errType !== "retryable") return
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
					markIdle(sid)
					w.pendingRecoveryArmed = true // our delayed recovery must survive this idle transition
					if (errMsg.includes("interrupted by user") || errType.includes("cancel")) {
						dbg(`${short(sid)} failure was user-initiated — not recovering`)
						w.pendingRecoveryArmed = false
						return
					}
					log("warn", `${short(sid)} ${ev.type}: ${errType || "error"} ${errMsg.slice(0, 160)}`)
					void recover(sid, `${ev.type}${isStreamingFailure(errMsg) ? " (streaming)" : ""}`)
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
			`ready (opencode v2). timeout=${chunkTimeoutMs}ms interval=${checkIntervalMs}ms retries=${maxRetries} loop=${loopMaxContinues}/${loopWindowMs / 1000}s`,
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
