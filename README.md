# opencode-auto-resume

**Plugin for [OpenCode](https://github.com/anomalyco/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, stuck subagent parents, and more. Fully silent, zero UI pollution.**

## What it does

LLM sessions fail in predictable ways. This plugin monitors all sessions and automatically recovers without user intervention. Each recovery path below references the upstream OpenCode issues that motivated it — these are problems not yet resolved in the official project.

---

### Stall recovery

The stream goes silent but the session stays "busy". The UI shows a blinking cursor with no progress. If no events arrive for 48 seconds (`chunkTimeoutMs` + `gracePeriodMs`), the plugin sends `"continue"` with exponential backoff. After 3 failed attempts it gives up.

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

A separate **tool-call loop detector** also catches the model calling the same tool 3+ consecutive times (or repeating patterns of length 2-5 occurring at least three times). When detected, it emits `TOOL_LOOP_RECOVERY_PROMPT` to break the loop instead of blindly continuing.

_Motivated by:_
- [#22142](https://github.com/anomalyco/opencode/issues/22142) — Repetitive tool-call loops with alibaba-coding-plan-cn/qwen3.6-plus
- [#16218](https://github.com/anomalyco/opencode/issues/16218) — Model repeats the same response in a loop after generating an answer
- [#33216](https://github.com/anomalyco/opencode/issues/33216) — OpenCode Repeatedly Ignores Instructions and Loops Responses
- [#35784](https://github.com/anomalyco/opencode/issues/35784) — opencode-go/glm-5.2 + read file loop
- [#25129](https://github.com/anomalyco/opencode/issues/25129) — Thinking mode gets stuck in infinite repetition loop

---

### Orphan parent

A subagent finishes but the parent session stays stuck as "busy" forever. The plugin detects when `busyCount` drops from >1 to 1, waits 15 seconds (`subagentWaitMs`), then aborts and resumes the parent.

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

### Active-tool safety guard

Before **any** abort, the plugin calls `checkSessionHasActiveTool()` to verify the session isn't mid-tool-execution. If a tool is running, the abort is skipped. This prevents the plugin from killing a long-running build, test suite, or command — even when it looks like a stall.

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

User presses ESC to cancel a request. The plugin detects `MessageAbortedError` and marks all busy sessions as cancelled, never resuming them. The grace period (`gracePeriodMs`) also lets late ESC/status events arrive before any action.

_Motivated by:_
- [#28453](https://github.com/anomalyco/opencode/issues/28453) — ACP session/cancel emits agent_error for MessageAbortedError before cancelled result
- [#32432](https://github.com/anomalyco/opencode/issues/32432) — Cancelled subagents can't be opened in TUI + Ctrl+X intermittently fails
- [#30144](https://github.com/anomalyco/opencode/issues/30144) — Early prompt cancel can poison directory instance

---

### Explicit completion via `task_complete`

The agent can call the built-in `task_complete` tool to signal that all work is done. When invoked, the plugin stops sending any further `"continue"` prompts, clears all pending timers, and marks the session as complete. This replaces fragile text-based heuristics (emoji patterns, language detection) with a deterministic signal.

---

### 🎉 emoji completion

An assistant message ending with 🎉 resets the tool-text timer and prevents a trigger — the emoji signals the agent considers the task complete.

---

### Ready-to-continue auto-resume

When the assistant prints phrases like "Ready to continue with task" or "Proceeding with task", the plugin automatically sends `"continue"` without waiting for the user. This catches the common pattern where the model stops to ask for permission it doesn't need.

---

### Done-claim verification

If the assistant claims the task is done ("task done", "finished", "all complete") but open todos remain, the plugin sends `DONE_WITHOUT_WORK_PROMPT` asking the agent to verify and finish remaining work. This uses the real `todo.updated` event state — not regex on the message text.

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

## Architecture

```
Any SSE Event
  ├─ has sessionID? → touchSession(sid) — reset only that session's timer
  └─ no sessionID → ignore

session.status events:
  ├─ busy → reset timer, clear retry counters
  └─ idle → schedule tool-text check (3s delay)
              └─ fetch messages → scan for XML / thinking-tool patterns
                  ├─ found → send recovery prompt (with backoff)
                  └─ not found → check ready-to-continue / done-claim patterns
              └─ orphan check: busyCount dropped from >1 to 1?
                  └─ subagentWaitMs watch → abort + continue

todo.updated events:
  └─ track real todo state (not regex on message text)

Timer loop (every 5s):
  for each busy session:
    ├─ orphan watch active? → wait or abort+continue
    ├─ busyCount > 1? → skip (subagent running)
    ├─ active tool running? → skip (never abort tools)
    └─ idle > 48s? → hallucination loop? abort : continue with backoff

Periodic (every 60s): session.list() to discover missed sessions
Periodic: cleanup idle sessions older than 10min or >50 entries
```

## Installation

### Via npm (recommended)

```bash
npm install opencode-auto-resume
```

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

### Via GitHub (manual clone)

OpenCode may clone the repository to `~/.config/opencode/plugins/opencode-auto-resume/` automatically.

**To update** the plugin:
```bash
cd ~/.config/opencode/plugins/opencode-auto-resume
git pull
bun run build
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

### Internal constants (not configurable)

| Constant | Value | Description |
|---|---|---|
| `TOOL_TEXT_CHECK_DELAY_MS` | `3000` | Delay before scanning idle session for tool-as-text |
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
