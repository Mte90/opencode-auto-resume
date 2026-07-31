# Streaming Failure Trace: Why a "Streaming response failed" Event Can Leave the Session Idle Without Starting a New Assistant Run

## Executive Summary

The string `"Streaming response failed"` does **not** appear anywhere in the source code. It is not a literal string emitted by the OpenCode SDK, nor is it a string the plugin searches for. The question of whether it "receives dedicated handling" is therefore moot — it is **not recognized at all**.

The actual runtime error that propagates as a streaming failure is a **generic `session.error` event** whose `error.name` is **not** `"MessageAbortedError"`. The `session.error` handler at `src/index.ts:1587-1616` distinguishes only two cases:

1. `MessageAbortedError` → marks all busy sessions as `userCancelled = true`, preventing any recovery.
2. Everything else → logs the error, resets `pendingTools`/`pendingCommands` to 0, and **returns**. No recovery is triggered.

After `session.error`, the session transitions to `idle` (either via a subsequent `session.status` → `idle` event, or via the timer loop's `getSessionStatusMap()` sync at `src/index.ts:1209-1214`).

Once idle, recovery is **only** triggered by one of five mechanisms (see Section 5 below). The critical finding is that **none** of these mechanisms are designed to detect or recover from a streaming failure specifically. The closest mechanism — the **deferred watchdog** at `src/index.ts:512-516` — detects that the session did not go busy after `session.prompt()`, but it **only logs a warning**. It does not retry, escalate, or trigger any corrective action.

---

## Task 1: Occurrence Inventory

### `session.error`

| Location | Lines | Context |
|----------|-------|---------|
| `handleEvent` case `"session.error"` | `src/index.ts:1587-1616` | Main handler — distinguishes `MessageAbortedError` from all other errors |
| `src/index.events.test.ts` | Lines 315-357 | Test cases for `MessageAbortedError` and non-abort errors |
| `src/index.inflight.test.ts` | Line 152-159 | Test: counters reset on `session.error` (non-abort) |
| `src/index.integration.test.ts` | Line 143-147 | Test: event hook processes `session.error` |
| `src/index.it.test.ts` | Line 139 | Test: `session.error` with `TimeoutError` |
| `docs/architecture/recovery-flow.md` | Line 189 | Documented behavior: MessageAbortedError → all busy cancelled; else log |
| `docs/audits/architecture-audit.md` | Lines 304-324, 564 | Audit: no streaming-failure detection in `session.error` handler |

### `MessageAbortedError`

| Location | Lines | Context |
|----------|-------|---------|
| `handleEvent` case `"session.error"` | `src/index.ts:1590` | `errorName === "MessageAbortedError"` check |
| `src/index.events.test.ts` | Lines 316-335 | Test: MessageAbortedError → all busy sessions marked idle + userCancelled |
| `docs/architecture/recovery-flow.md` | Line 189 | Documented |
| `docs/audits/architecture-audit.md` | Lines 314-320 | Audit: MessageAbortedError prevents all recovery |

### `provider retry`

| Location | Lines | Context |
|----------|-------|---------|
| `handleEvent` case `"session.status"` → `"retry"` | `src/index.ts:1489-1491` | `touchSession(sid)` only; logs "provider retry" |
| `docs/architecture/recovery-flow.md` | Line 187 | Documented: retry → touchSession only |
| `docs/audits/recovery-evidence-audit.md` | Lines 250, 329, 430 | Documented as provider-side retry, transient |

### `retry`

| Location | Lines | Context |
|----------|-------|---------|
| `sendContinuePrompt` catch block | `src/index.ts:491-505` | Single retry on `session.prompt()` failure |
| `tryResume` | `src/index.ts:1128-1169` | Backoff-protected retry with `resumeAttempts` counter |
| `backoffMs()` | `src/index.ts:383-385` | Exponential backoff: `baseBackoffMs * 2^(attempt-1)` |
| `checkForToolCallAsText` | `src/index.ts:784-788` | Backoff check using `toolTextAttempts` |
| Various guards | `src/index.ts:1318-1332`, `1346-1349` | Max retry limits (`maxRetries = 3`) |

### `stream`

| Location | Lines | Context |
|----------|-------|---------|
| Comment at top of file | `src/index.ts:3` | "Detects when an LLM session stalls mid-stream" |
| `checkIntervalMs` constant | `src/index.ts:53` | Timer interval for checking stream activity |
| `chunkTimeoutMs` constant | `src/index.ts:52` | Inactivity timeout before stall detection (45s) |
| No usage of the word "stream" in any logic, error handling, or pattern matching | — | The word "stream" appears only in the file header comment |

### `continue`

| Location | Lines | Context |
|----------|-------|---------|
| `continuePrompt` constant | `src/index.ts:235-236` | Default: `"continue"` |
| `sendContinuePrompt` function | `src/index.ts:426-517` | Sends `session.prompt()` with "continue" text |
| `tryResume` | `src/index.ts:1160` | Calls `sendContinuePrompt(sid, prompt ?? continuePrompt, w)` |
| `tryAbortAndResume` | `src/index.ts:1110` | Calls `sendContinuePrompt(sid, continuePrompt, w)` |
| `checkForToolCallAsText` | `src/index.ts:1065` | Calls `sendContinuePrompt(sid, bestCandidate.prompt, w)` |
| `continueTimestamps` field | `src/index.ts:32, 256-267` | Hallucination loop detection (3 continues in 10min) |

### `abort`

| Location | Lines | Context |
|----------|-------|---------|
| `tryAbortAndResume` | `src/index.ts:1084-1122` | Calls `ctx.client.session.abort({ path: { id: sid } })` |
| `w.aborting` flag | `src/index.ts:29, 288, 706, 1089-1090, 1101, 1114, 1119, 1218, 1264` | Guard against concurrent aborts |
| `ABORT_CONTINUE_DELAY_MS` | `src/index.ts:59` | 2s delay between abort and continue |
| Timer loop abort checks | `src/index.ts:1218, 1226-1238, 1284-1294` | Guards before abort: in-flight tools, active tool calls |

### `session.prompt`

| Location | Lines | Context |
|----------|-------|---------|
| `sendContinuePrompt` primary call | `src/index.ts:477-484` | Primary `session.prompt()` invocation |
| `sendContinuePrompt` retry call | `src/index.ts:495-499` | Single retry on first failure |
| `recoverSubagent` | `src/index.ts:588-591` | `session.prompt()` for subagent recovery |
| Return value | Never checked | `SessionPromptResponses` type returned but discarded |
| `noReply` parameter | Never set | Defaults to `false` (synchronous) |

---

## Task 2: Execution Path from `session.error`

### Call Graph

```
OpenCode Runtime (SSE event)
  ↓
Plugin.event hook (src/index.ts:1667-1673)
  ↓
handleEvent(event)  [fire-and-forget: line 1672, no await]
  │
  ├── getSid(ev)  [src/index.ts:346-358]
  │     Extracts sessionID from ev.sessionID, ev.properties.sessionID, etc.
  │     Returns undefined if not a valid "ses_*" ID
  │
  ├── touchSession(sid)  [src/index.ts:315-320]
  │     Updates lastActivityAt if session is busy and not userCancelled
  │
  ├── switch(type)
  │     │
  │     └── case "session.error":  [src/index.ts:1587-1616]
  │           │
  │           ├── getError(ev)  [src/index.ts:360-366]
  │           │     Extracts error object from ev.error or ev.properties.error
  │           │
  │           ├── errorName = errorObj?.name ?? ""  [line 1589]
  │           │
  │           ├── isMessageAborted = errorName === "MessageAbortedError"  [line 1590]
  │           │
  │           ├── IF isMessageAborted  [line 1592]:
  │           │     │
  │           │     ├── for each [wSid, w] in sessions:  [line 1593]
  │           │     │     IF w.status === "busy":
  │           │     │       w.userCancelled = true  [line 1595]
  │           │     │       w.status = "idle"  [line 1596]
  │           │     │       resetIdleFlags(w)  [line 1597]
  │           │     │
  │           │     └── log("info", "User abort (ESC)")  [line 1600]
  │           │     └── break  [line 1601]
  │           │
  │           └── ELSE (non-MessageAbortedError):
  │                 │
  │                 ├── IF busyCount() === 0:  [line 1604]
  │                 │     └── break  [line 1604]
  │                 │     (Suppressed: no busy sessions, no recovery needed)
  │                 │
  │                 ├── errorMessage = errorObj?.data?.message ?? String(errorObj?.data ?? "")  [lines 1606-1608]
  │                 │
  │                 ├── log("debug", `Session error: ${errorName} - ${errorMessage}`)  [line 1609]
  │                 │
  │                 ├── IF sid:
  │                 │     └── w = sessions.get(sid)  [line 1612]
  │                 │     IF w:
  │                 │       w.pendingTools = 0  [line 1613]
  │                 │       w.pendingCommands = 0  [line 1613]
  │                 │
  │                 └── break  [line 1615]
  │                 (NO session.prompt() called. NO recovery triggered.)
  │
  └── (returns to caller — handleEvent was fire-and-forget)
```

### Function Details

#### `handleEvent(ev: Record<string, unknown>)`
- **Caller:** Plugin `event` hook at `src/index.ts:1667-1673`
- **Callee:** `getSid()`, `touchSession()`, `getError()`, `busyCount()`, `resetIdleFlags()`, `log()`, `sendContinuePrompt()` (indirectly via other paths)
- **Purpose:** Dispatch SSE events to the state machine; update `SessionWatch` state; trigger recovery
- **Conditions:** None — all events are processed
- **Exit paths:** Returns after `switch` completes; fire-and-forget (no await at call site)

#### `getSid(ev: Record<string, unknown>)`
- **Caller:** `handleEvent` at `src/index.ts:1388`
- **Callee:** None (pure function)
- **Purpose:** Extract session ID from event properties
- **Conditions:** Must start with `"ses_"`
- **Exit paths:** Returns `string | undefined`

#### `touchSession(sid: string)`
- **Caller:** `handleEvent` at `src/index.ts:1392`
- **Callee:** `sessions.get()`
- **Purpose:** Update `lastActivityAt` timestamp
- **Conditions:** `w.status === "busy" && !w.userCancelled`
- **Exit paths:** Returns void

#### `getError(ev: Record<string, unknown>)`
- **Caller:** `handleEvent` case `"session.error"` at `src/index.ts:1588`
- **Callee:** None (pure function)
- **Purpose:** Extract error object from event
- **Conditions:** None
- **Exit paths:** Returns `Record<string, unknown> | undefined`

#### `busyCount()`
- **Caller:** `handleEvent` case `"session.error"` at `src/index.ts:1604`, timer loop at `src/index.ts:1206, 1343`, `checkForToolCallAsText` at `src/index.ts:1006`
- **Callee:** Iterates `sessions` map
- **Purpose:** Count sessions that are busy and not userCancelled
- **Conditions:** None
- **Exit paths:** Returns `number`

#### `resetIdleFlags(w: SessionWatch)`
- **Caller:** `session.error` (MessageAbortedError path) at `src/index.ts:1597`, `session.status → idle` at `src/index.ts:1417`, `session.interrupted` at `src/index.ts:1565`, `session.idle` at `src/index.ts:1515`
- **Callee:** None (mutates `w` directly)
- **Purpose:** Reset idle-specific flags: `aborting`, `orphanWatchStartAt`, `idleSince`, `pendingTools`, `pendingCommands`
- **Conditions:** None
- **Exit paths:** Returns void

---

## Task 3: Does "Streaming response failed" Receive Dedicated Handling?

### Classification: **No handling**

**Evidence from source code:**

1. The exact string `"Streaming response failed"` does not appear in any `.ts` source file in the repository. It appears only in documentation files as part of the observed symptom description.

2. The `session.error` handler at `src/index.ts:1587-1616` performs exactly two checks:
   - `errorName === "MessageAbortedError"` (line 1590) → ESC cancel path
   - Everything else → log + reset counters + break (lines 1606-1615)

3. There is no pattern matching, substring check, or error-name comparison for any error name that could correspond to a streaming failure (e.g., `"ProviderError"`, `"APIError"`, `"StreamError"`, `"ConnectionError"`, etc.).

4. The `getError()` function at `src/index.ts:360-366` extracts the error object but only `errorObj.name` is checked. The `errorObj.data.message` is logged at line 1609 but never inspected for recovery-relevant content.

**Conclusion:** A streaming failure that surfaces as `session.error` with a non-`MessageAbortedError` name is treated as a **generic error**. The handler logs it, resets `pendingTools` and `pendingCommands` to 0, and returns. No recovery path is initiated.

---

## Task 4: Decision Points in the `session.error` Handler

### Decision Point 1: `errorName === "MessageAbortedError"` (line 1590)

```
if (isMessageAborted) {
    // Mark ALL busy sessions as userCancelled
    // → Prevents ALL recovery for ALL sessions
    // → break (exit handler)
} else {
    // Fall through to generic error handling
}
```

**Why this branch exists:** `MessageAbortedError` is emitted when the user presses ESC to cancel a request. The plugin must respect user cancellation and prevent any automated recovery from overriding the user's intent.

**Why the else branch exists:** Non-abort errors (timeouts, provider errors, network errors) during active sessions may be transient. The plugin resets in-flight counters to allow the session to potentially recover on the next activity. However, it does **not** initiate recovery — it relies on the timer loop or subsequent idle events.

### Decision Point 2: `busyCount() === 0` (line 1604)

```
if (busyCount() === 0) break
```

**Why this branch exists:** If no sessions are busy, a non-abort error is likely spurious (e.g., a completion-time error on an already-idle session). The README at line 141 confirms: "After normal completion, OpenCode sometimes fires a `session.error`. All logging goes through `ctx.client.app.log()`, and errors on already-idle sessions are silently ignored."

**Why the else branch exists:** If there ARE busy sessions, the error is logged for diagnostic purposes but no recovery is triggered. The session must transition to idle through normal status events before recovery mechanisms can engage.

### Decision Point 3: `sid` exists (line 1611)

```
if (sid) {
    const w = sessions.get(sid)
    if (w) { w.pendingTools = 0; w.pendingCommands = 0 }
}
```

**Why this branch exists:** Reset in-flight tool/command counters if the error is associated with a known session. This prevents stale counters from blocking future recovery (since `hasInflightTools(w)` is a guard in the timer loop).

**Why the else branch exists:** If no session ID can be extracted, there's nothing to reset. The error is already logged.

---

## Task 5: What Triggers `session.prompt()`

There are exactly **three** call sites for `session.prompt()` in the entire codebase:

### Path 1: `sendContinuePrompt` (primary recovery)
- **Origin:** `src/index.ts:477-484`
- **Conditions:** Called by any of these callers:
  - `tryResume` (line 1160) — stall recovery, idle-with-open-todos recovery
  - `checkForToolCallAsText` (line 1065) — tool-text, action-intent, ready-to-continue, done-claim recovery
  - `tryAbortAndResume` (line 1110) — hallucination loop recovery, orphan parent recovery
  - `session.idle` handler (line 1539) — action intent detection
  - `session.status` → idle handler (line 1446) — idle with open todos
- **Timing:** Immediately when recovery condition is met (subject to backoff)
- **Retries:** Single retry on first failure (lines 495-499)
- **Backoff:** Caller-side backoff via `backoffMs()` before calling `sendContinuePrompt`
- **Cancellation:** `w.continuing` guard prevents concurrent sends; `w.userCancelled` prevents all recovery

### Path 2: `sendContinuePrompt` (retry)
- **Origin:** `src/index.ts:495-499`
- **Conditions:** First `session.prompt()` call threw an error
- **Timing:** Immediately after first failure (no delay)
- **Retries:** None — if this fails, the error is re-thrown
- **Cancellation:** Same `w.continuing` guard applies

### Path 3: `recoverSubagent` (subagent-specific)
- **Origin:** `src/index.ts:588-591`
- **Conditions:** Subagent detected as stuck or crashed (lines 1241-1250, 1302-1310)
- **Timing:** Immediately after subagent status check
- **Retries:** None — returns `false` on error
- **Cancellation:** Not guarded by `w.continuing` (separate session)

### Recovery Paths That Can Trigger `session.prompt()`

| # | Path | Entry Point | Trigger Condition | Goes Through `sendContinuePrompt`? |
|---|------|-------------|-------------------|-----------------------------------|
| 1 | Stall Recovery | Timer loop (5s) | `w.status === "busy"`, idle >= 48s, no in-flight tools, no active tool, `resumeAttempts < maxRetries` | YES (via `tryResume`) |
| 2 | Tool-Call-as-Text Recovery | `session.status → idle` or `session.idle` | After 3s delay, message patterns match | YES (via `checkForToolCallAsText`) |
| 3 | Action Intent Recovery | `session.status → idle` or `session.idle` | After 500ms delay, message ends with `:` | YES (via `sendContinuePrompt`) |
| 4 | Idle with Open Todos | `session.status → idle`, `session.idle`, or timer loop | Idle + open todos + `busyCount() === 0` | YES (via `tryResume`) |
| 5 | Hallucination Loop Recovery | `checkForToolCallAsText` or `tryResume` | 3+ continues in 10min window | YES (via `tryAbortAndResume` → `sendContinuePrompt`) |
| 6 | Orphan Parent Recovery | Timer loop | `orphanWatchStartAt` set, timeout exceeded | YES (via `tryAbortAndResume` → `sendContinuePrompt`) |
| 7 | Subagent Stuck Recovery | Timer loop | Subagent stuck/crashed | YES (via `recoverSubagent` → `session.prompt()` directly) |

**Critical finding:** None of these 7 paths are triggered by `session.error` for non-`MessageAbortedError` errors. The `session.error` handler does not call `session.prompt()` or any recovery function. Recovery is only triggered by:
- Timer loop (idle timeout, stall detection, orphan watch, subagent stuck, periodic todo check)
- `session.status` → idle/busy events
- `session.idle` event

---

## Task 6: Can a Provider Streaming Failure Terminate Recovery Before `session.prompt()` Is Executed?

### Answer: **Yes, in multiple ways.**

#### Path A: `session.error` handler suppresses recovery (most direct)

When a streaming failure occurs, if the error propagates as `session.error` with `errorName === "MessageAbortedError"` (which can happen if the stream is aborted), the handler at `src/index.ts:1592-1601` sets `userCancelled = true` on ALL busy sessions. This permanently blocks all recovery paths:

- Timer loop: `if (w.userCancelled) continue` (line 1217)
- `checkForToolCallAsText`: `if (w.userCancelled || w.toolTextRecovered) return` (line 777)
- `tryResume`: Not explicitly checked, but `tryResume` calls `sendContinuePrompt` which checks `w.continuing`, and the session would be idle (not busy), so the timer loop would skip it anyway.

**Location:** `src/index.ts:1592-1601`

#### Path B: `session.error` handler does nothing for non-abort errors

If the streaming failure produces a non-`MessageAbortedError` error, the handler at `src/index.ts:1604-1615` checks `busyCount() === 0`. If there are busy sessions, it logs and resets counters. If there are no busy sessions (the session that failed is now idle), it breaks immediately.

**No recovery is triggered.** The session must rely on the timer loop's stall detection (48s idle timeout) or the `session.status → idle` event to initiate recovery. But if the session was never busy (e.g., the stream failed before the session was marked busy, or the session transitioned to idle before the timer could detect it), the stall recovery path is never reached.

**Location:** `src/index.ts:1604-1615`

#### Path C: Deferred watchdog only logs (passive failure)

Even if `session.prompt()` IS called (via one of the 7 recovery paths), the deferred watchdog at `src/index.ts:512-516` only logs a warning if the session doesn't go busy:

```typescript
setTimeout(async () => {
    if (w.status !== "busy") {
        await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
    }
}, toolTextCheckDelayMs)
```

**This is the single most critical gap.** The watchdog detects that recovery failed (session did not go busy) but takes no corrective action. It does not retry, does not escalate, does not set any state that would trigger a subsequent recovery attempt.

**Location:** `src/index.ts:512-516`

#### Path D: Session transitions to idle before timer can detect stall

The timer loop at `src/index.ts:1216` has the guard `if (w.status !== "busy") continue`. If a streaming failure causes the session to transition from busy → idle before the timer fires (which happens every 5s), the stall detection at `src/index.ts:1314-1334` is never reached for that session. Instead, the session becomes eligible for idle-path recovery (tool-text check, todo nudge, action intent), but these only trigger if specific message patterns are found. A streaming failure that leaves no meaningful assistant message produces no pattern match, so no recovery is triggered.

**Location:** `src/index.ts:1216` (timer loop skips non-busy), `src/index.ts:1314-1334` (stall detection requires busy status)

---

## Task 7: Can `session.prompt()` Complete Successfully While Recovery Is Considered Unsuccessful?

### Answer: **Yes, in multiple scenarios.**

#### Scenario 1: `session.prompt()` returns 200 but no stream starts

The `session.prompt()` API call at `src/index.ts:477-484` returns a `SessionPromptResponses` type (`{ info: AssistantMessage, parts: Part[] }`), but the return value is **never inspected**. The plugin assumes that a successful HTTP response means the stream started. However, the OpenCode server may accept the prompt (return 200) but fail to initiate the LLM stream — for example, if the provider returns an error after the prompt is accepted.

**Evidence:**
- Line 477: `await ctx.client.session.prompt({...})` — return value discarded
- Line 512-516: Deferred watchdog checks `w.status !== "busy"` but only logs
- Architecture audit, Section 5.1: "The `SessionPromptResponses` type returns `{ info, parts }` which is discarded"

#### Scenario 2: `session.prompt()` succeeds but session status is stale

The `sendContinuePrompt` function calls `getSessionMessages()` at `src/index.ts:437` to extract agent/model, then calls `session.prompt()` at `src/index.ts:477`. Between these two calls, the session state could change (another event, another timer iteration, a race with a concurrent `handleEvent`). If the session transitions to a state where the prompt is accepted but not processed (e.g., the session is in a `"retry"` status, or the abort flag was set by another path), the prompt succeeds at the API level but the session never goes busy.

**Evidence:**
- `handleEvent` is fire-and-forget (line 1672: `handleEvent(event)` — no `await`)
- Multiple async recovery paths can interleave (timer loop, tool-text timer, action-intent timer)
- The deferred watchdog (line 512-516) is the only mechanism that could detect this, but it only logs

#### Scenario 3: `session.prompt()` succeeds but the LLM produces no output

The prompt is sent, the server starts a new assistant run, but the LLM immediately produces an empty response or a response that doesn't trigger any activity timestamp updates. The `lastActivityAt` is only updated by:
- `session.status → busy` event (line 1403)
- `tool.execute.before` hook (line 1686)
- `command.execute.before` hook (line 1692)
- `tool.execute.after` hook (line 1700)

If the LLM produces only text output (no tool calls, no commands), the `lastActivityAt` is not updated by tool/command hooks. The only update comes from the `session.status → busy` event. If this event is missed or delayed, the timer loop's stall detection could trigger another recovery attempt, but the `w.continuing` guard prevents concurrent prompts.

**Evidence:**
- `lastActivityAt` update locations: lines 1403, 1686, 1692, 1700
- `w.continuing` guard at `src/index.ts:427-431`
- Stall detection requires `w.lastActivityAt` to be stale (line 1314)

---

## Task 8: Race Conditions

### Race 1: Fire-and-forget `handleEvent` (line 1672)

```typescript
handleEvent(event as Record<string, unknown>)  // No await
```

**Impact:** Multiple SSE events can be dispatched concurrently. For example, `session.error` and `session.status → idle` can interleave. If `session.error` sets `userCancelled = true` on a busy session, and then `session.status → idle` fires, the `resetIdleFlags` at line 1417 does NOT reset `userCancelled` (it only resets `aborting`, `orphanWatchStartAt`, `idleSince`, `pendingTools`, `pendingCommands`). This means the session is permanently blocked from recovery.

**Evidence:** `resetIdleFlags` at `src/index.ts:721-727` — `userCancelled` is NOT in the reset list.

### Race 2: Timer loop + event interleaving

The timer loop at `src/index.ts:1204-1366` runs every 5s and calls `getSessionStatusMap()` to sync statuses. Simultaneously, `handleEvent` can update the same `SessionWatch` entries. For example:

1. Timer loop reads `statusMap[sid]` and sees `"idle"` → sets `w.status = "idle"` (line 1212)
2. Concurrently, `handleEvent` receives `session.status → busy` → calls `resetSessionFlags(w)` (line 1404)
3. Timer loop continues processing the session as idle, potentially triggering idle-path recovery while the session is actually busy

**Evidence:** Line 1211-1214 (status sync in timer) vs. lines 1402-1406 (status update in event handler). No locking mechanism.

### Race 3: Overlapping recovery paths

Three independent paths can all trigger `sendContinuePrompt` on the same session within seconds:

1. **Timer loop** (5s interval) — stall detection at line 1328 calls `tryResume`
2. **`toolTextTimer`** (3s after idle) — `checkForToolCallAsText` at line 1486 calls `sendContinuePrompt`
3. **Action intent timer** (500ms after idle) — line 1475 calls `sendContinuePrompt`

The `w.continuing` guard at `src/index.ts:427-431` prevents concurrent `sendContinuePrompt` calls, but:
- If path 1 sends the prompt and path 2 fires while `w.continuing === true`, path 2 is silently skipped
- If path 1's prompt fails and throws, `w.continuing` is reset in the `finally` block (line 507), and path 2 can then proceed
- The deferred watchdog (line 512-516) fires 3s after the prompt, but by then another recovery path may have already sent another prompt

**Evidence:** Lines 427-431 (continuing guard), 506-510 (finally block resets guard), 512-516 (deferred watchdog).

### Race 4: `tryAbortAndResume` + timer loop

`tryAbortAndResume` at `src/index.ts:1084-1122` sets `w.aborting = true` (line 1090), calls `session.abort()`, waits 2s (`ABORT_CONTINUE_DELAY_MS`), then calls `sendContinuePrompt`. If the timer loop fires during the 2s wait:

1. Timer loop checks `w.aborting` → `continue` (line 1218) — correct, skipped
2. But if the timer loop already passed this check and is processing the session, it may see `w.status === "busy"` (before line 1107 forces it to `"idle"`)
3. The timer loop's stall detection at line 1314-1334 could then trigger `tryResume` on the same session

**Evidence:** Line 1107: `if (w.status === "busy") w.status = "idle"` — this force-set happens AFTER the 2s wait, creating a window where the timer loop sees `busy` and may trigger conflicting recovery.

### Race 5: `session.error` + `MessageAbortedError` + concurrent recovery

If a streaming failure produces a `MessageAbortedError` (which can happen if the stream is aborted mid-flight), the `session.error` handler at `src/index.ts:1592-1601` sets `userCancelled = true` on ALL busy sessions. If another recovery path (e.g., tool-text timer) has already sent `session.prompt()` and is in the `finally` block resetting `w.continuing = false`, the `userCancelled` flag now blocks all future recovery.

**Evidence:** Lines 1593-1599 (MessageAbortedError path sets userCancelled on all busy sessions) vs. line 506-510 (finally block resets continuing).

### Race 6: `toolTextTimer` stale closure

The `toolTextTimer` at `src/index.ts:1484-1487` and `src/index.ts:1551-1554` captures `sid` and `w` by closure. If the session is deleted by `cleanupIdleSessions` (line 388-424) and a new session with the same ID is created, the old timer callback may reference a stale `w` object. While `sessions.get(sid)` is called inside `checkForToolCallAsText`, the `w` parameter passed to the timer is the old reference.

**Evidence:** Line 1486: `checkForToolCallAsText(sid, w)` — `w` is captured at setTimeout creation time.

### Race 7: `getSessionMessages` stale by the time `session.prompt()` is called

In `sendContinuePrompt` at `src/index.ts:437-475`, messages are fetched to extract agent/model, then `session.prompt()` is called at line 477. Between these calls, the session state can change:

- A `session.status → busy` event could arrive, making the prompt a no-op (session already busy)
- A `session.error` with `MessageAbortedError` could arrive, setting `userCancelled = true`
- Another recovery path could send a competing prompt

**Evidence:** Lines 437 (getSessionMessages) and 477 (session.prompt) are separated by agent/model extraction logic, creating a timing window.

### Race 8: `busyCount()` inconsistency

`busyCount()` at `src/index.ts:326-332` iterates all sessions synchronously. But between the call and the subsequent recovery action, sessions can change state (via `handleEvent` which is fire-and-forget). For example:

1. `busyCount()` returns 0 at line 1343 (timer loop periodic todo check)
2. Between that check and the `tryResume` call at line 1357, a new session becomes busy
3. `tryResume` sends `session.prompt()` but the session may now be in an inconsistent state

**Evidence:** Line 1343 (`if (busyCount() !== 0) continue`) vs. line 1357 (`tryResume` call).

---

## Task 9: Failure Trace (Mermaid)

```mermaid
flowchart TD
    subgraph "OpenCode Runtime"
        LLM[LLM Stream]
        SSE[SSE Event Stream]
        SERVER[OpenCode Server]
    end

    subgraph "Plugin: handleEvent"
        HE[handleEvent ev]
        GSID[getSid ev]
        GERR[getError ev]
        ECHECK{errorName ===<br/>MessageAbortedError?}
        BUSY_CHECK{busyCount() === 0?}
        LOG_ERR[log debug:<br/>Session error: name - msg]
        RESET_CNT[w.pendingTools = 0<br/>w.pendingCommands = 0]
        ABORT_ALL[for each busy session:<br/>userCancelled = true<br/>status = idle<br/>resetIdleFlags]
        LOG_ABORT[log info:<br/>User abort ESC]
    end

    subgraph "State After session.error"
        IDLE_STATE[w.status = idle<br/>w.userCancelled = true<br/>or w.userCancelled = false]
        PENDING_TOOLS_RESET[w.pendingTools = 0<br/>w.pendingCommands = 0]
    end

    subgraph "Timer Loop (5s)"
        TIMER[setInterval checkIntervalMs]
        STATUS_SYNC[getSessionStatusMap]
        SYNC_STATUS[w.status = realStatus]
        BUSY_GUARD{w.status === busy?}
        CANCEL_GUARD{w.userCancelled?}
        ABORT_GUARD{w.aborting?}
        ORPHAN_CHECK{orphanWatchStartAt !== null?}
        SUBAGENT_CHECK{numBusy > 1?}
        IDLE_CHECK{idle >= chunkTimeoutMs + gracePeriodMs?}
        INFLIGHT_CHECK{hasInflightTools?}
        ACTIVE_TOOL_CHECK{checkSessionHasActiveTool?}
        RETRY_CHECK{resumeAttempts < maxRetries?}
        HALLUC_CHECK{isHallucinationLoop?}
        TRY_RESUME[tryResume → sendContinuePrompt → session.prompt]
        GAVE_UP[w.gaveUp = true]
        TOOL_TEXT_TIMER[setTimeout 3s → checkForToolCallAsText]
        ACTION_INTENT_TIMER[setTimeout 500ms → action intent check]
        PERIODIC_TODO[periodic idle recheck → tryResume]
        CLEANUP[cleanupIdleSessions]
    end

    subgraph "Recovery Paths"
        TRY_RESUME_FN[tryResume]
        BACKOFF_CHECK{backoff check}
        CHECK_HALLUC{isHallucinationLoop?}
        SEND_PROMPT[sendContinuePrompt → session.prompt]
        RETRY_ONCE[retry session.prompt once]
        DEFERRED_WATCHDOG[setTimeout 3s → check w.status !== busy → LOG ONLY]
        TRY_ABORT[tryAbortAndResume → session.abort → wait 2s → sendContinuePrompt]
    end

    subgraph "Exit Points"
        EXIT_1[No recovery triggered<br/>from session.error handler]
        EXIT_2[Deferred watchdog logs warning<br/>but takes no action]
        EXIT_3[Session stays idle<br/>no new assistant run starts]
        EXIT_4[Timer loop skips session<br/>(status not busy)]
        EXIT_5[All recovery guards pass<br/>but w.continuing = true<br/>(skipped)]
        EXIT_6[session.prompt succeeds<br/>but no stream starts<br/>(return value ignored)]
        EXIT_7[Session.error with<br/>MessageAbortedError →<br/>userCancelled = true<br/>→ ALL recovery blocked]
        EXIT_8[busyCount() === 0<br/>→ session.error breaks early<br/>→ no recovery]
    end

    LLM -- "Streaming response failed" --> SSE
    SSE --> HE
    HE --> GSID
    GSID --> GERR
    GERR --> ECHECK

    ECHECK -- "YES (MessageAbortedError)" --> ABORT_ALL
    ABORT_ALL --> LOG_ABORT
    LOG_ABORT --> EXIT_7

    ECHECK -- "NO (generic error)" --> BUSY_CHECK
    BUSY_CHECK -- "YES (no busy sessions)" --> EXIT_8
    BUSY_CHECK -- "NO (busy sessions exist)" --> LOG_ERR
    LOG_ERR --> RESET_CNT
    RESET_CNT --> EXIT_1

    EXIT_1 --> IDLE_STATE
    IDLE_STATE --> TIMER
    TIMER --> STATUS_SYNC
    STATUS_SYNC --> SYNC_STATUS
    SYNC_STATUS --> BUSY_GUARD

    BUSY_GUARD -- "NO (idle)" --> EXIT_4
    BUSY_GUARD -- "YES (busy)" --> CANCEL_GUARD
    CANCEL_GUARD -- "YES" --> EXIT_5
    CANCEL_GUARD -- "NO" --> ABORT_GUARD
    ABORT_GUARD -- "YES" --> EXIT_5
    ABORT_GUARD -- "NO" --> ORPHAN_CHECK

    ORPHAN_CHECK -- "YES" --> TOOL_TEXT_TIMER
    ORPHAN_CHECK -- "NO" --> SUBAGENT_CHECK
    SUBAGENT_CHECK -- "YES (>1 busy)" --> EXIT_5
    SUBAGENT_CHECK -- "NO" --> IDLE_CHECK

    IDLE_CHECK -- "NO (idle < 48s)" --> EXIT_4
    IDLE_CHECK -- "YES (idle >= 48s)" --> INFLIGHT_CHECK
    INFLIGHT_CHECK -- "YES" --> EXIT_5
    INFLIGHT_CHECK -- "NO" --> ACTIVE_TOOL_CHECK
    ACTIVE_TOOL_CHECK -- "YES" --> EXIT_5
    ACTIVE_TOOL_CHECK -- "NO" --> RETRY_CHECK
    RETRY_CHECK -- "YES" --> TRY_RESUME_FN
    RETRY_CHECK -- "NO" --> GAVE_UP

    TRY_RESUME_FN --> BACKOFF_CHECK
    BACKOFF_CHECK -- "FAIL (within backoff)" --> EXIT_5
    BACKOFF_CHECK -- "PASS" --> CHECK_HALLUC
    CHECK_HALLUC -- "YES" --> TRY_ABORT
    CHECK_HALLUC -- "NO" --> SEND_PROMPT

    SEND_PROMPT --> SESSION_PROMPT[session.prompt()]
    SESSION_PROMPT --> DEFERRED_WATCHDOG
    DEFERRED_WATCHDOG --> EXIT_2
    DEFERRED_WATCHDOG --> EXIT_3

    TRY_ABORT --> SESSION_ABORT[session.abort]
    SESSION_ABORT --> WAIT_2S[wait 2s]
    WAIT_2S --> SEND_PROMPT_2[sendContinuePrompt]
    SEND_PROMPT_2 --> DEFERRED_WATCHDOG_2[setTimeout 3s → check status → LOG ONLY]
    DEFERRED_WATCHDOG_2 --> EXIT_2

    classDef exitPoint fill:#ff6b6b,stroke:#333,stroke-width:2px,color:#fff
    classDef errorPoint fill:#ffa502,stroke:#333,stroke-width:2px,color:#000
    classDef recoveryPoint fill:#4ecdc4,stroke:#333,stroke-width:2px,color:#fff

    class EXIT_1,EXIT_2,EXIT_3,EXIT_4,EXIT_5,EXIT_6,EXIT_7,EXIT_8 exitPoint
    class ECHECK,BUSY_CHECK,HALLUC_CHECK,RETRY_CHECK,INFLIGHT_CHECK,ACTIVE_TOOL_CHECK,BACKOFF_CHECK,CHECK_HALLUC exitPoint
    class SEND_PROMPT,SESSION_PROMPT,TRY_ABORT,SESSION_ABORT,TRY_RESUME_FN,DEFERRED_WATCHDOG recoveryPoint
```

### Exit Point Analysis

| Exit Point | Location | Description |
|------------|----------|-------------|
| **EXIT_1** | `src/index.ts:1615` | `session.error` handler returns without triggering recovery for non-MessageAbortedError |
| **EXIT_2** | `src/index.ts:512-516` | Deferred watchdog detects session not busy but only logs — no corrective action |
| **EXIT_3** | — | Session remains idle indefinitely; no new assistant run starts |
| **EXIT_4** | `src/index.ts:1216` | Timer loop skips session because `w.status !== "busy"` (session already idle) |
| **EXIT_5** | `src/index.ts:427-431`, `1217`, `1218` | Recovery skipped because `w.continuing`, `w.userCancelled`, or `w.aborting` is true |
| **EXIT_6** | `src/index.ts:477-484` | `session.prompt()` returns success but return value is never inspected; no stream verification |
| **EXIT_7** | `src/index.ts:1592-1601` | `MessageAbortedError` sets `userCancelled = true` on all busy sessions, permanently blocking recovery |
| **EXIT_8** | `src/index.ts:1604` | `busyCount() === 0` causes early break; error on idle session is silently ignored |

---

## Task 10: Root Cause Matrix

| Candidate | Evidence | Probability | Why |
|-----------|----------|-------------|-----|
| **RC-1: `session.error` handler does not trigger recovery for streaming failures** | `src/index.ts:1587-1616`: Non-MessageAbortedError errors only log + reset counters. No `session.prompt()` call. No `tryResume`. No `tryAbortAndResume`. | **HIGH** | This is the primary architectural gap. When a streaming failure surfaces as `session.error`, the handler explicitly does NOT initiate any recovery. It relies entirely on the timer loop or subsequent idle events. If the session transitions to idle before the timer's stall detection can fire (48s), and no message patterns match tool-text/action-intent patterns, the session stays idle forever. |
| **RC-2: Deferred watchdog is non-corrective** | `src/index.ts:512-516`: `setTimeout` checks `w.status !== "busy"` but only `log("warn", ...)`. No retry, no escalation, no state change. | **HIGH** | Even if `session.prompt()` IS called (via one of the 7 recovery paths), the only mechanism that could detect a failed recovery (session not going busy) is deliberately non-corrective. This is the single most direct cause of the observed symptom: recovery request sent, no new `session.busy`. |
| **RC-3: `session.prompt()` return value is never validated** | `src/index.ts:477-484`: `await ctx.client.session.prompt({...})` — return value discarded. `SessionPromptResponses` type returns `{ info, parts }` but never inspected. | **HIGH** | The plugin cannot distinguish "prompt accepted by server" from "prompt actually started streaming." If the server returns 200 but the LLM stream fails to start, the plugin has no way to know. The deferred watchdog is the only check, and it only logs. |
| **RC-4: No streaming-failure-specific error detection** | `src/index.ts:1587-1616`: Only checks `errorName === "MessageAbortedError"`. No check for `"ProviderError"`, `"APIError"`, `"StreamError"`, or any streaming-related error name. No substring matching on `errorObj.data.message`. | **MEDIUM** | Even if the handler wanted to trigger recovery for streaming failures, it has no way to distinguish them from other non-abort errors. All non-abort errors are treated identically: log + reset counters + return. |
| **RC-5: Session transitions to idle before timer stall detection** | `src/index.ts:1216`: `if (w.status !== "busy") continue` — timer loop skips idle sessions for stall recovery. Stall detection at `src/index.ts:1314-1334` requires `w.status === "busy"`. | **MEDIUM** | If a streaming failure causes the session to go idle before the next 5s timer tick, the stall recovery path is never reached. The session must then rely on idle-path recovery (tool-text check, action intent, todo nudge), which only triggers if specific message patterns are found. A streaming failure that leaves no meaningful assistant message produces no match. |
| **RC-6: `busyCount() === 0` suppresses session.error** | `src/index.ts:1604`: `if (busyCount() === 0) break` — if no sessions are busy, the error is silently ignored. | **LOW** | If the streaming failure causes the session to transition to idle before the `session.error` event arrives, `busyCount()` may return 0, causing the handler to break early. However, this is a narrow window and depends on event ordering. |
| **RC-7: `w.continuing` guard blocks overlapping recovery** | `src/index.ts:427-431`: `if (w.continuing) { return }` — prevents concurrent `sendContinuePrompt` calls. | **LOW** | If one recovery path sends a prompt and another fires before the first completes, the second is silently skipped. This doesn't prevent recovery entirely, but it can delay it. |
| **RC-8: `userCancelled` set by MessageAbortedError blocks all recovery** | `src/index.ts:1592-1601`: `MessageAbortedError` sets `userCancelled = true` on ALL busy sessions. `resetIdleFlags` and `resetSessionFlags` do NOT reset `userCancelled`. | **LOW** | If a streaming failure produces a `MessageAbortedError` (possible if the stream is aborted mid-flight), all recovery is permanently blocked. The only reset is `resetSessionFlags` on `session.status → busy` (line 1404), which requires the session to become busy again — but it can't become busy if recovery is blocked. |
| **RC-9: Fire-and-forget `handleEvent` allows interleaving** | `src/index.ts:1672`: `handleEvent(event)` — no `await`. Multiple events can interleave. | **LOW** | If `session.error` and `session.status → idle` interleave, `userCancelled` may be set after `resetIdleFlags` has already run, or vice versa. However, `resetIdleFlags` does not reset `userCancelled`, so the net effect is the same as RC-8. |
| **RC-10: No `noReply` parameter on `session.prompt()`** | `src/index.ts:477-484`, `495-499`, `588-591`: `noReply` is never set. Defaults to `false` (synchronous). | **VERY LOW** | The EPIC hypothesized `noReply=true` as a cause. The source code proves this is incorrect. `noReply` is never set, so the prompt API call is synchronous and waits for a response. |

---

## Conclusion

The question "Why can a Streaming response failed event leave the session idle without starting a new assistant run?" is answered by **RC-1** and **RC-2**:

1. **`session.error` handler does not trigger recovery for streaming failures (RC-1):** When a streaming failure surfaces as a `session.error` event, the handler at `src/index.ts:1587-1616` distinguishes only `MessageAbortedError` (ESC cancel) from all other errors. For non-abort errors, it logs the error, resets `pendingTools` and `pendingCommands` to 0, and returns. **No `session.prompt()` is called. No recovery is initiated.** The session must then rely on the timer loop's stall detection (48s idle timeout) or the `session.status → idle` event to trigger recovery.

2. **The deferred watchdog is non-corrective (RC-2):** Even when `session.prompt()` IS called (via one of the 7 recovery paths), the only mechanism that could detect a failed recovery — the deferred watchdog at `src/index.ts:512-516` — only logs a warning. It does not retry, escalate, or trigger any corrective action.

The string `"Streaming response failed"` itself is not recognized anywhere in the codebase. It is not matched, not logged, not handled. It is simply one possible manifestation of a streaming failure that propagates as a generic `session.error` event, which the handler treats as a non-critical error and ignores.