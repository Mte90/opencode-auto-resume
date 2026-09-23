# opencode-auto-resume

**Plugin for [OpenCode](https://github.com/anomalyco/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, stuck subagent parents, and more. Fully silent, zero UI pollution.**

> **OpenCode v2 is here (stable).** This repo ships both the v1 plugin
> (`src/index.ts`) and a complete v2 port (`src/v2/index.ts`) targeting the
> stable `@opencode/plugin` 2.0.5 API. Install it with the
> [v2 install guide](docs/v2/installing.md); see
> [docs/v2/migration.md](docs/v2/migration.md) for the full migration notes.

## What it does

LLM sessions fail in predictable ways. This plugin monitors all sessions and automatically recovers without user intervention. Each recovery path below references the upstream OpenCode issues that motivated it — these are problems not yet resolved in the official project.

---

### Stall recovery

The stream goes silent but the session stays "busy". The UI shows a blinking cursor with no progress. If no events arrive for 48 seconds (`chunkTimeoutMs` + `gracePeriodMs`), the plugin sends `"continue"` with exponential backoff. After 3 failed attempts it gives up.

The `busyStallStrategy` option controls this path: `"continue"` (default), `"abort"` (abort-first), or `"off"` — see [Recovery model](#recovery-model) for what a busy prompt can and cannot do while the runner is live.

The plugin extracts the **agent, model, and provider** from the last session message, so it resumes with the exact same configuration the user was using (build, sisyphus, prometheus, etc.).

_Motivated by:_
- [#34214](https://github.com/anomalyco/opencode/issues/34214) — Opencode freezes / becomes unresponsive mid-session
- [#35207](https://github.com/anomalyco/opencode/issues/35207) — Session hangs indefinitely after MCP tool-call — no timeout recovery (deadlock)
- [#31655](https://github.com/anomalyco/opencode/issues/31655) — Window completely frozen/unresponsive after reopening a project with a stalled session
- [#34460](https://github.com/anomalyco/opencode/issues/34460) — Thread freezes after switching to Go model — requires Escape key to unstick

---

### Tool calls as raw text

The model prints tool invocations as raw XML/JSON (`<function=edit>...`, `{"type":"function",...}`) instead of executing them. The session goes idle normally but the tool was never run. On idle, the plugin fetches the last messages and scans for XML tool-call patterns — including truncated and alternative formats. If found, it sends `TOOL_TEXT_RECOVERY_PROMPT` to force a clean tool call.

Also detects tool calls trapped inside **thinking/reasoning** parts and emits `THINKING_TOOL_RECOVERY_PROMPT` to extract them.

_Motivated by:_
- [#31247](https://github.com/anomalyco/opencode/issues/31247) — Copilot Claude Opus 4.8 emits pseudo tool-call text instead of structured tool calls
- [#34126](https://github.com/anomalyco/opencode/issues/34126) — OpenAI Chat parser treats standalone text before tool_calls as assistant text
- [#33959](https://github.com/anomalyco/opencode/issues/33959) — OpenCode Desktop does not execute valid OpenAI tool calls from qwen3-coder:30b (Ollama)
- [#35689](https://github.com/anomalyco/opencode/issues/35689) — DeepSeek silently stops executing (interleaved reasoning_content dropped in tool call messages)

---

### Hallucination loop

The model generates the same broken output repeatedly. Each `continue` just picks up the broken generation. If a session needs 3+ continues within 10 minutes, the plugin aborts the request and sends `"continue"` fresh, forcing a clean restart.

A separate **tool-call loop detector** catches the model calling the same tool 3+ consecutive times (or repeating patterns of length 2-5 occurring at least three times). When detected, it emits `TOOL_LOOP_RECOVERY_PROMPT` (at most twice per busy turn) to break the loop instead of blindly continuing.

Loop detection runs in two places. At idle, tool names are scanned from recent assistant messages. **Live**, every `tool.execute.before` hook fingerprints the call as `tool name + arguments` — so a subagent stuck re-reading the same file/range (even alternating between two near-identical argument sets, which never produces 3 consecutive identical calls) is caught after 6+ calls in the repeating cycle. On live detection the plugin aborts the running turn immediately (this is the sanctioned exception to the never-abort-busy rule: 6+ identical name+args fingerprints prove a hallucinated loop, and the current call has not started yet) and then sends `TOOL_LOOP_RECOVERY_PROMPT`. Esc-cancelled sessions are never touched.

---

### Unknown tool suggestion

When the model calls a tool that does not exist (a typo, a hallucinated name, or a tool from a different plugin that isn't loaded), OpenCode returns a `tool` part with `state.status = "error"`. If the same wrong tool name appears **2 times** in the session's message history, the plugin:

1. Fetches the list of available tools via `ctx.client.tool.ids()` (cached for 5 minutes).
2. Computes the closest match by Levenshtein distance (case-insensitive, threshold = half the wrong name's length).
3. Sends a continue prompt that names the wrong tool, states it does not exist, suggests the closest match (if one was found), and lists the first 20 available tools for reference.

The suggestion fires once per busy cycle. A new user message resets the counter so the suggestion can fire again on a fresh cycle. Tool parts that already succeeded (`state.status = "completed"`) and parts for tools that do exist are skipped.

Threshold and cache are compile-time constants (`UNKNOWN_TOOL_THRESHOLD = 2`, `TOOL_IDS_CACHE_MS = 5 min`). The detection runs at idle, alongside the tool-text recovery check.

_Motivated by:_
- [#22142](https://github.com/anomalyco/opencode/issues/22142) — Repetitive tool-call loops with alibaba-coding-plan-cn/qwen3.6-plus
- [#16218](https://github.com/anomalyco/opencode/issues/16218) — Model repeats the same response in a loop after generating an answer
- [#33216](https://github.com/anomalyco/opencode/issues/33216) — OpenCode Repeatedly Ignores Instructions and Loops Responses
- [#35784](https://github.com/anomalyco/opencode/issues/35784) — opencode-go/glm-5.2 + read file loop
- [#25129](https://github.com/anomalyco/opencode/issues/25129) — Thinking mode gets stuck in infinite repetition loop

---

### Orphan parent

A subagent finishes but the parent session stays stuck as "busy" forever. The plugin detects when `busyCount` drops from >1 to 1, waits `subagentWaitMs` + `gracePeriodMs` (18s default), probes the subagent (recovering a crashed child first if possible), then aborts and resumes the parent.

_Motivated by:_
- [#35066](https://github.com/anomalyco/opencode/issues/35066) — notify parent when subagent sessions finish
- [#33050](https://github.com/anomalyco/opencode/issues/33050) — orphaned sessions continue looping after abort, causing sustained high CPU
- [#32335](https://github.com/anomalyco/opencode/issues/32335) — opencode run processes don't exit after completing scheduled work, causing memory leak

---

### Subagent stuck detection

Detects when a subagent hasn't received new text for >1 minute (or >3 minutes if a tool call is in progress). If stuck, sends a recovery prompt to the subagent before triggering abort+resume on the parent. This avoids killing a parent that merely has a slow child.

_Motivated by:_
- [#35073](https://github.com/anomalyco/opencode/issues/35073) — subagent permission asks hang indefinitely (sync subagents treated as interactive)
- [#35806](https://github.com/anomalyco/opencode/issues/35806) — malformed tool-input stream ordering crashes Session drains
- [#32580](https://github.com/anomalyco/opencode/issues/32580) — Agent showing repeated thinking

---

### Streaming failure recovery

The AI provider's streaming response can fail mid-stream (connection reset, timeout, socket close). When the provider reports an error whose **name** matches `streamingFailureErrorNames` (exact, case-sensitive) or whose **message** matches `streamingFailureMessagePatterns` (regex, case-insensitive), the plugin arms a deferred recovery instead of relying only on the generic stall timeout. Invalid regex patterns fall back to substring matching.

**Default error names:**
- `ProviderError`, `APIError`, `StreamError`, `ConnectionError`, `TimeoutError`

**Default message patterns:**
- `streaming response failed`, `stream.*fail`, `connection.*reset`, `connection.*closed`

#### Recovery behavior

1. **Detection**: `session.error` is classified via `isStreamingFailure()` against the configured error names and message patterns
2. **State transition**: the session's `pendingRecovery` flag is armed with the error name (`pendingRecoveryReason`) and timestamp (`pendingRecoveryAt`)
3. **Recovery attempt**: once the session is idle and the backoff delay has elapsed, the timer loop sends a recovery prompt
4. **Watchdog**: if the session is still not busy `toolTextCheckDelayMs` (3s default) after the prompt, the recovery is retried (up to `maxRecoveryRetries`) with exponential backoff
5. **Escalation**: when retries are exhausted, the plugin aborts the session and resumes it (`abort+resume`); `gaveUp` is set if that also fails

#### Configuration

Add to your plugin options (in `opencode.jsonc`):

```json
{
  "streamingFailureErrorNames": ["ProviderError", "APIError", "StreamError", "ConnectionError", "TimeoutError"],
  "streamingFailureMessagePatterns": ["streaming response failed", "stream.*fail", "connection.*reset", "connection.*closed"],
  "maxRecoveryRetries": 2,
  "baseBackoffMs": 1000,
  "maxBackoffMs": 8000
}
```

#### State machine addition

New per-session recovery fields added to the state machine:
- `pendingRecovery` — failure detected, recovery armed
- `pendingRecoveryReason` — error name that triggered the recovery
- `pendingRecoveryAt` — detection timestamp (backoff anchor)
- `recoveryAttempts` — recovery attempt counter
- `watchdogRetryGuard` — watchdog retry in progress (keeps the recovery armed)

Recovery chain: `pendingRecovery` → recovery attempt → `recoveryAttempts` retry → `abort+resume` → `gaveUp`.

See [Recovery Flow Documentation](docs/architecture/recovery-flow.md) for the full state machine.

#### Example scenario

```
1. AI provider starts streaming response
2. Network interruption causes "connection reset" error mid-stream
3. System detects "ConnectionError" matches streamingFailureErrorNames
4. Session's pendingRecovery flag is armed (reason=ConnectionError)
5. Session goes idle; timer loop waits until the backoff delay has elapsed
6. Recovery prompt sent (recoveryAttempts=1)
7. Success → session busy → recovery flags cleared
   Still not busy after `toolTextCheckDelayMs` (3s default) → watchdog retry (attempt 2/2)
   Still not busy → maxRecoveryRetries reached → abort + resume
   Abort+continue fails → gaveUp
```

#### Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `streamingFailureErrorNames` | `string[]` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Error names that indicate a streaming failure (exact, case-sensitive) |
| `streamingFailureMessagePatterns` | `string[]` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Regex patterns matching streaming failure messages (case-insensitive) |
| `maxRecoveryRetries` | `number` | `2` | Maximum streaming-failure recovery attempts before abort+resume escalation |
| `baseBackoffMs` | `number` | `1000` | Initial backoff delay in milliseconds |
| `maxBackoffMs` | `number` | `8000` | Maximum backoff delay cap in milliseconds |

_Motivated by:_
- [EPIC: Streaming Failure Recovery](docs/EPIC-Streaming-Recovery-OpenCode-Auto-Resume-v3.md) — recovery requests not consistently creating new assistant executions after mid-stream failures

---

### Silent dead-stream recovery

The model stream can die after emitting only reasoning — no text part, no tool call — finalizing with `finish: "unknown"`. OpenCode treats the message as completed and the session goes idle, so no error or stall path triggers. On idle, if the **newest** assistant message has a finish reason, zero text parts, and at least `silentDeadStreamMinTokens` output tokens, the plugin sends a recovery prompt. Only the newest assistant message is evaluated — a delivered text answer means normal completion, and older tool-call steps are never misread as dead streams. Recovery is also skipped if the session has gone busy/retry again before the prompt is sent (race guard).

### Context saturation → magic-context wrapup

A session can fill its usable context window without stalling — it just keeps working until it chokes. The plugin tracks token usage from `message.updated` events and computes the ratio against the model's usable window (`context − min(20k, maxOutput)`, mirroring OpenCode's own overflow math). On idle, when the ratio crosses `contextSaturationThreshold` (default 0.85), routing depends on session kind. For parent sessions, only when magic-context is detected in the host's configured plugin list (`config.get().plugin`), the plugin invokes the registered `ctx-wrapup` command through `client.session.command()` — it does not send `/ctx-wrapup` as prompt text, because prompt text is not expanded into a command. For subagent sessions identified by `parentID` on `session.created`, the default is no intervention: magic-context does run bounded cleanup for subagents (structural-noise/cleared-reasoning strips, heuristic drops, ceiling nudges), but its hard protections — historian compartments, emergency fail-closed abort, caveman compression — skip subagents, and on true overflow the error just propagates to the parent with no deterministic reclaim. Terminal reclamation therefore depends on the agent calling `ctx_reduce` when nudged. If `subagentNativeCompactionEnabled` is `true`, the plugin calls native `session.summarize()` as an opt-in safety net. Fail-safe: provider lookup errors, unknown model limits, user cancellation, or completion signals mean no intervention. Magic-context absence additionally disables only the parent path (the `ctx-wrapup` command would not be registered); the opt-in subagent path needs no magic-context detection because `session.summarize()` is native. This path is magic-context-gated on purpose: magic-context's setup disables OpenCode's native compaction, so unconditionally summarizing a magic-context-managed parent would double-compress and fight its cache-aware historian. One intervention per busy cycle.

---

### Active-tool safety guard

Before **any** abort, two guards run in order: the primary deterministic in-flight counter maintained by the `tool.execute.before`/`tool.execute.after` hooks (`hasInflightTools()`), then a polled `checkSessionHasActiveTool()` fallback for sessions discovered without hooks. If a tool is running, the abort is skipped. This prevents the plugin from killing a long-running build, test suite, or command — even when it looks like a stall.

_Motivated by:_
- [#26063](https://github.com/anomalyco/opencode/issues/26063) — Tool execution aborted/terminated
- [#31459](https://github.com/anomalyco/opencode/issues/31459) — "Tool execution aborted" during Preparing write
- [#5937](https://github.com/Mte90/opencode-auto-resume) — (internal) must never abort a tool execution

---

### Model, agent & provider preservation

When resuming with `"continue"`, the plugin extracts agent, model, and provider from the last session message — falling back to `msg.info.agent` / `msg.info.model` if the top-level field is missing. This preserves the user's UI selection across resumes instead of reverting to the default agent.

_Motivated by:_
- [#35126](https://github.com/anomalyco/opencode/issues/35126) — Subagents launched via task tool ignore their model: frontmatter and inherit parent agent's model
- [#35899](https://github.com/anomalyco/opencode/issues/35899) — Web: switching sessions overwrites user-selected model with agent default
- [#34562](https://github.com/anomalyco/opencode/issues/34562) — Model provider not restored correctly when switching projects

---

### ESC cancel respected

User presses ESC to cancel a request. The plugin detects `MessageAbortedError` and marks sessions as cancelled — regardless of their tracked status, so a late status flip to idle before the error cannot miss the latch — and never resumes them. Aborts initiated by the plugin itself (`pluginAbortInFlight`) are excluded, so recovery aborts are not mistaken for ESC. The grace period (`gracePeriodMs`) also lets late ESC/status events arrive before any action.

The back-off lifts as soon as the user sends a new prompt in that session (`chat.message` hook): a fresh user message starts a new round of work, so auto-resume re-arms. The plugin's own recovery prompts do not re-arm it. The same applies to the `task_complete` latch.

_Motivated by:_
- [#28453](https://github.com/anomalyco/opencode/issues/28453) — ACP session/cancel emits agent_error for MessageAbortedError before cancelled result
- [#32432](https://github.com/anomalyco/opencode/issues/32432) — Cancelled subagents can't be opened in TUI + Ctrl+X intermittently fails
- [#30144](https://github.com/anomalyco/opencode/issues/30144) — Early prompt cancel can poison directory instance

---

### Explicit completion via `task_complete`

The agent can call the built-in `task_complete` tool to signal that all work is done. When invoked, the plugin stops sending any further `"continue"` prompts, clears all pending timers, and marks the session as complete. This replaces fragile text-based heuristics (emoji patterns, language detection) with a deterministic signal.

If `task_complete` is called while open todos remain, the call is rejected (up to `maxRetries` times) with a message asking the agent to finish the remaining work first.

Repeat calls with no new user message in between are guarded: the first acknowledgement carries an explicit stop instruction, the second returns a repeat warning, and the third and subsequent calls are rejected as errors. This breaks the ack self-loop where the acknowledgement tool-result is fed back into the turn and a stuck model re-emits `task_complete` instead of ending with text. The counter resets on a genuine user message, on the block path above, or when any other tool runs in between.

---

### 🎉 emoji completion

An assistant message ending with 🎉 resets the tool-text timer and prevents a trigger — the emoji signals the agent considers the task complete.

---

### Ready-to-continue auto-resume

When the assistant prints phrases like "Ready to continue with task" or "Proceeding with task", the plugin automatically sends `"continue"` without waiting for the user. This catches the common pattern where the model stops to ask for permission it doesn't need.

---

### Action-intent nudge

When the assistant ends a line with `:` ("Next, I will edit the file:") — announcing intent without acting — the plugin sends `actionIntentPrompt` after a short delay, nudging the model to execute. Disable with `resumeOnActionIntent: false`. Detection is skipped while a session is younger than `warmupMs`.

---

### Done-claim verification

If the assistant claims the task is done ("task done", "finished", "all complete") but open todos remain, the plugin sends `DONE_WITHOUT_WORK_PROMPT` asking the agent to verify and finish remaining work. If it claims done with **no** open todos and the response carries no work description, the plugin sends `DONE_WITHOUT_DETAILS_PROMPT` — an imperative prompt demanding a concrete report (files changed, commands run, results). A response that already contains file paths, verification output, or result sections satisfies the demand on its own and never triggers the prompt. The budget is capped at `maxRetries` across busy cycles (going busy no longer re-arms it); only a genuinely new inbound user message re-arms it. Both use the real `todo.updated` event state — not regex on the message text.

---

### User-input awareness

The session is not stalled while the ball is in the user's court. Two gates stand down idle nudges:

- **Awaiting input**: the newest assistant message holds a `tool_use` part with `state.status: "pending"` (e.g. an open `question` tool call). All idle checks, the periodic recheck, delayed action-intent callbacks, and the tool-text scan skip prompting until a newer user message clears the gate. Completed tool calls never engage it.
- **Recently active user**: any inbound user message within `activeUserWindowMs` (default 15 minutes) means the user is engaged — likely composing a reply, which leaves no pending tool call behind. Open-todos nudges (idle + periodic), the tool-text reminder fallback, and action-intent callbacks stand down until the window expires.

---

### False-positive protection during subagent work

Long tool execution or active subagents can look like a stall. Only the session emitting events gets its timer reset (not all sessions). When multiple sessions are busy, stall detection is paused entirely. The plugin also clears existing timers before creating a new `setTimeout` in idle handlers to prevent queued continue triggers.

---

### Spurious error suppression

After normal completion, OpenCode sometimes fires a `session.error`. All logging goes through `ctx.client.app.log()` (zero `console.log`), and errors on already-idle sessions are silently ignored.

_Motivated by:_
- [#33687](https://github.com/anomalyco/opencode/issues/33687) — Interrupted assistant messages retain non-error finish value (orphan tool-input-start abort)
- [#28958](https://github.com/anomalyco/opencode/issues/28958) — Plugin hook rejection aborts unrelated parallel sessions
- [#25899](https://github.com/anomalyco/opencode/issues/25899) — ACP prompt() returns stopReason: end_turn + zero usage on user cancel

---

### Session discovery & cleanup

Periodically calls `session.list()` (every 60s) to pick up sessions that were missed by event tracking. Idle sessions are cleaned up after 10 minutes or when the idle map exceeds 50 entries, preventing memory leaks.

_Motivated by:_
- [#35750](https://github.com/anomalyco/opencode/issues/35750) — Upgrade to 1.17.x hides pre-existing sessions — new path column not back-filled during migration
- [#33102](https://github.com/anomalyco/opencode/issues/33102) — OpenCode Go workspace subscription is orphaned/hidden and cannot be managed from dashboard
- [#27759](https://github.com/anomalyco/opencode/issues/27759) — Session heartbeat for multi-session liveness detection

---

## Recovery model

All recovery paths fall into three families. Which family fires determines what the prompt can actually do.

### 1. Idle-boundary nudges (safe)

Fire only after OpenCode reports the session **idle** — the runner has exited. The prompt starts a new run.

Paths: todo nudges, tool-call-as-text recovery, thinking-tool recovery, action-intent nudge, ready-to-continue, done-claim verification, streaming-failure recovery, silent dead-stream recovery, context-saturation routing (magic-context-gated; parent sessions use `session.command`, subagents use opt-in native `session.summarize`).

### 2. Busy-silence continue (stream stall)

Fires when the session still reports **busy** but no events arrived for `chunkTimeoutMs` + `gracePeriodMs`. Controlled by `busyStallStrategy`:

- `"continue"` (default) — sends a prompt while busy. This only helps when the busy status is **stale** (the runner already exited but the status was never updated); the prompt then starts a new run.
- `"abort"` — aborts first (`session.abort()`), then sends the prompt. Required to unblock a runner that is genuinely stuck (hung provider stream). Subject to the same active-tool guards as every abort: never fires while a tool is in-flight.
- `"off"` — disables busy-silence recovery entirely; stalls are then handled only by idle-boundary recovery (if the session ever goes idle) or manually.

**Why `"continue"` cannot unblock a live runner:** in OpenCode ≥ 1.18, `session.prompt()` while the runner is `Running` joins the existing run — the message is admitted to the session inbox and promoted at the next provider-turn boundary. A hung stream never reaches that boundary, so the parked message cannot unblock it; if the run later exits, the message may surface as an unwanted extra turn (token cost, race risk). True transport stalls need abort-first.

### 3. Abort-first recovery

Aborts the active run, then continues. The only family that can unblock a live runner.

Paths: orphan parent, subagent stuck (parent side), hallucination loop, streaming-failure escalation. All aborts pass the active-tool guards first, and plugin-initiated aborts are marked so they are not mistaken for user ESC (`session.error` → `MessageAbortedError` race).

## Architecture

```
Any SSE Event
  ├─ has sessionID? → touchSession(sid) — reset only that session's timer
  └─ no sessionID → ignore

session.status events:
  ├─ busy → reset timer, clear retry counters
  ├─ retry → touch session
  ├─ interrupted → user cancel: back off until the next user message
  └─ idle → schedule tool-text check (3s delay)
              └─ fetch messages → scan for XML / thinking-tool patterns
                  ├─ found → send recovery prompt (with backoff)
                  └─ not found → check ready-to-continue / done-claim patterns
              └─ orphan check: busyCount dropped from >1 to 1?
                  └─ subagentWaitMs watch → abort + continue

todo.updated events:
  └─ track real todo state (not regex on message text)
     └─ if missing (no event received): idle path + task_complete
        fetch on-demand via session.todo() API so the
        open-todos reminder and the 🎉 completion latch see
        real state, not a stale empty array.

Timer loop (every 5s):
  for each busy session:
    ├─ orphan watch active? → wait or abort+continue
    ├─ busyCount > 1? → skip (subagent running)
    ├─ active tool running? → skip (never abort tools)
    └─ idle > 48s? → busyStallStrategy:
         off → skip · abort → abort+continue
         else → hallucination loop? abort : continue with backoff

Periodic (every 60s): session.list() to discover missed sessions
Periodic: cleanup idle sessions older than 10min or >50 entries
```

Events consumed: `session.status`, `session.created`, `session.updated`, `session.idle`, `session.interrupted`, `session.error`, `todo.updated`, `command.executed`; hooks: `chat.message`, `tool.execute.before`/`after`, `command.execute.before`.

## Installation

### Opencode

Add to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-auto-resume"]
}
```

With options:

```jsonc
{
  "plugin": [
    ["opencode-auto-resume", {
      "chunkTimeoutMs": 45000,
      "gracePeriodMs": 3000,
      "maxRetries": 3
    }]
  ]
}
```

## Configuration

```json
{
  "plugin": [
    [
      "file:///home/YOURUSER/.config/opencode/plugins/opencode-auto-resume/dist/index.js",
      { "chunkTimeoutMs": 45000, "maxRetries": 3 }
    ]
  ]
}
```

### OpenCode v2 (stable)

The v2 plugin uses the `Plugin.define` API with `ctx.event.subscribe()` (AsyncIterable) instead of the v1 hooks-object pattern, and targets the stable **`@opencode/plugin` 2.0.5** API (opencode v2.0.5+). Add to your `opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/auto-resume-v2.ts",
      "options": {
        "chunkTimeoutMs": 45000,
        "maxRetries": 3
      }
    }
  ]
}
```

Or place `src/v2/index.ts` directly in `~/.config/opencode/plugins/` for auto-discovery (no config entry needed).

Disable via `"-auto-resume.v2"` in `plugins`.

- **Step-by-step install guide:** [docs/v2/installing.md](docs/v2/installing.md)
- **Migration notes (v1 → v2, stable validation):** [docs/v2/migration.md](docs/v2/migration.md)

### Configurable options

| Option | Default | Description |
|---|---|---|
| `chunkTimeoutMs` | `45000` | Inactivity timeout before considering stream stalled |
| `gracePeriodMs` | `3000` | Extra wait before acting (lets ESC/status events arrive) |
| `checkIntervalMs` | `5000` | Timer poll interval |
| `maxRetries` | `3` | Max auto-resume attempts before giving up |
| `baseBackoffMs` | `1000` | First retry delay (doubles each attempt) |
| `maxBackoffMs` | `8000` | Backoff cap |
| `subagentWaitMs` | `15000` | Wait before treating orphan parent as stuck |
| `loopMaxContinues` | `3` | Continues in window before triggering abort |
| `loopWindowMs` | `600000` | Hallucination loop detection window (10 min) |
| `streamingFailureErrorNames` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Error names that classify as streaming failures (exact match) |
| `streamingFailureMessagePatterns` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Regex patterns (case-insensitive) in error messages indicating streaming failure |
| `maxRecoveryRetries` | `2` | Max streaming-failure recovery attempts before abort+resume escalation |
| `toolTextCheckDelayMs` | `3000` | Delay before scanning an idle session for tool-as-text; also the recovery watchdog delay |
| `minActivityGapMs` | `1000` | Skip recovery if the session was active within this gap |
| `warmupMs` | `15000` | Action-intent detection disabled while a session is younger than this |
| `debug` | `false` | Enable `[debug]` console diagnostics |
| `resumeOnActionIntent` | `true` | Enable action-intent (`:`-terminated line) nudges |
| `continuePrompt` | `"continue"` | Prompt text for stall/streaming/dead-stream recovery |
| `actionIntentPrompt` | same as `continuePrompt` | Prompt sent on action-intent detection |
| `toolTextRecoveryPrompt` | `TOOL_TEXT_RECOVERY_PROMPT` | Override the tool-call-as-text recovery prompt |
| `thinkingToolRecoveryPrompt` | `THINKING_TOOL_RECOVERY_PROMPT` | Override the thinking-tool recovery prompt |
| `doneWithoutWorkPrompt` | `DONE_WITHOUT_WORK_PROMPT` | Override the done-claim-with-open-todos prompt |
| `doneWithoutDetailsPrompt` | `DONE_WITHOUT_DETAILS_PROMPT` | Override the done-claim-with-no-todos report prompt |
| `silentDeadStreamMinTokens` | `200` | Min output tokens to treat a textless `finish:"unknown"` message as a dead stream |
| `busyStallStrategy` | `"continue"` | Busy-stall response: `"continue"`, `"abort"` (abort-first), or `"off"` (disabled) |
| `contextSaturationThreshold` | `0.85` | Ratio of used/usable context that routes a saturated parent to magic-context `ctx-wrapup` (only when magic-context is installed) |
| `activeUserWindowMs` | `900000` | Inbound-user-message recency window (15 min) during which idle nudges stand down (user likely composing) |
| `subagentNativeCompactionEnabled` | `false` | Opt-in native `session.summarize()` for saturated subagent sessions (no magic-context detection required) |

Message patterns are matched case-insensitively. Error names use exact match.

### Internal constants (not configurable)

| Constant | Value | Description |
|---|---|---|
| `ABORT_CONTINUE_DELAY_MS` | `2000` | Delay between abort and continue |
| `MAX_IDLE_SESSIONS` | `50` | Idle session map cap before cleanup |
| `IDLE_CLEANUP_MS` | `600000` | Idle session age before cleanup (10 min) |
| `SESSION_DISCOVERY_INTERVAL_MS` | `60000` | `session.list()` poll interval (60s) |

## Verification

To verify the plugin is loaded, run `/status` inside OpenCode — it lists all loaded plugins and their versions. You should see `opencode-auto-resume` in the list.

The plugin handles all recovery automatically — no manual intervention needed.

## Troubleshooting

| Problem | Solution |
|---|---|
| Resumes after ESC | Increase `gracePeriodMs` to `5000` |
| Too aggressive | Increase `chunkTimeoutMs` to `60000` |
| Too slow to react | Decrease `checkIntervalMs` to `2000` |
| Orphan parent not detected | Increase `subagentWaitMs` to `20000` |
| Hallucination loop not caught | Decrease `loopMaxContinues` to `2` |
| Tool-text not detected | Check server logs — requires SDK message fetching |
| Long-running tool killed | Should not happen — active-tool guard prevents it. Report a bug. |
| `Unexpected server error` on startup | Update to v1.1.8+. Caused by non-Plugin exports being treated as plugin entrypoints by OpenCode's loader. Clear the plugin cache (`~/.cache/opencode/packages/opencode-auto-resume@*`) and restart. |
