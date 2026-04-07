# opencode-auto-resume

**Plugin for [OpenCode](https://github.com/opencode-ai/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, and stuck subagent parents. Fully silent, zero UI pollution.**

## What it does

LLM sessions fail in predictable ways. This plugin monitors all sessions and automatically recovers without user intervention.

**Stall recovery** — the stream goes silent but the session stays "busy". The UI shows a blinking cursor with no progress. If no events arrive for 48 seconds, the plugin sends `"continue"` with exponential backoff. After 3 failed attempts it gives up.
_( [#55](https://github.com/opencode-ai/opencode/issues/55), [#199](https://github.com/opencode-ai/opencode/issues/199), [#283](https://github.com/opencode-ai/opencode/issues/283) )_

**Tool calls as raw text** — the model prints tool invocations as raw XML (`<function=edit>...`) instead of executing them. The session goes idle normally but the tool was never run. On idle, the plugin fetches the last messages and scans for XML tool-call patterns (including truncated and alternative formats). If found, it sends a specific recovery prompt.
_( [#150](https://github.com/opencode-ai/opencode/issues/150), [#313](https://github.com/opencode-ai/opencode/issues/313), [#353](https://github.com/opencode-ai/opencode/issues/353) )_

**Hallucination loop** — the model generates the same broken output repeatedly. Each continue just picks up the broken generation. If a session needs 3+ continues within 10 minutes, the plugin aborts the request and sends `"continue"` fresh, forcing a clean restart.
_( [#283](https://github.com/opencode-ai/opencode/issues/283), [#353](https://github.com/opencode-ai/opencode/issues/353) )_

**Orphan parent** — a subagent finishes but the parent session stays stuck as "busy" forever. The plugin detects when busyCount drops from >1 to 1, waits 15 seconds, then aborts and resumes the parent.
_( [#122](https://github.com/opencode-ai/opencode/issues/122), [#199](https://github.com/opencode-ai/opencode/issues/199), [#246](https://github.com/opencode-ai/opencode/issues/246) )_

**False positives during subagent work** — long tool execution or active subagents can look like a stall. Only the session emitting events gets its timer reset (not all sessions). When multiple sessions are busy, stall detection is paused entirely.
_( [#55](https://github.com/opencode-ai/opencode/issues/55), [#221](https://github.com/opencode-ai/opencode/issues/221) )_

**ESC cancel** — user presses ESC to cancel a request. The plugin detects `MessageAbortedError` and marks all busy sessions as cancelled, never resuming them.

**Spurious error messages** — after normal completion, OpenCode sometimes fires a `session.error`. All logging goes through `ctx.client.app.log()` (zero `console.log`), and errors on already-idle sessions are silently ignored.
_( [#128](https://github.com/opencode-ai/opencode/pulls/128), [#22](https://github.com/opencode-ai/opencode/pulls/22) )_

**Session discovery** — periodically calls `session.list()` to pick up sessions that were missed by event tracking. Idle sessions are cleaned up after 10 minutes to prevent memory leaks.

## Architecture

```
Any SSE Event
  ├─ has sessionID? → touchSession(sid) — reset only that session's timer
  └─ no sessionID → ignore

session.status events:
  ├─ busy → reset timer, clear retry counters
  └─ idle → schedule tool-text check (1.5s delay)
              └─ fetch messages → scan for XML patterns
                  ├─ found → send recovery prompt (with backoff)
                  └─ not found → do nothing
              └─ orphan check: busyCount dropped from >1 to 1?
                  └─ 15s watch → abort + continue

Timer loop (every 5s):
  for each busy session:
    ├─ orphan watch active? → wait or abort+continue
    ├─ busyCount > 1? → skip (subagent running)
    └─ idle > 48s? → hallucination loop? abort : continue with backoff

Periodic (every 60s): session.list() to discover missed sessions
Periodic: cleanup idle sessions older than 10min or >50 entries
```

## Installation

### Opencode

```
{
  "plugins": ["opencode-auto-resume@latest"]
}
```

### Manual

```bash
mkdir -p ~/.config/opencode/plugin/opencode-auto-resume
cd ~/.config/opencode/plugin/opencode-auto-resume
# Copy package.json, tsconfig.json, src/ here
bun install
bun run build
```

Register in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOURUSER/.config/opencode/plugins/opencode-auto-resume/dist/index.js"
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

## Manual resume

The plugin exposes a `resume` tool:

```
Please use the resume tool to unstick this session
Please use the resume tool with prompt "try the edit on src/main.js again"
```

## Troubleshooting

| Problem | Solution |
|---|---|
| Resumes after ESC | Increase `gracePeriodMs` to `5000` |
| Too aggressive | Increase `chunkTimeoutMs` to `60000` |
| Too slow to react | Decrease `checkIntervalMs` to `2000` |
| Orphan parent not detected | Increase `subagentWaitMs` to `20000` |
| Hallucination loop not caught | Decrease `loopMaxContinues` to `2` |
| Tool-text not detected | Check server logs — requires SDK message fetching |
