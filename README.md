# opencode-auto-resume

**Plugin for [OpenCode](https://github.com/anomalyco/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, and stuck subagent parents. Fully silent, zero UI pollution.**

## What it does

LLM sessions fail in predictable ways. This plugin monitors all sessions and automatically recovers without user intervention.

**Stall recovery** — the stream goes silent but the session stays "busy". The UI shows a blinking cursor with no progress. If no events arrive for 48 seconds, the plugin sends `"continue"` with exponential backoff starting at 30s, doubling each retry, capped at 10 minutes. Retries continue indefinitely — the plugin never gives up on a stalled session. Actively-running tool calls that produce output are never interrupted (any event resets the timer).

The plugin extracts the **agent, model, and provider** from the last session message, so it resumes with the exact same configuration the user was using (build, sisyphus, prometheus, etc.).
_( [#55](https://github.com/anomalyco/opencode/issues/55), [#199](https://github.com/anomalyco/opencode/issues/199), [#283](https://github.com/anomalyco/opencode/issues/283) )_

**Tool call stall recovery** — when a tool call ends (completed or errored) but the agent doesn't continue, the session stays "busy" indefinitely. The plugin detects this as a stall (no events after the tool ends) and sends `"continue"` with the same exponential backoff. This also works for subagents: when multiple sessions are busy and one has been idle for an extended period (4x the normal timeout), the plugin attempts recovery.

**Tool calls as raw text** — the model prints tool invocations as raw XML (`<function=edit>...`) instead of executing them. The session goes idle normally but the tool was never run. On idle, the plugin fetches the last messages and scans for XML tool-call patterns (including truncated and alternative formats). If found, it sends a specific recovery prompt (up to 3 attempts).
_( [#150](https://github.com/anomalyco/opencode/issues/150), [#313](https://github.com/anomalyco/opencode/issues/313), [#353](https://github.com/anomalyco/opencode/issues/353) )_

**Hallucination loop** — the model generates the same broken output repeatedly. Each continue just picks up the broken generation. If a session needs 3+ continues within 10 minutes, the plugin aborts the request and sends `"continue"` fresh, forcing a clean restart.
_( [#283](https://github.com/anomalyco/opencode/issues/283), [#353](https://github.com/anomalyco/opencode/issues/353) )_

**Orphan parent** — a subagent finishes but the parent session stays stuck as "busy" forever. The plugin detects when busyCount drops from >1 to 1, waits 15 seconds, then aborts and resumes the parent. Retries indefinitely with exponential backoff.
_( [#122](https://github.com/anomalyco/opencode/issues/122), [#199](https://github.com/anomalyco/opencode/issues/199), [#246](https://github.com/anomalyco/opencode/issues/246) )_

**False positives during subagent work** — long tool execution or active subagents can look like a stall. Only the session emitting events gets its timer reset (not all sessions). When multiple sessions are busy, stall detection is paused entirely.
_( [#55](https://github.com/anomalyco/opencode/issues/55), [#221](https://github.com/anomalyco/opencode/issues/221) )_

**ESC cancel** — user presses ESC to cancel a request. The plugin detects `MessageAbortedError` and marks all busy sessions as cancelled, never resuming them.

**Spurious error messages** — after normal completion, OpenCode sometimes fires a `session.error`. All logging goes through `ctx.client.app.log()` (zero `console.log`), and errors on already-idle sessions are silently ignored.
_( [#128](https://github.com/anomalyco/opencode/pulls/128), [#22](https://github.com/anomalyco/opencode/pulls/22) )_

**Session discovery** — periodically calls `session.list()` to pick up sessions that were missed by event tracking. Idle sessions are cleaned up after 10 minutes to prevent memory leaks.

**Model preservation** — when resuming with "continue", the plugin extracts agent, model and provider from the last session message (not from `info` field) to preserve the user's UI selection.
_( [#111](https://github.com/anomalyco/opencode/issues/111), [#277](https://github.com/anomalyco/opencode/issues/277) )_

**Subagent stuck detection** — detects when a subagent hasn't received new text for >1 minute (or >3 minutes if a tool call is in progress). If stuck, sends a recovery prompt before triggering abort+resume on the parent.
_( [#55](https://github.com/anomalyco/opencode/issues/55), [#60](https://github.com/anomalyco/opencode/issues/60), [#246](https://github.com/anomalyco/opencode/issues/246) )_

## Architecture

```
Any SSE Event
  ├─ has sessionID? → touchSession(sid) — reset only that session's timer
  └─ no sessionID → ignore

message.part.updated events:
  ├─ tool call "running" → track toolRunningSince
  └─ tool call "completed"/"error" → clear toolRunningSince, track lastToolOutputAt

session.status events:
  ├─ busy → reset timer, clear retry counters
  └─ idle → schedule tool-text check (1.5s delay)
              └─ fetch messages → scan for XML patterns
                  ├─ found → send recovery prompt (max 3 attempts)
                  └─ not found → do nothing
              └─ orphan check: busyCount dropped from >1 to 1?
                  └─ 15s watch → abort + continue (continuous retry)

Timer loop (every 5s):
  for each busy session:
    ├─ orphan watch active? → wait or abort+continue (continuous retry w/ backoff)
    ├─ busyCount > 1?
    │   └─ idle > 4x timeout? → check subagents, recover or resume (continuous retry)
    └─ idle > 48s? → hallucination loop? abort : continue with backoff
        └─ continuous retry: 30s → 60s → 120s → 240s → 480s → 600s (cap)

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

> **Note:** `maxRetries` only applies to tool-call-as-text recovery (max 3 attempts). Stream stall recovery retries continuously with exponential backoff and never gives up.

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

| Option | Default | Description |
|---|---|---|
| `chunkTimeoutMs` | `45000` | Inactivity timeout before considering stream stalled |
| `gracePeriodMs` | `3000` | Extra wait before acting (lets ESC/status events arrive) |
| `checkIntervalMs` | `5000` | Timer poll interval |
| `maxRetries` | `3` | Max tool-call-as-text recovery attempts (stall recovery is unlimited) |
| `baseBackoffMs` | `30000` | First retry delay — 30s, doubles each attempt |
| `maxBackoffMs` | `600000` | Backoff cap — 10 minutes |
| `subagentWaitMs` | `15000` | Wait before treating orphan parent as stuck |
| `loopMaxContinues` | `3` | Continues in window before triggering abort |
| `loopWindowMs` | `600000` | Hallucination loop detection window (10 min) |

## Verification

To verify the plugin is loaded:

1. Check OpenCode logs for: `opencode-auto-resume ready. timeout=45000ms...`
2. Let a session idle for 48 seconds — it should auto-resume
3. Check logs for `Stream stall` or `Ready-to-continue pattern detected`

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
| Agent stalls after tool call ends | Expected to auto-recover with continuous retry (30s initial backoff) |
