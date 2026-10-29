# opencode-auto-resume

**Plugin for [OpenCode](https://github.com/anomalyco/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, stuck subagent parents, and more. Fully silent, zero UI pollution.**

Supports **both OpenCode v1 and v2**.

## Installation

### opencode 1.x

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
      "chunkTimeoutMs": 180000,
      "gracePeriodMs": 3000,
      "maxRetries": 3
    }]
  ]
}
```

### opencode 2.x

Requires opencode 2.0.5+. Add to your `opencode.json` — note the **plural `plugins` key** and the object form; options under v1's singular `plugin` key load but are never delivered on v2:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-resume",
      "options": {
        "chunkTimeoutMs": 180000,
        "maxRetries": 3
      }
    }
  ]
}
```

To uninstall, delete the entry from `opencode.jsonc` (v1: the `plugin` array item, v2: the `plugins` object) and restart the server. To clear the cached copy too, remove `~/.cache/opencode/packages/opencode-auto-resume@*`.

## Configuration

### How a finished turn is judged

`session.idle` does not decide anything by itself. The turn is inspected in two passes, because `session.idle` can arrive while the assistant's closing text is still being written into the message history:

1. **Straight away** — is this a dead stream, is it handing control back to the user, is the user already busy. None of these read the final text.
2. **After `toolTextCheckDelayMs`** (3s default) — the celebration, tool-call-as-text, ready-to-continue, action-intent and done-claim detectors, re-reading the history. This is the pass the option exists for, and it re-runs the guards from step 1, because three seconds is long enough for the user to have replied and a nudge sent over them interrupts their own step.

A new turn cancels a pending second pass, and a second idle replaces it rather than stacking another judgement on the same text.

The v2 build reads and applies every option in the table below — the last of the gaps closed with `toolTextCheckDelayMs`. Any option it accepts but does not apply is listed in the startup line as `accepted-but-inert=…`; that list is currently empty. An option name this build does not know at all produces a single warning at startup, so a typo or a dropped port is never silent.

### Configurable options

Defaults are the same on v1 and v2 unless a row says otherwise.

| Option | Type | Default | Description |
|---|---|---|---|
| `chunkTimeoutMs` | `number` | `180000` | Inactivity timeout before considering stream stalled |
| `gracePeriodMs` | `number` | `3000` | Extra wait before acting (lets ESC/status events arrive) |
| `checkIntervalMs` | `number` | `5000` | Timer poll interval |
| `maxRetries` | `number` | `3` | Max auto-resume attempts before giving up |
| `baseBackoffMs` | `number` | `1000` | First retry delay (doubles each attempt) |
| `maxBackoffMs` | `number` | `8000` | Backoff cap |
| `subagentWaitMs` | `number` | `15000` | Wait before treating orphan parent as stuck |
| `subagentDeadMs` | `number` | `1800000` | Outer bound: quiet past this with no error evidence reads as dead (v2 only). Inside it, a quiet child is waited on, not aborted — 30 min default for long-thinking models |
| `loopMaxContinues` | `number` | `3` | Continues in window before triggering abort |
| `loopWindowMs` | `number` | `600000` | Hallucination loop detection window (10 min) |
| `lifetimeMaxContinues` | `number` | `9` (fast) / `20` (slow) | Lifetime stall continues per genuine user episode before standing down; resets only on a genuine user message/turn — see Stall recovery |
| `streamingFailureErrorNames` | `string[]` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Error names that classify as streaming failures (exact match) |
| `streamingFailureMessagePatterns` | `string[]` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Regex patterns (case-insensitive) in error messages indicating streaming failure |
| `maxRecoveryRetries` | `number` | `2` | v1 name for the streaming-failure retry budget; v2 canonical is `maxRetries` (alias accepted) |
| `toolTextCheckDelayMs` | `number` | `3000` | Settle delay before a finished turn's closing text is judged against the done/tool patterns; also the recovery watchdog delay. On v2 only the pattern half is deferred — dead streams are still caught on the idle event, because a stream that died before delivering any text has nothing for those patterns to read. Set `0` to judge on the idle event |
| `minActivityGapMs` | `number` | `1000` | Skip recovery if the session was active within this gap |
| `warmupMs` | `number` | `15000` | Action-intent detection disabled while a session is younger than this |
| `discoveryDelayMs` | `number` | `5000` | Delay before the initial session discovery run after plugin attach |
| `debug` | `boolean` | `false` | Enable `[debug]` console diagnostics |
| `resumeOnActionIntent` | `boolean` | `true` | Enable action-intent (`:`-terminated line) nudges |
| `continuePrompt` | `string` | `"continue"` | Prompt text for stall/streaming/dead-stream recovery |
| `actionIntentPrompt` | `string` | same as `continuePrompt` | Prompt sent on action-intent detection |
| `toolTextRecoveryPrompt` | `string` | `TOOL_TEXT_RECOVERY_PROMPT` | Override the tool-call-as-text recovery prompt |
| `thinkingToolRecoveryPrompt` | `string` | `THINKING_TOOL_RECOVERY_PROMPT` | Override the thinking-tool recovery prompt |
| `doneWithoutWorkPrompt` | `string` | `DONE_WITHOUT_WORK_PROMPT` | Override the done-claim-with-open-todos prompt. Needs a todo tool writing `todos/<sessionID>` into storage; without one it never fires |
| `doneWithoutDetailsPrompt` | `string` | `DONE_WITHOUT_DETAILS_PROMPT` | Override the done-claim-with-no-todos report prompt |
| `doneClaimPatterns` | `string[]` | `DONE_CLAIM_PATTERNS` | Array of regex strings overriding the default done-claim detection patterns (case-insensitive, multiline). Invalid regexes are skipped. Empty array falls back to defaults. |
| `readyToContinuePatterns` | `string[]` | `READY_TO_CONTINUE_PATTERNS` | Array of regex strings overriding the default ready-to-continue detection patterns (case-insensitive). Invalid regexes are skipped. Empty array falls back to defaults. |
| `silentDeadStreamMinTokens` | `number` | `200` | Min output tokens to treat a textless, tool-less finished message as a dead stream. Finished turns carrying tool calls are working, not silent, and tools in flight veto the inject regardless |
| `busyStallStrategy` | `"continue" \| "abort" \| "off"` | `"continue"` | Busy-stall response: `"continue"`, `"abort"` (abort-first), or `"off"` (disabled) |
| `contextSaturationThreshold` | `number` | `0.85` | Ratio of used/usable context that routes a saturated session to reclamation: a parent to magic-context `ctx-wrapup` (only when magic-context is installed), a subagent to native compaction (only when `subagentNativeCompactionEnabled`) |
| `activeUserWindowMs` | `number` | `300000` | Inbound-user-message recency window during which idle nudges stand down (user likely composing) |
| `stopPatterns` | `string[]` | `[]` | Array of regex strings (multiline). When the newest assistant message's text matches one, the session counts as awaiting the user and idle nudges stand down — e.g. `["STOP:\\s*(BLOCKED\|NEEDS_DECISION)\\b"]`. Invalid regexes are skipped. |
| `subagentNativeCompactionEnabled` | `boolean` | `false` | Opt-in native `session.summarize()` for saturated subagent sessions (no magic-context detection required) |
| `injectIntervalMs` | `number` | v2 only | Minimum gap between recovery injections for one session. No v1 equivalent |
| `visibleContinue` | `boolean` | `true`, v2 only | Send stall continue via `session.prompt()` — a real user message visible in session history (cattleprod-style) — instead of hidden `session.synthetic({resume:true})`. Set `false` for the old channel. Explicit option wins, else `AUTO_RESUME_VISIBLE_CONTINUE` (`0`/`false` = hidden) wins over the default |
| `richContinuePrompt` | `boolean` | `true`, v2 only | Stall continue names the stall reason, attempt count, and remaining todos instead of bare `"continue"`. A custom `continuePrompt` always wins verbatim |
| `rateLimitCooldownsMs` | `number[]` | `[900000, 1800000, 3600000, 7200000 ×5]` | Per-attempt cooldowns (ms) before a rate-limited session may be retried, evaluated as gates on each failure and watchdog tick (no armed timers to lose on reload). Default ≈ 12h coverage; past the ladder the session stays silent until a genuine user turn. Quota hits never consume the normal retry budget |
| `sendTimeoutMs` | `number` | `30000` | Bound (ms) on any single recovery send (prompt/synthetic); expiry flows into the normal throw path instead of stacking wedged sends |
| `stuckToolAgeMs` | `number` | `60000`, v2 only | A tool call with no result older than this reads as stuck (idle path nudges immediately instead of waiting out the stall window) |
| `neverInterruptTools` | `string[]` | `["compress"]`, v2 only | Tool names the busy-stall path never interrupts while fresh (case-insensitive); older than 30min they count as wedged like any other tool |
| `shareWatchState` | `boolean` | `false`, v2 only | Share the session watch map across setup re-runs in one process, so stall memory survives reloads |
| `registryScope` | `string` | unset, v2 only | Selects the process-global registry slot; test-only — production uses the pid-wide slot so reloads supersede cleanly |
| `quietCorrections` | `boolean` | `true`, v2 only | Feature-correction nudges (unknown-tool, stuck-tool, pattern recoveries) go through the invisible synthetic channel instead of a visible prompt; stall recovery always stays visible |
| `defaultFast` | `object` | unset | Per-profile overrides for online/fast models (e.g. `{ chunkTimeoutMs: 180000 }`) |
| `defaultSlow` | `object` | unset | Per-profile overrides for local/slow models (e.g. `{ lifetimeMaxContinues: 20 }`) |
| `modelProfiles` | `object` | unset | Per-provider overrides keyed by provider name (e.g. `{ "llama-server": { lifetimeMaxContinues: 20 } }`) |

Message patterns are matched case-insensitively. Error names use exact match.

### Internal constants (not configurable)

| Constant | Value | Description |
|---|---|---|
| `ABORT_CONTINUE_DELAY_MS` | `2000` | Delay between abort and continue |
| `MAX_IDLE_SESSIONS` | `50` | Idle session map cap before cleanup |
| `IDLE_CLEANUP_MS` | `600000` | Idle session age before cleanup (10 min) |
| `SESSION_DISCOVERY_INTERVAL_MS` | `60000` | Session discovery sweep interval (60s). Same on both builds; v2 reads the busy set from `session.active()` rather than a `status` field per row |

## Migrating from v1 to v2

Moving the plugin itself needs no action beyond the config key — the same npm package loads on both server generations and every recovery feature works unchanged. What changes:

1. **Config key renamed: `plugin` → `plugins`.** Local paths must start with `./` or `../` and resolve relative to the config file. Disable directives (`"-plugin-id"`, `"*"`) still work and are matched against the plugin's exported `id`. See [Installation](#installation) for the full config syntax.
2. **Option names.** All v1 options carry over. The only rename is `maxRecoveryRetries` → `maxRetries` (the v1 name is still accepted as an alias, so a v1 config ports unchanged); `activeUserWindowMs` now defaults to 5 minutes.
3. **Todos.** v2 has no built-in todo tools or events. The open-todos nudges need a todo plugin that persists `todowrite` calls to the session message log — see [Complementary plugins](#complementary-plugins-for-v2). Without one, every other recovery path runs unchanged.
4. **Verify.** Run `/status` inside opencode — it lists loaded plugins; `opencode-auto-resume` must be there on both v1 and v2.

## Features

LLM sessions fail in predictable ways. This plugin monitors all sessions and automatically recovers without user intervention. Each recovery path below references the upstream OpenCode issues that motivated it — these are problems not yet resolved in the official project.

### Recovery paths

#### Stall recovery

The stream goes silent but the session stays "busy". The UI shows a blinking cursor with no progress. If no events arrive for ~3 minutes (`chunkTimeoutMs` + `gracePeriodMs`), the plugin sends `"continue"` with exponential backoff. After 3 failed attempts it gives up.

Three budgets bound this path, because each answers a different question: `maxRetries` (default 3) is the per-episode ladder — it restarts when the model produces text, so a model that keeps replying "everything is done" reads 1/3 forever. `loopMaxContinues` (default 3 per `loopWindowMs`, 10 min) catches rapid-fire loops and escalates to abort+resume. `lifetimeMaxContinues` (default 9) is the lifetime cap per genuine user episode — it only resets on a genuine user message or genuine turn, never on model text, so the "done" loop above stops at 9 total continues and the session stands down until you speak.

The `busyStallStrategy` option controls this path: `"continue"` (default), `"abort"` (abort-first), or `"off"` — see [Recovery model](#recovery-model) for what a busy prompt can and cannot do while the runner is live.

Token flow counts as activity. The watchdog measures silence from events, but a turn generating tokens for minutes emits no other events — so every `session.usage.updated` event whose token total grew resets the silence clock. A flat total (nothing resumed) does not reset it, so a genuinely wedged session still trips the watchdog on schedule.

The plugin extracts the **agent, model, and provider** from the last session message, so it resumes with the exact same configuration the user was using (build, sisyphus, prometheus, etc.).

Per-session model profiles: Stall thresholds and retry budgets are selected per-session based on the model provider. Local models (running on your hardware) get more patience; online models (cloud APIs) get tighter timeouts.

**Local providers** (slow profile): `llama-server`, `ollama`, `vllm`, `lmstudio`, `koboldcpp`, `exllama`, `text-generation-inference`, `llamacpp`, and aliases.

**Online providers** (fast profile): everything else, including `opencode/*`.

| | Fast (online) | Slow (local) |
|---|---|---|
| `chunkTimeoutMs` | 180s | 600s |
| `gracePeriodMs` | 3s | 60s |
| `maxRetries` | 3 | 5 |
| `lifetimeMaxContinues` | 9 | 20 |

Override per-profile via `defaultFast` / `defaultSlow`, or per-provider via `modelProfiles`:

```json
{
  "modelProfiles": {
    "llama-server": { "lifetimeMaxContinues": 20 }
  },
  "defaultSlow": { "chunkTimeoutMs": 900000 }
}
```

The profile is resolved at stall-detection time (not session start), so mid-session model switches are handled automatically.

_Motivated by:_
- [#34214](https://github.com/anomalyco/opencode/issues/34214) — Opencode freezes / becomes unresponsive mid-session
- [#35207](https://github.com/anomalyco/opencode/issues/35207) — Session hangs indefinitely after MCP tool-call — no timeout recovery (deadlock)
- [#31655](https://github.com/anomalyco/opencode/issues/31655) — Window completely frozen/unresponsive after reopening a project with a stalled session
- [#34460](https://github.com/anomalyco/opencode/issues/34460) — Thread freezes after switching to Go model — requires Escape key to unstick

#### Tool calls as raw text

The model prints tool invocations as raw XML/JSON (`<function=edit>...`, `{"type":"function",...}`) instead of executing them. The session goes idle normally but the tool was never run. On idle, the plugin fetches the last messages and scans for XML tool-call patterns — including truncated and alternative formats. If found, it sends `TOOL_TEXT_RECOVERY_PROMPT` to force a clean tool call.

Also detects tool calls trapped inside **thinking/reasoning** parts and emits `THINKING_TOOL_RECOVERY_PROMPT` to extract them.

_Motivated by:_
- [#31247](https://github.com/anomalyco/opencode/issues/31247) — Copilot Claude Opus 4.8 emits pseudo tool-call text instead of structured tool calls
- [#34126](https://github.com/anomalyco/opencode/issues/34126) — OpenAI Chat parser treats standalone text before tool_calls as assistant text
- [#33959](https://github.com/anomalyco/opencode/issues/33959) — OpenCode Desktop does not execute valid OpenAI tool calls from qwen3-coder:30b (Ollama)
- [#35689](https://github.com/anomalyco/opencode/issues/35689) — DeepSeek silently stops executing (interleaved reasoning_content dropped in tool call messages)

#### Hallucination loop

The model generates the same broken output repeatedly. Each `continue` just picks up the broken generation. If a session needs 3+ continues within 10 minutes, the plugin aborts the request and sends `"continue"` fresh, forcing a clean restart.

A separate **tool-call loop detector** catches the model calling the same tool 3+ consecutive times (or repeating patterns of length 2-5 occurring at least three times). When detected, it emits `TOOL_LOOP_RECOVERY_PROMPT` (at most twice per busy turn) to break the loop instead of blindly continuing.

Loop detection runs in two places. At idle, tool names are scanned from recent assistant messages. **Live**, every `tool.execute.before` hook fingerprints the call as `tool name + arguments` — so a subagent stuck re-reading the same file/range (even alternating between two near-identical argument sets, which never produces 3 consecutive identical calls) is caught after 6+ calls in the repeating cycle. (v1 hooks; v2 fingerprints the same way from `session.tool.called` events via `trackToolCall`.) On live detection the plugin aborts the running turn immediately (this is the sanctioned exception to the never-abort-busy rule: 6+ identical name+args fingerprints prove a hallucinated loop, and the current call has not started yet) and then sends `TOOL_LOOP_RECOVERY_PROMPT`. Esc-cancelled sessions are never touched.

#### Unknown tool suggestion

When the model calls a tool that does not exist (a typo, a hallucinated name, or a tool from a different plugin that isn't loaded), OpenCode returns a `tool` part with `state.status = "error"`. If the same wrong tool name appears **2 times** in the session's message history, the plugin:

1. Fetches the list of available tools — via `ctx.client.tool.ids()` on v1, or `ctx.tool.list()` on v2, cached for 5 minutes. On v2 the names are the registry's *effective* names, so a namespaced tool is quoted back in the form a model would have to call it.
2. Computes the closest match by Levenshtein distance (case-insensitive, threshold = half the wrong name's length).
3. Sends a continue prompt that names the wrong tool, states it does not exist, suggests the closest match (if one was found), and lists the first 20 available tools for reference.

The suggestion fires once per busy cycle. A new user message resets the counter so the suggestion can fire again on a fresh cycle. Tool parts that already succeeded (`state.status = "completed"`) and parts for tools that do exist are skipped.

Threshold and cache are compile-time constants (`UNKNOWN_TOOL_THRESHOLD = 2`, `TOOL_IDS_CACHE_MS = 5 min`). The detection runs at idle, alongside the tool-text recovery check.

On v2 the tool list comes from the registry, so the check degrades rather than guesses: no registry, an empty registry, or a registry that throws all mean no suggestion, because with nothing to compare against every name would look invented.

_Motivated by:_
- [#22142](https://github.com/anomalyco/opencode/issues/22142) — Repetitive tool-call loops with alibaba-coding-plan-cn/qwen3.6-plus
- [#16218](https://github.com/anomalyco/opencode/issues/16218) — Model repeats the same response in a loop after generating an answer
- [#33216](https://github.com/anomalyco/opencode/issues/33216) — OpenCode Repeatedly Ignores Instructions and Loops Responses
- [#35784](https://github.com/anomalyco/opencode/issues/35784) — opencode-go/glm-5.2 + read file loop
- [#25129](https://github.com/anomalyco/opencode/issues/25129) — Thinking mode gets stuck in infinite repetition loop

#### Orphan parent

A subagent finishes but the parent session stays stuck as "busy" forever. The plugin detects when `busyCount` drops from >1 to 1, confirms the survivor really has subagents, waits `subagentWaitMs` + `gracePeriodMs` (18s default), probes the subagent (nudging a crashed child once, then waiting a further `subagentWaitMs` before giving up on it), and aborts and resumes the parent if it is still stuck. The parent is never interrupted while it has a tool in flight or is waiting on the user.

_Motivated by:_
- [#35066](https://github.com/anomalyco/opencode/issues/35066) — notify parent when subagent sessions finish
- [#33050](https://github.com/anomalyco/opencode/issues/33050) — orphaned sessions continue looping after abort, causing sustained high CPU
- [#32335](https://github.com/anomalyco/opencode/issues/32335) — opencode run processes don't exit after completing scheduled work, causing memory leak

#### Subagent stuck detection

Detects when a subagent hasn't received new text for >1 minute (or >3 minutes if a tool call is in progress). If stuck, sends a recovery prompt to the subagent before triggering abort+resume on the parent. This avoids killing a parent that merely has a slow child.

_Motivated by:_
- [#35073](https://github.com/anomalyco/opencode/issues/35073) — subagent permission asks hang indefinitely (sync subagents treated as interactive)
- [#35806](https://github.com/anomalyco/opencode/issues/35806) — malformed tool-input stream ordering crashes Session drains
- [#32580](https://github.com/anomalyco/opencode/issues/32580) — Agent showing repeated thinking

#### Streaming failure recovery

The AI provider's streaming response can fail mid-stream (connection reset, timeout, socket close). When the provider reports an error whose **name** matches `streamingFailureErrorNames` (exact, case-sensitive) or whose **message** matches `streamingFailureMessagePatterns` (regex, case-insensitive), the plugin arms a deferred recovery instead of relying only on the generic stall timeout. Invalid regex patterns fall back to substring matching. (Same classification on both builds; what happens *after* classification differs — v1 flow below, v2 differences noted inline.)

**Default error names:**
- `ProviderError`, `APIError`, `StreamError`, `ConnectionError`, `TimeoutError`

**Default message patterns:**
- `streaming response failed`, `stream.*fail`, `connection.*reset`, `connection.*closed`

**Recovery behavior:**

v1 flow (v2 classifies identically — same option names — but feeds the unified `recover()` ladder instead: consecutive failure recoveries with no model output between them count up in `consecFailureRecovers` and latch `failureLoopLatched` rather than cycling forever; there is no `pendingRecovery*` state on v2):

1. **Detection**: `session.error` is classified via `isStreamingFailure()` against the configured error names and message patterns
2. **State transition**: the session's `pendingRecovery` flag is armed with the error name (`pendingRecoveryReason`) and timestamp (`pendingRecoveryAt`)
3. **Recovery attempt**: once the session is idle and the backoff delay has elapsed, the timer loop sends a recovery prompt
4. **Watchdog**: if the session is still not busy `toolTextCheckDelayMs` (3s default) after the prompt, the recovery is retried (up to `maxRecoveryRetries`) with exponential backoff
5. **Escalation**: when retries are exhausted, the plugin aborts the session and resumes it (`abort+resume`); `gaveUp` is set if that also fails

Recovery chain: `pendingRecovery` → recovery attempt → `recoveryAttempts` retry → `abort+resume` → `gaveUp`.

_Motivated by:_
- EPIC: Streaming Failure Recovery — recovery requests not consistently creating new assistant executions after mid-stream failures

#### Silent dead-stream recovery

The model stream can die after emitting only reasoning — no text part, no tool call — finalizing with a finish reason such as `finish: "unknown"` (any finish reason qualifies, including `"stop"`). OpenCode treats the message as completed and the session goes idle, so no error or stall path triggers. On idle, if the **newest** assistant message has a finish reason, zero text parts, **zero tool-call parts**, and at least `silentDeadStreamMinTokens` output tokens, the plugin sends a recovery prompt. A finished turn that issued tool calls is working, not silent — thinking models routinely end tool-working turns with no chatter text . As a second guard, recovery is refused while tool calls are still in flight, read from a snapshot taken at the idle transition (`markIdle` zeroes the live counter, and idle fires while tools run). Only the newest assistant message is evaluated — a delivered text answer means normal completion, and older tool-call steps are never misread as dead streams. Recovery is also skipped if the session has gone busy/retry again before the prompt is sent (race guard).

### Completion detection

#### Explicit completion via `task_complete`

The agent can call the `task_complete` tool to signal that all work is done. When invoked, the plugin stops sending any further `"continue"` prompts, clears all pending timers, and marks the session as complete. This replaces fragile text-based heuristics (emoji patterns, language detection) with a deterministic signal.

On v2 there is no built-in equivalent, so the plugin registers the tool itself through the v2 tool registry (`ctx.tool.transform`). It is registered before the first turn, and a registry that refuses the registration is logged and skipped rather than taking the watchdog down with it.

If `task_complete` is called while open todos remain, the call is rejected (up to `maxRetries` times) with a message asking the agent to finish the remaining work first.

Repeat calls with no new user message in between are guarded: the first acknowledgement carries an explicit stop instruction, the second returns a repeat warning, and the third and subsequent calls are rejected as errors. This breaks the ack self-loop where the acknowledgement tool-result is fed back into the turn and a stuck model re-emits `task_complete` instead of ending with text — v1 logged 27 consecutive acked calls with zero new user input. The counter resets on a genuine user message, on the block path above, or when any other tool runs in between.

The todo gate is skipped for subagents: a child was never asked to do the parent's open items, so gating its report on them would block it on work outside its scope.

#### 🎉 emoji completion

An assistant message ending with 🎉 latches completion exactly the way a trailing `TASK COMPLETE` does — todo cross-check first, latch plus early return on success, reminder nudge instead when work is listed. Neither path touches the tool-text timer directly; both prevent triggers by latching and ending the inspection. The emoji signals the agent considers the task complete.

The emoji alone is not trusted: a model that finishes early celebrates early, and latching on that turns a false positive into silence. Both builds cross-check the session's todo list first, and with items still open the 🎉 is treated as a false positive — the reminder names what is unfinished instead. See [Todo list nudges](#todo-list-nudges) for how v2 reads that list.

#### Stop statements

End-anchored patterns over the last three lines: bare `TASK COMPLETE`, `no action needed`, `stopping here/there/now`, `nothing further/else/pending…`, `no further action/work…`, `none pending/left…`, `stopping/halted/pausing…`, `that's all…`, `parked/not started…`. A connective clause after the stop ("Stopping here for a moment, then continuing") disqualifies it — a stop is only a stop if it is the last clause. Like every text signal, a stop claim with open todos produces the reminder nudge instead of latching. Standby phrasing (`standing by for next instructions`) and ready-and-waiting phrasing (`ready when you have the next task`, `ready for your next instruction`) latch the same way: the model is out of work, which is done, not ready-to-continue (that family auto-sends `continue`; this one stays quiet). A question mark disqualifies the ready pattern — `ready for the next task?` is still-working, never a stop.

Mined from live stall replies, all end-anchored the same way: "Stopping here." (covered), "Standing by.", "Nothing in progress …" (bare "in progress" alone must never match — "work is still in progress" is the opposite), bare "Done.". Conversely "I'll report X when it lands" is future intent, not completion, and matches nothing — documented here so a future widening doesn't swallow it.

Case discipline: the system's own literal is the one case-sensitive pattern in the build — bare `TASK COMPLETE` must read byte-exact. Every other completion pattern is case-insensitive. A lowercase `task complete` is model prose and latches nothing; past-tense `task completed` (any case) still latches — it was never the literal.

#### Done-claim verification

If the assistant claims the task is done ("task done", "finished", "all complete") but open todos remain, the plugin sends `DONE_WITHOUT_WORK_PROMPT` asking the agent to verify and finish remaining work. If it claims done with **no** open todos and the response carries no work description, the plugin sends `DONE_WITHOUT_DETAILS_PROMPT` — an imperative prompt demanding a concrete report (files changed, commands run, results). A response that already contains file paths, verification output, or result sections satisfies the demand on its own and never triggers the prompt. The budget is capped at `maxRetries` across busy cycles (going busy no longer re-arms it); only a genuinely new inbound user message re-arms it. v1 reads the real `todo.updated` event state; v2 reads the message log (newest completed `todowrite` call) — neither uses regex on the message text for the list itself.

#### Ready-to-continue auto-resume

When the assistant prints phrases like "Ready to continue with task" or "Proceeding with task", the plugin automatically sends `"continue"` without waiting for the user. This catches the common pattern where the model stops to ask for permission it doesn't need.

#### Action-intent nudge

When the assistant ends a line with `:` ("Next, I will edit the file:") — announcing intent without acting — the plugin sends `actionIntentPrompt` after a short delay, nudging the model to execute. Disable with `resumeOnActionIntent: false`. Detection is skipped while a session is younger than `warmupMs`.

### Safety rails

#### Active-tool safety guard

Before **any** abort, two guards run in order: the primary deterministic in-flight counter maintained by the `tool.execute.before`/`tool.execute.after` hooks (`hasInflightTools()`), then a polled `checkSessionHasActiveTool()` fallback for sessions discovered without hooks. (v1 hooks; v2 derives the same state from `session.tool.called`/`success`/`failed` events — `pendingTools` plus per-call start times.) If a tool is running, the abort is skipped. This prevents the plugin from killing a long-running build, test suite, or command — even when it looks like a stall.

_Motivated by:_
- [#26063](https://github.com/anomalyco/opencode/issues/26063) — Tool execution aborted/terminated
- [#31459](https://github.com/anomalyco/opencode/issues/31459) — "Tool execution aborted" during Preparing write
- [#5937](https://github.com/Mte90/opencode-auto-resume) — (internal) must never abort a tool execution

#### ESC cancel respected

User presses ESC to cancel a request. The plugin detects `MessageAbortedError` and marks sessions as cancelled — regardless of their tracked status, so a late status flip to idle before the error cannot miss the latch — and never resumes them. Aborts initiated by the plugin itself (`pluginAbortInFlight`) are excluded, so recovery aborts are not mistaken for ESC. (v1 mechanism; v2 reads `session.execution.interrupted` by reason — only genuine user stops latch — and tracks own aborts with the self-abort window instead.) The grace period (`gracePeriodMs`) also lets late ESC/status events arrive before any action.

The back-off lifts as soon as the user sends a new prompt in that session (`chat.message` hook; v2 reads new inbound messages out of history instead): a fresh user message starts a new round of work, so auto-resume re-arms. The plugin's own recovery prompts do not re-arm it. The same applies to the `task_complete` latch.

_Motivated by:_
- [#28453](https://github.com/anomalyco/opencode/issues/28453) — ACP session/cancel emits agent_error for MessageAbortedError before cancelled result
- [#32432](https://github.com/anomalyco/opencode/issues/32432) — Cancelled subagents can't be opened in TUI + Ctrl+X intermittently fails
- [#30144](https://github.com/anomalyco/opencode/issues/30144) — Early prompt cancel can poison directory instance

#### User-input awareness

The session is not stalled while the ball is in the user's court. Three gates stand down idle nudges:

- **Awaiting input**: the newest assistant message holds a `tool_use` part with `state.status: "pending"` (e.g. an open `question` tool call). All idle checks, the periodic recheck, delayed action-intent callbacks, and the tool-text scan skip prompting until a newer user message clears the gate. Completed tool calls never engage it.
- **Recently active user**: any inbound user message within `activeUserWindowMs` (default 5 minutes) means the user is engaged — likely composing a reply, which leaves no pending tool call behind. Open-todos nudges (idle + periodic), the tool-text reminder fallback, and action-intent callbacks stand down until the window expires.
- **Explicit stop line** (opt-in): when the newest assistant message's text matches one of `stopPatterns`, the agent has deliberately handed the ball to the user — typical for agent setups whose prompts end a turn with a protocol line such as `STOP: NEEDS_DECISION <question>` or `STOP: BLOCKED <reason>`, while the todo for that decision is still open. It counts exactly like the awaiting-input gate. Default: no patterns (unchanged behaviour).

#### False-positive protection during subagent work

Long tool execution or active subagents can look like a stall. Only the session emitting events gets its timer reset (not all sessions). When multiple sessions are busy, stall detection is paused entirely. The plugin also clears existing timers before creating a new `setTimeout` in idle handlers to prevent queued continue triggers.

#### Model, agent & provider preservation

When resuming with `"continue"`, the plugin extracts agent, model, and provider from the last session message — falling back to `msg.info.agent` / `msg.info.model` if the top-level field is missing. This preserves the user's UI selection across resumes instead of reverting to the default agent.

_Motivated by:_
- [#35126](https://github.com/anomalyco/opencode/issues/35126) — Subagents launched via task tool ignore their model: frontmatter and inherit parent agent's model
- [#35899](https://github.com/anomalyco/opencode/issues/35899) — Web: switching sessions overwrites user-selected model with agent default
- [#34562](https://github.com/anomalyco/opencode/issues/34562) — Model provider not restored correctly when switching projects

### Session housekeeping

#### Session discovery & cleanup

Periodically calls `session.list()` (every 60s) to pick up sessions that were missed by event tracking. Idle sessions are cleaned up after 10 minutes or when the idle map exceeds 50 entries, preventing memory leaks.

_Motivated by:_
- [#35750](https://github.com/anomalyco/opencode/issues/35750) — Upgrade to 1.17.x hides pre-existing sessions — new path column not back-filled during migration
- [#33102](https://github.com/anomalyco/opencode/issues/33102) — OpenCode Go workspace subscription is orphaned/hidden and cannot be managed from dashboard
- [#27759](https://github.com/anomalyco/opencode/issues/27759) — Session heartbeat for multi-session liveness detection

#### Pausing auto-resume

Long-running quota blocks (or any delicate work) can be paused without deleting the session:

- Slash command: `/auto-resume off` pauses the current session, `/auto-resume on` resumes, `/auto-resume` (or `/auto-resume status`) reports state. While paused, auto-resume will not inject a continue nudge and will not arm the quota ladder.
- CLI helper (works without opening the chat): `auto-resume-toggle <sessionID> off|on|status`, plus `auto-resume-toggle --all off|on` to pause/resume every session.
- Pause is sticky within a run: it stays off until an explicit `on`, so a forgotten pause won't silently re-arm. A restart of opencode/OpenChamber clears all pauses (re-arms auto-resume), so a stale pause can never outlive a session. (The marker file is `~/.config/opencode/auto-resume.paused`.)

#### Todo list nudges

Opencode v1 ships todos out of the box — built-in `todowrite`/`todoread` tools, a `todo` table, and a `todo.updated` event the plugin subscribes to directly. OpenCode v2 removed all of it (tools, table, and event), so a v2 session has no todo list by default. auto-resume does not own one either. It reads the session message log, where every `todowrite` call is persisted as a tool part carrying the whole list, and the newest completed call is the current list.

The writer is the todo plugin you install. The upstream [opencode-todolist](https://github.com/aiev/opencode-todolist) restores `todowrite` and `todoread` in v2 (its sidebar strip appears in opencode-cli only — no other surface shows it); the confirmed pairing here is upstream itself (v0.6.0+, verified live — the `opencode-todo-fork` interim fork is retired). You can view the list at any time with the `/todo` command. Any plugin that persists `todowrite` calls to the message log should work, but only upstream has been tested.

The todo plugin is optional, and without it the unfinished-task nudges never trigger. Every other recovery path runs fine on its own; the list gates exactly the nudges that check it. With no `todowrite` call in the log, auto-resume sees no list and falls back to the older behaviour (latch on the 🎉 emoji, demand a report on a bare done-claim). It never nudges on the strength of a list it failed to read.

When a turn ends with items still open, the nudge names them:

> You have 2 unfinished tasks: 1. [pending] Verify the plugin loads under v2 2. [in_progress] Write the todo-nudges section of the README Please continue working on these tasks.

`buildOpenTodosReminder` sends that verbatim, numbering each open item (`pending` or `in_progress`) and falling back to a bare `continue` when the list is unusable. Four paths send it: a 🎉 celebration with items still open, a `task_complete` with items still open, a stop statement with work listed, and a completion claim with work listed. The ready-to-continue check reads the same list in reverse: a "ready" claim while every todo is already closed gets two chances before a plain `continue`.

#### Context saturation → magic-context wrapup

A session can fill its usable context window without stalling — it just keeps working until it chokes. The plugin tracks token usage from `message.updated` events and computes the ratio against the model's usable window (`context − min(20k, maxOutput)`, mirroring OpenCode's own overflow math). On idle, when the ratio crosses `contextSaturationThreshold` (default 0.85), routing depends on session kind. For parent sessions, only when magic-context is detected in the host's configured plugin list (`config.get().plugin`), the plugin invokes the registered `ctx-wrapup` command through `client.session.command()` — it does not send `/ctx-wrapup` as prompt text, because prompt text is not expanded into a command. For subagent sessions identified by `parentID` on `session.created`, the default is no intervention: magic-context does run bounded cleanup for subagents (structural-noise/cleared-reasoning strips, heuristic drops, ceiling nudges), but its hard protections — historian compartments, emergency fail-closed abort, caveman compression — skip subagents, and on true overflow the error just propagates to the parent with no deterministic reclaim. Terminal reclamation therefore depends on the agent calling `ctx_reduce` when nudged. If `subagentNativeCompactionEnabled` is `true`, the plugin calls native `session.summarize()` as an opt-in safety net. Fail-safe: provider lookup errors, unknown model limits, user cancellation, or completion signals mean no intervention. Magic-context absence additionally disables only the parent path (the `ctx-wrapup` command would not be registered); the opt-in subagent path needs no magic-context detection because `session.summarize()` is native. This path is magic-context-gated on purpose: magic-context's setup disables OpenCode's native compaction, so unconditionally summarizing a magic-context-managed parent would double-compress and fight its cache-aware historian. One intervention per busy cycle.

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

**What the prompt looks like.** Stall continues are rich by default (`richContinuePrompt`, v2 only): reason, attempt and episode-retry count (`attempt 1/3 (retry #4)`), idle duration, local timestamp, open todos, and the no-new-work / no-destructive-actions guardrails, e.g. `continue — stalled (no activity for 186s). attempt 1/3 (retry #1); idle 3m 6s; Oct 12, 7:37 PM EDT. Only continue…`. Set `richContinuePrompt: false` for the bare `"continue"` (v1 behavior), or set `continuePrompt` to any custom text, which always wins verbatim.

### 3. Abort-first recovery

Aborts the active run, then continues. The only family that can unblock a live runner.

Paths: orphan parent, subagent stuck (parent side), hallucination loop, streaming-failure escalation. All aborts pass the active-tool guards first, and plugin-initiated aborts are marked so they are not mistaken for user ESC (`session.error` → `MessageAbortedError` race).

## Complementary plugins (for v2)

Auto-resume works on its own, but two companion plugins make it sharper. Both are optional — auto-resume detects their presence and degrades gracefully when they are absent.

| Plugin | Required? | If absent |
|---|---|---|
| opencode-todolist | No | No task-aware nudges; other paths unaffected |
| opencode-task-complete | No | Built-in fallback `task_complete` tool; text/emoji completion |

- [opencode-todolist](https://github.com/aiev/opencode-todolist) — Restores `todowrite` / `todoread` in opencode v2
- [opencode-task-complete](https://github.com/famewolf/opencode-task-complete) — Provides the `task_complete` tool for explicit completion signalling

## Verification & troubleshooting

To verify the plugin is loaded, run `/status` inside OpenCode — it lists all loaded plugins and their versions. You should see `opencode-auto-resume` in the list.

On v2 a clean load writes nothing at startup: warnings and recovery lines go to the server process output, not a file, and there is no ready banner. To confirm the config reached the plugin, trigger any recovery — every action is logged to the process output.

| Problem | Solution |
|---|---|
| Resumes after ESC | Increase `gracePeriodMs` to `5000` |
| Stall recovery too aggressive | Decrease `chunkTimeoutMs` (e.g. `45000`) |
| Too slow to react | Decrease `checkIntervalMs` to `2000` |
| Orphan parent not detected | Increase `subagentWaitMs` to `20000` |
| Hallucination loop not caught | Decrease `loopMaxContinues` to `2` |
| Model keeps saying "done", nudged forever | Decrease `lifetimeMaxContinues` (e.g. `5`); raise it for long unattended runs |
| Tool-text not detected | Check server logs — requires SDK message fetching (v1). On v2 the history comes from the client message surface or loopback HTTP — check the server process output instead |
| Long-running tool killed | Should not happen — active-tool guard prevents it. Report a bug. |
| No plugin activity in the log | The entry is not in a location opencode scans, or not listed in `plugins`; fix the config and restart opencode. |
| Log says `ctx.app.version is missing` (or `ctx.serverUrl is missing` on v1) | The build was loaded on the wrong server generation. Update the npm package (the universal entry auto-selects the branch) or match the build file to the server. |
| Never recovers a parent waiting on a subagent | Intentional: parent sessions blocked on a running subagent are left alone. |
| Never recovers while a permission dialog is open | Intentional: recovery is held until the permission is answered. |
| Recovers but you don't see a notice (v2) | Your model/provider may reject `session.synthetic()`; the plugin falls back to `session.prompt()` (no TUI banner). |
| `Unexpected server error` on startup | Update to v1.1.8+. Caused by non-Plugin exports being treated as plugin entrypoints by OpenCode's loader. Clear the plugin cache (`~/.cache/opencode/packages/opencode-auto-resume@*`) and restart. |
