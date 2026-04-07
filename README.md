# opencode-auto-resume

Plugin for [OpenCode](https://github.com/opencode-ai/opencode) that automatically detects and recovers from LLM session failures — stalls, broken tool calls, hallucination loops, and stuck subagent parents. Fully silent, zero UI pollution.

---

## Problems it solves

### 1. Streaming stalls and hangs

The model stops generating mid-stream — the SSE connection goes silent, but the session remains marked as "busy". The UI shows a blinking cursor or "waiting for response" with no progress.

**Related upstream issues:**
- [opencode-ai/opencode#55](https://github.com/opencode-ai/opencode/issues/55)
- [opencode-ai/opencode#283](https://github.com/opencode-ai/opencode/issues/283)
- [opencode-ai/opencode#199](https://github.com/opencode-ai/opencode/issues/199)

**Fix:** Monitors all SSE events via a polling timer (every 5s). If no event is received for 45s + 3s grace period, sends `"continue"` with exponential backoff. Gives up after 3 attempts.

### 2. Tool calls printed as raw text instead of being executed

Some models output tool invocations as raw XML instead of using the function calling mechanism. The session goes idle — no stall detected — but the tool was never executed.

**Related upstream issues:**
- [opencode-ai/opencode#353](https://github.com/opencode-ai/opencode/issues/353)
- [opencode-ai/opencode#313](https://github.com/opencode-ai/opencode/issues/313)

**Fix:** When a session goes idle, fetches the last messages and scans for raw XML tool-call patterns. If detected, sends `"continue"`.

### 3. Hallucination loops

The model enters a repetitive cycle. Every "continue" picks up where it left off and hallucinates again.

**Fix:** Tracks continues in a sliding window (10 min). If 3+ continues occur, aborts the request and sends fresh `"continue"` to force a clean restart.

### 4. Orphan parent sessions after subagent completion

After a subagent finishes, the parent session can remain stuck in "busy" state indefinitely.

**Fix:** When busy session count drops from >1 to exactly 1, starts a 15s watch timer. If the parent doesn't resume, aborts and restarts it.

### 5. False positives during tool execution

Long-running tools or subagent work can look like stalls to a naive detector.

**Fix:** Two-layer protection: any event carrying a `sessionID` resets the timer for all busy sessions, and the main stall timer is paused entirely when multiple sessions are busy.

### 6. Spurious error messages

After a model completes normally, the SSE connection closes and OpenCode sometimes fires a spurious `session.error`. Zero `console.log()` calls — all logging goes through `ctx.client.app.log()`.

### 7. ESC key triggering false resume

User-initiated cancellation (`MessageAbortedError`) is detected and all resume attempts are suppressed for that cycle.

---

## Installation

Clone the repository and build:

```bash
git clone https://github.com/Mte90/opencode-auto-resume.git
cd opencode-auto-resume
bun install
bun run build
```

Then add to your `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-auto-resume/dist/index.js"]
}
```

### With custom options

Pass options as the second element of a tuple:

```jsonc
{
  "plugin": [
    ["file:///absolute/path/to/opencode-auto-resume/dist/index.js", {
      "chunkTimeoutMs": 45000,
      "gracePeriodMs": 3000,
      "maxRetries": 3,
      "subagentWaitMs": 15000,
      "loopMaxContinues": 3,
      "loopWindowMs": 600000
    }]
  ]
}
```

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `chunkTimeoutMs` | number | `45000` | Inactivity timeout before considering stream stalled |
| `gracePeriodMs` | number | `3000` | Extra wait before acting |
| `checkIntervalMs` | number | `5000` | Timer poll interval |
| `maxRetries` | number | `3` | Max auto-resume attempts before giving up |
| `baseBackoffMs` | number | `1000` | First retry delay (doubles each attempt) |
| `maxBackoffMs` | number | `8000` | Exponential backoff cap |
| `subagentWaitMs` | number | `15000` | Wait before treating orphan parent as stuck |
| `loopMaxContinues` | number | `3` | Max continues in window before triggering abort |
| `loopWindowMs` | number | `600000` | Time window for hallucination loop detection (10 min) |

---

## Manual resume

The plugin exposes a `resume` tool usable in the chat:

```
Please use the resume tool to unstick this session
```

With a custom prompt:

```
Please use the resume tool with prompt "try the edit on src/main.js again"
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Still resumes after pressing ESC | Increase `gracePeriodMs` to `5000` |
| Too aggressive (resumes too early) | Increase `chunkTimeoutMs` to `60000` |
| Too slow to react | Decrease `checkIntervalMs` to `2000` |
| Interferes with running subagents | Check server logs — subagent detection relies on `session.status` events |
| Orphan parent not detected | Increase `subagentWaitMs` to `20000` |
| Hallucination loop not caught | Decrease `loopMaxContinues` to `2` |

---

## Architecture

### Event flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Any SSE Event                             │
│              (with or without sessionID)                     │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
         has sessionID?              no sessionID → ignore
               │
       ┌───────┴────────┐
       │                │
  session.status    other events
       │                │
  ┌────┴────┐     touchAndPropagate()
  │         │     (reset timer for ALL
 busy     idle    busy sessions)
  │         │
  reset    ┌──┴──────────────┐
  timer    │                 │
           │           tool-text check
           │           (1.5s delay → fetch
           │            messages → scan for
           │            raw XML → continue)
           │
           └──→ orphan check
               (busyCount dropped?
                → 15s watch → abort + continue)
```

### Timer loop (every 5 seconds)

```
for each tracked session:
  ├─ idle / cancelled / aborting → SKIP
  │
  ├─ orphan watch active?
  │   ├─ timeout exceeded → abort() → 2s delay → "continue"
  │   └─ not yet → wait
  │
  ├─ busyCount > 1? → SKIP (subagent running)
  │
  └─ inactivity > 48s?
      ├─ hallucination loop? → abort() → 2s delay → "continue"
      ├─ attempts < maxRetries → "continue" with backoff
      └─ exhausted → give up, log warning
```

---

## License

[GPL-3.0-or-later](LICENSE)
