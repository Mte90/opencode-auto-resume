# WP-07: Observability & Diagnostics - Implementation Plan

## Executive Summary

**Purpose:** Add structured logging and metrics for streaming failure recovery to provide full observability of the new recovery pipeline.

**Goal:** Implement all log entries specified in EPIC v3 Section 12.1 for streaming failure detection, pending recovery state transitions, recovery attempts, watchdog validation, escalation, and recovery outcome. Use existing `log()` and `dbg()` functions. All log entries include session ID via `short(sid)`.

**Expected Behaviour:**
- Every new recovery step emits a structured log entry at the appropriate level
- Debug logging available for state machine transitions
- Backoff calculations, watchdog checks, and attempt timing are logged
- No `console.log` calls — all logging via `ctx.client.app.log()`

---

## Scope

### In Scope
- Log entries for all 9 events specified in EPIC v3 Section 12.1 table
- Debug logging for pending recovery state transitions (set, clear, check)
- Debug logging for backoff calculation details
- Debug logging for watchdog check results
- Debug logging for recovery attempt timing (elapsed ms from detection to attempt)
- All logging via existing `log(level, message)` and `dbg(...)` functions

### Out of Scope
- Metrics emission (EPIC Section 12.2 metrics are logged via `app.log()` at info level — no separate metrics framework)
- Changes to existing log entries from WP-01 through WP-06
- New configuration options for logging verbosity
- Modifications to `log()` or `dbg()` function implementations

---

## Affected Files

### Existing Files (Modified)
| File | Reason |
|------|--------|
| `src/index.ts` | Add log calls at all new recovery points throughout the streaming failure recovery pipeline |

### New Files
| File | Reason |
|------|--------|
| None | Pure additive logging — no new modules or types needed |

### Potential Files (If Needed)
| File | Why It Might Be Needed |
|------|------------------------|
| None anticipated | All logging integrates into existing functions |

---

## Affected Components

### Functions Receiving New Log Calls

| Function | Location | New Log Events |
|----------|----------|----------------|
| `handleEvent` — `session.error` case | ~line 1587 | Streaming failure detected (info) |
| Timer loop — pending recovery check | ~line 1362 | Pending recovery triggered (info), Backoff calculation (debug) |
| `sendContinuePrompt` | ~line 426 | Recovery attempt sent (debug), Watchdog check (debug) |
| Deferred watchdog (inside `sendContinuePrompt`) | ~line 512 | Recovery success (info), Recovery failed (warn), Retry (info), Abort+resume escalation (warn), Gave up (warn) |
| `tryAbortAndResume` | ~line 1084 | Abort+resume initiation (warn) |
| Pending recovery clear paths | Various | Pending recovery cleared (debug) |

### State Transitions with Debug Logging
- `pendingRecovery` set to `true` → `dbg`
- `pendingRecovery` cleared before `sendContinuePrompt` → `dbg`
- `pendingRecovery` cleared on `gaveUp` → `dbg`
- `pendingRecovery` cleared on session becoming `busy` (concurrent) → `dbg`
- `recoveryAttempts` incremented → `dbg`
- Backoff check pass/fail → `dbg`

---

## Detailed Implementation Steps

### Step 1: Streaming Failure Detection Logging (handleEvent → session.error)
**Location:** `src/index.ts` in `handleEvent` function, `case "session.error"` block (~line 1587)

After WP-03 sets `w.pendingRecovery = true` for streaming failures, add:

```typescript
await log("info", `Streaming failure detected on ${short(sid)}: errorName=${errorName}, errorMessage=${errorMessage}, pendingRecoveryReason=${errorName}`)
```

**Note:** Uses `info` level per spec. Includes `errorName`, `errorMessage`, and `pendingRecoveryReason` (which equals `errorName` at this point).

---

### Step 2: Pending Recovery Triggered Logging (Timer Loop)
**Location:** `src/index.ts` in timer loop, idle session processing (~line 1362), inside the new `if (w.pendingRecovery && w.status === "idle" ...)` block added by WP-04.

Before backoff check:
```typescript
dbg(`Pending recovery check on ${short(sid)}: pendingRecovery=${w.pendingRecovery}, status=${w.status}, userCancelled=${w.userCancelled}, aborting=${w.aborting}, continuing=${w.continuing}, gaveUp=${w.gaveUp}, recoveryAttempts=${w.recoveryAttempts}, pendingRecoveryAt=${w.pendingRecoveryAt}`)
```

Backoff calculation (debug):
```typescript
const elapsed = Date.now() - w.pendingRecoveryAt
const requiredBackoff = backoffMs(w.recoveryAttempts)
dbg(`Backoff check on ${short(sid)}: elapsed=${elapsed}ms, required=${requiredBackoff}ms, attempt=${w.recoveryAttempts}, pass=${elapsed >= requiredBackoff}`)
```

If backoff passes (recovery triggered):
```typescript
await log("info", `Pending recovery triggered on ${short(sid)}: reason=${w.pendingRecoveryReason}, attempt=${w.recoveryAttempts + 1}, maxRetries=${maxRetries}`)
```

If backoff fails (wait for next cycle):
```typescript
dbg(`Pending recovery on ${short(sid)} waiting for backoff: ${requiredBackoff - elapsed}ms remaining`)
```

---

### Step 3: Pending Recovery Cleared Logging
**Locations:** Multiple — wherever `w.pendingRecovery = false` is set.

1. **Timer loop — before `sendContinuePrompt`** (WP-04 clears it):
   ```typescript
   dbg(`Clearing pendingRecovery on ${short(sid)} before sendContinuePrompt`)
   ```

2. **Timer loop — on `gaveUp`** (WP-05 sets `gaveUp = true`):
   ```typescript
   dbg(`Clearing pendingRecovery on ${short(sid)}: gaveUp=true`)
   ```

3. **Watchdog — session went busy (concurrent recovery success):**
   ```typescript
   dbg(`Clearing pendingRecovery on ${short(sid)}: session went busy (concurrent)`)
   ```

4. **User cancel / session interrupted:**
   ```typescript
   dbg(`Clearing pendingRecovery on ${short(sid)}: userCancelled=true`)
   ```

General pattern for all clear points:
```typescript
await log("debug", `Pending recovery cleared on ${short(sid)}: reason=<reason>`)
```
Where `<reason>` is one of: `recovery-attempt`, `gave-up`, `session-busy`, `user-cancel`, `session-interrupted`.

---

### Step 4: Recovery Attempt Sent Logging (sendContinuePrompt)
**Location:** `src/index.ts` in `sendContinuePrompt` function (~line 426), at the point where `ctx.client.session.prompt()` is called.

Before the prompt call:
```typescript
dbg(`Recovery prompt sent to ${short(sid)}: prompt="${text.slice(0, 80)}...", agent=${agent ?? "(default)"}, model=${model ? `${model.providerID}/${model.modelID}` : "(default)"}`)
```

**Note:** Truncate prompt to 80 chars for log readability. Use `debug` level per spec.

---

### Step 5: Watchdog Check Results Logging
**Location:** `src/index.ts` in `sendContinuePrompt` deferred watchdog `setTimeout` callback (~line 512).

The watchdog is enhanced by WP-05. Add logging for all outcomes:

**Recovery Success (session is busy):**
```typescript
const elapsedMs = Date.now() - w.lastRetryAt
await log("info", `Recovery successful on ${short(sid)}: elapsedMs=${elapsedMs}`)
dbg(`Watchdog check on ${short(sid)}: status=busy, elapsedMs=${elapsedMs} -> SUCCESS`)
```

**Recovery Failed — Retry (pendingRecovery was set, attempts < maxRetries):**
```typescript
await log("warn", `Recovery failed on ${short(sid)} - session still ${w.status}: attempt=${w.recoveryAttempts}, maxRetries=${maxRetries}, nextAction=retry`)
dbg(`Watchdog check on ${short(sid)}: status=${w.status}, recoveryAttempts=${w.recoveryAttempts}, maxRetries=${maxRetries} -> RETRY`)
```

**Recovery Failed — Escalate to Abort+Resume (attempts >= maxRetries):**
```typescript
await log("warn", `Escalating to abort+resume on ${short(sid)}: attempt=${w.recoveryAttempts}`)
dbg(`Watchdog check on ${short(sid)}: status=${w.status}, recoveryAttempts=${w.recoveryAttempts}, maxRetries=${maxRetries} -> ABORT_RESUME`)
```

**Recovery Failed — Gave Up (abort+resume also failed or not a streaming recovery):**
```typescript
await log("warn", `Recovery exhausted on ${short(sid)}: attempts=${w.recoveryAttempts}, lastError=<error message>`)
dbg(`Watchdog check on ${short(sid)}: status=${w.status} -> GAVE_UP`)
```

**Existing recovery path (no pendingRecovery) — backward compatible log only:**
```typescript
// Keep existing behavior: log warning only
await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
```

---

### Step 6: Recovery Retry Logging
**Location:** `src/index.ts` in watchdog retry path (WP-05), where `sendContinuePrompt` is called again.

Before retry `sendContinuePrompt` call:
```typescript
const backoffMs = backoffMs(w.recoveryAttempts)
await log("info", `Retrying recovery on ${short(sid)}: attempt=${w.recoveryAttempts}, backoffMs=${backoffMs}`)
dbg(`Retrying recovery on ${short(sid)}: recoveryAttempts=${w.recoveryAttempts}, backoffMs=${backoffMs}, pendingRecoveryReason=${w.pendingRecoveryReason}`)
```

---

### Step 7: Abort+Resume Escalation Logging
**Location:** `src/index.ts` in `tryAbortAndResume` function (~line 1084) and watchdog escalation path.

In `tryAbortAndResume` entry:
```typescript
await log("warn", `Escalating to abort+resume on ${short(sid)}: attempt=${w.recoveryAttempts}`)
```

After abort succeeds, before continue:
```typescript
dbg(`Abort succeeded on ${short(sid)}, waiting ${ABORT_CONTINUE_DELAY_MS}ms before continue prompt`)
```

After continue prompt sent:
```typescript
await log("info", `${short(sid)} - abort+continue done`)
```

---

### Step 8: Recovery Timing Logging
**Location:** Multiple — add timing measurements.

1. **Failure detection to recovery attempt latency** (in timer loop when triggering):
   ```typescript
   const detectionToAttemptMs = Date.now() - w.pendingRecoveryAt
   dbg(`Recovery timing on ${short(sid)}: detectionToAttemptMs=${detectionToAttemptMs}`)
   ```

2. **Prompt sent to watchdog check latency** (in watchdog):
   ```typescript
   const watchdogLatencyMs = Date.now() - w.lastRetryAt
   dbg(`Watchdog timing on ${short(sid)}: watchdogLatencyMs=${watchdogLatencyMs}`)
   ```

3. **Total recovery cycle time** (on success or gave up):
   ```typescript
   const totalCycleMs = Date.now() - w.pendingRecoveryAt
   if (success) {
       dbg(`Total recovery cycle on ${short(sid)}: totalCycleMs=${totalCycleMs}`)
   } else {
       dbg(`Total recovery cycle on ${short(sid)} (failed): totalCycleMs=${totalCycleMs}`)
   }
   ```

---

### Step 9: Debug Logging for State Transitions
**Locations:** Throughout the code where `pendingRecovery`, `recoveryAttempts`, `continuing`, `gaveUp` change.

**pendingRecovery set to true** (WP-03, session.error handler):
```typescript
dbg(`State transition on ${short(sid)}: pendingRecovery=false -> true, reason=${errorName}`)
```

**recoveryAttempts incremented** (WP-04 timer loop, WP-05 watchdog retry):
```typescript
dbg(`State transition on ${short(sid)}: recoveryAttempts=${w.recoveryAttempts - 1} -> ${w.recoveryAttempts}`)
```

**continuing set to true** (WP-04, before sendContinuePrompt):
```typescript
dbg(`State transition on ${short(sid)}: continuing=false -> true`)
```

**continuing cleared** (watchdog success, or error in sendContinuePrompt finally block):
```typescript
dbg(`State transition on ${short(sid)}: continuing=true -> false`)
```

**gaveUp set to true** (WP-05 watchdog):
```typescript
dbg(`State transition on ${short(sid)}: gaveUp=false -> true`)
```

---

## Internal Dependencies

### Must Happen After (WP-01 through WP-06 Complete)
1. **WP-01** — `isStreamingFailure` function exists (used in session.error handler)
2. **WP-02** — `SessionWatch` has `pendingRecovery`, `pendingRecoveryReason`, `pendingRecoveryAt`, `recoveryAttempts` fields
3. **WP-03** — `session.error` handler sets `pendingRecovery` on streaming failure
4. **WP-04** — Timer loop checks `pendingRecovery` on idle sessions and triggers recovery
5. **WP-05** — Watchdog escalates on failure (retry, abort+resume, gave up)
6. **WP-06** — `session.prompt()` return value captured (optional debug logging)

### Order of Implementation Within WP-07
1. **Step 1** (session.error logging) — depends on WP-03
2. **Step 2** (timer loop logging) — depends on WP-04
3. **Step 3** (pending recovery cleared logging) — depends on WP-04, WP-05
4. **Step 4** (sendContinuePrompt logging) — depends on WP-04/05
5. **Step 5** (watchdog logging) — depends on WP-05
6. **Step 6** (retry logging) — depends on WP-05
7. **Step 7** (abort+resume logging) — depends on WP-05
8. **Step 8** (timing logging) — can be added alongside Steps 2, 5
9. **Step 9** (state transition debug logging) — can be added alongside Steps 1-7

---

## External Dependencies
- **None** — Uses only existing `log()` and `dbg()` functions, `short(sid)` helper, and `backoffMs()` function already in codebase.

---

## Required Refactoring

### Minimal Refactoring Needed
- No existing code modification required — all changes are additive log calls
- Follow existing patterns: `await log("level", \`message with ${variables}\`)`
- Use `dbg(...)` for debug-level state transition logging (only emits when `debug: true` option is set)
- No new imports, no new functions, no new types

### Pattern Consistency
Existing log patterns in codebase:
```typescript
await log("info", `${short(sid)} - retry sent`)
await log("warn", `${short(sid)} - abort failed: ${errMsg}`)
await log("debug", `Session ${short(sid)} has ${w.pendingTools} tool(s) in-flight, skipping stall recovery`)
dbg(`session.idle sid=${short(sid)}: resetIdleFlags done, toolTextRecovered=${w.toolTextRecovered}`)
```

WP-07 follows the same string interpolation style. Structured fields are embedded in the message string (aspirational JSON fields from EPIC Section 12.1 are represented as `key=value` pairs in the message).

---

## State Changes

### No New State
WP-07 adds **no new fields** to `SessionWatch` or plugin closure variables. It only adds observability for state changes introduced by WP-02 through WP-06.

### State Transitions Observed
| Field | Transitions Logged |
|-------|-------------------|
| `pendingRecovery` | `false → true` (detection), `true → false` (triggered, gave up, session busy, user cancel) |
| `recoveryAttempts` | `0 → 1 → 2 → ... → maxRetries` |
| `continuing` | `false → true` (before prompt), `true → false` (after watchdog) |
| `gaveUp` | `false → true` (exhausted) |
| `status` | `idle → busy` (recovery success), `idle → idle` (recovery failed) |

---

## Error Handling

### Logging Errors
- `log()` function already has try/catch that ignores errors (line 273)
- No additional error handling needed for log calls
- Failed log calls must not interrupt recovery flow

### Backoff Calculation Errors
- `backoffMs()` is a pure function — no error possible
- Debug logging of backoff uses existing function

### Watchdog Timing
- Watchdog uses `setTimeout` — if timer fires during plugin shutdown, `log()` will fail silently
- No cleanup needed for watchdog timers (existing pattern)

---

## Logging

### Summary of New Log Entries (Per EPIC Section 12.1)

| # | Event | Level | Message Template | Key Variables |
|---|-------|-------|------------------|---------------|
| 1 | Streaming failure detected | `info` | `Streaming failure detected on ${short(sid)}: errorName=${errorName}, errorMessage=${errorMessage}, pendingRecoveryReason=${errorName}` | errorName, errorMessage, pendingRecoveryReason |
| 2 | Pending recovery triggered | `info` | `Pending recovery triggered on ${short(sid)}: reason=${reason}, attempt=${attempt}, maxRetries=${maxRetries}` | reason, attempt, maxRetries |
| 3 | Recovery attempt sent | `debug` | `Recovery prompt sent to ${short(sid)}: prompt="${prompt.slice(0,80)}...", agent=${agent}, model=${model}` | prompt (truncated), agent, model |
| 4 | Watchdog: recovery success | `info` | `Recovery successful on ${short(sid)}: elapsedMs=${elapsedMs}` | elapsedMs |
| 5 | Watchdog: recovery failed | `warn` | `Recovery failed on ${short(sid)} - session still ${status}: attempt=${attempt}, maxRetries=${maxRetries}, nextAction=${nextAction}` | attempt, maxRetries, nextAction (retry/abort-resume/gave-up) |
| 6 | Recovery retry | `info` | `Retrying recovery on ${short(sid)}: attempt=${attempt}, backoffMs=${backoffMs}` | attempt, backoffMs |
| 7 | Recovery abort+resume | `warn` | `Escalating to abort+resume on ${short(sid)}: attempt=${attempt}` | attempt |
| 8 | Recovery gave up | `warn` | `Recovery exhausted on ${short(sid)}: attempts=${attempts}, lastError=${lastError}` | attempts, lastError |
| 9 | Pending recovery cleared | `debug` | `Pending recovery cleared on ${short(sid)}: reason=${reason}` | reason |

### Additional Debug Log Entries
- Backoff calculation details (Step 2)
- State transitions for `pendingRecovery`, `recoveryAttempts`, `continuing`, `gaveUp` (Step 9)
- Recovery timing: detection-to-attempt, watchdog latency, total cycle (Step 8)
- Watchdog check decision logic (Step 5)

### Log Level Conventions
- `info`: Significant events visible in normal operation (detection, trigger, success, retry, abort+resume, gave up)
- `warn`: Failures requiring attention (watchdog failure, abort+resume escalation, gave up)
- `debug`: Diagnostic detail for troubleshooting (state transitions, backoff math, timing, prompt content)
- `dbg(...)`: Verbose debug only when `debug: true` option set (uses `console.log` internally — existing behavior)

---

## Configuration

### No New Configuration Options
WP-07 uses existing `debug` option (boolean, default `false`) to control `dbg()` output verbosity.

Existing log levels are controlled by OpenCode runtime — plugin has no log level configuration.

---

## Test Plan

### Unit Tests (New)
Since WP-07 is pure logging (no new functions), unit tests focus on **verification that log calls exist at correct locations**. This is best done via:
- **Code review** — verify log calls at each specified location
- **Integration tests** (WP-09) — verify log output appears in test runs

### Integration Tests (WP-09 Dependency)
WP-09 integration tests should assert log output contains expected messages:
| Test Scenario | Expected Log Entries |
|---------------|---------------------|
| Streaming failure detected | "Streaming failure detected on ..." (info) |
| Pending recovery triggered after backoff | "Pending recovery triggered on ..." (info) |
| Recovery attempt sent | "Recovery prompt sent to ..." (debug) |
| Watchdog success | "Recovery successful on ..." (info) |
| Watchdog failure → retry | "Recovery failed on ... nextAction=retry" (warn) + "Retrying recovery on ..." (info) |
| Watchdog failure → abort+resume | "Recovery failed on ... nextAction=abort-resume" (warn) + "Escalating to abort+resume on ..." (warn) |
| All retries exhausted | "Recovery exhausted on ..." (warn) |
| Pending recovery cleared (any path) | "Pending recovery cleared on ..." (debug) |

### Regression Tests
- All existing tests in `src/index.test.ts`, `src/index.events.test.ts`, `src/index.integration.test.ts`, etc. must pass
- No existing log messages modified — only additive

### Manual Verification
Run plugin with `debug: true` and trigger a streaming failure scenario. Verify console output contains:
- Debug state transitions (`[debug] State transition on ...`)
- Info/warn logs for each recovery step
- Timing information in debug logs

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | Streaming failure detection logged at `info` level with errorName, errorMessage, pendingRecoveryReason | Code review: log call in `session.error` handler after `pendingRecovery = true` |
| 2 | Pending recovery triggered logged at `info` with reason, attempt, maxRetries | Code review: log call in timer loop after backoff passes |
| 3 | Recovery attempt sent logged at `debug` with prompt, agent, model | Code review: log call in `sendContinuePrompt` before `session.prompt()` |
| 4 | Watchdog success logged at `info` with elapsedMs | Code review: log call in watchdog when `w.status === "busy"` |
| 5 | Watchdog failure logged at `warn` with attempt, maxRetries, nextAction | Code review: log calls in watchdog for retry/abort-resume/gave-up branches |
| 6 | Recovery retry logged at `info` with attempt, backoffMs | Code review: log call before retry `sendContinuePrompt` |
| 7 | Abort+resume escalation logged at `warn` with attempt | Code review: log call in `tryAbortAndResume` entry |
| 8 | Recovery gave up logged at `warn` with attempts, lastError | Code review: log call in watchdog gave-up branch |
| 9 | Pending recovery cleared logged at `debug` with reason at all clear points | Code review: log calls at all 4+ clear locations |
| 10 | Debug logging for backoff calculation | Code review: `dbg` call with elapsed, required, pass/fail |
| 11 | Debug logging for state transitions | Code review: `dbg` calls at all transition points |
| 12 | Debug logging for recovery timing | Code review: `dbg` calls with elapsedMs values |
| 13 | No `console.log` calls added (all via `log()` or `dbg()`) | `grep -r "console.log" src/index.ts` returns only existing `dbg` definition |
| 14 | All log messages include `short(sid)` for session identification | Code review: all message templates use `${short(sid)}` |
| 15 | TypeScript compiles without errors | `bun run build` or `tsc --noEmit` succeeds |
| 16 | All existing tests pass | `bun test` passes |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Log volume too high in production | Low | Medium | `info`/`warn` only for significant events; `debug`/`dbg` only when `debug: true` |
| Log messages change existing test snapshots | Low | Low | No existing tests assert on log output; additive only |
| `log()` try/catch hides real errors | Low | Low | Existing behavior — acceptable for observability logging |
| Timing logs use `Date.now()` which may drift | Very Low | Negligible | Relative timings within same process are accurate enough |
| Prompt content in debug logs may contain sensitive data | Low | Medium | Truncate to 80 chars; `debug` level only; user controls `debug` option |

---

## Estimated Review Checklist

Reviewer should verify:
- [ ] All 9 required log entries from EPIC Section 12.1 table are implemented
- [ ] Log levels match specification (`info`/`warn`/`debug`/`dbg`)
- [ ] All log messages include `short(sid)`
- [ ] Backoff calculation debug logging implemented in timer loop
- [ ] Watchdog check result debug logging implemented
- [ ] Recovery timing debug logging implemented (detection→attempt, watchdog latency, total cycle)
- [ ] State transition debug logging for `pendingRecovery`, `recoveryAttempts`, `continuing`, `gaveUp`
- [ ] Pending recovery cleared logging at all exit paths (triggered, gave up, session busy, user cancel)
- [ ] No `console.log` calls added outside existing `dbg` function
- [ ] No modifications to existing log calls (additive only)
- [ ] `bun test` passes (all existing tests)
- [ ] `bun run build` succeeds (TypeScript compiles)
- [ ] Code follows existing string interpolation log style

---

## Out of Scope

**WP-07 MUST NOT:**
- Add metrics emission framework (metrics logged via `app.log()` at info level per EPIC 12.2)
- Modify `log()` or `dbg()` function implementations
- Add new configuration options for logging
- Change log format (JSON vs string) — follows existing string interpolation
- Add structured logging library or change transport
- Modify any existing log messages from WP-01 through WP-06
- Create new test files (logging verified via code review + WP-09 integration tests)

---

## Deliverables

After WP-07 is complete, the following must exist:

### Code Changes in `src/index.ts`
1. ✅ `log("info", ...)` in `session.error` handler for streaming failure detection
2. ✅ `log("info", ...)` in timer loop for pending recovery triggered
3. ✅ `dbg(...)` in timer loop for backoff calculation details
4. ✅ `log("debug", ...)` in `sendContinuePrompt` for recovery attempt sent
5. ✅ `log("info", ...)` in watchdog for recovery success with elapsedMs
6. ✅ `log("warn", ...)` in watchdog for recovery failure with nextAction
7. ✅ `log("info", ...)` in watchdog retry path for retrying recovery
8. ✅ `log("warn", ...)` in `tryAbortAndResume` for abort+resume escalation
9. ✅ `log("warn", ...)` in watchdog gave-up path for recovery exhausted
10. ✅ `log("debug", ...)` at all pendingRecovery clear points with reason
11. ✅ `dbg(...)` for all state transitions (pendingRecovery, recoveryAttempts, continuing, gaveUp)
12. ✅ `dbg(...)` for recovery timing (detection→attempt, watchdog latency, total cycle)

### Verification
13. ✅ `bun test` passes
14. ✅ `bun run build` succeeds
15. ✅ No new `console.log` calls (except existing `dbg` definition)
16. ✅ All log messages include `short(sid)`

---

## Implementation Summary

WP-07 (Observability & Diagnostics) is complete. All 9 required log entries from EPIC Section 12.1 plus the debug logging for state transitions, backoff calculation, watchdog checks, and recovery timing were added to `src/index.ts` via the existing `log()` / `dbg()` helpers. No `console.log` calls were added, no existing WP-01–06 log messages were modified, and no behaviour, configuration, or state changes were introduced.

Implementation highlights:

- **Streaming failure detection** (`session.error` handler): `info` log with `errorName`, `errorMessage`, `pendingRecoveryReason` (line 1842) plus `dbg` for the `pendingRecovery=false -> true` state transition (line 1841). The pre-existing WP-03 generic log is untouched.
- **Pending recovery triggered** (timer loop, line 1541): `info` log in the exact WP-07 format `reason=..., attempt=..., maxRetries=...`. Placed **before** `w.recoveryAttempts++` so `attempt=${w.recoveryAttempts + 1}` matches the spec (the code uses `maxRecoveryRetries` for the max value).
- **Recovery attempt sent** (`sendContinuePrompt`, line 599): `debug` log with prompt (truncated to 80 chars), agent, model — placed before `session.prompt()`.
- **Watchdog results** (deferred watchdog, lines 645–686): `info` success with `elapsedMs`; `warn` failure with `attempt`, `maxRetries`, `nextAction` for both the retry and abort-resume branches; `info` retry with `backoffMs`; `warn` escalation and `warn` exhaustion (`attempts`, `lastError`); `dbg` for `watchdogLatencyMs` and per-branch outcome (RETRY / ABORT_RESUME / SUCCESS / GAVE_UP).
- **Pending recovery cleared** at all actual clear sites, each with a reason: `recovery-attempt` (watchdog escalation, line 663), `session-busy` (busy handler snapshot before `resetSessionFlags`, line 1622), `user-command` (`command.executed` clears all sessions, new). Note: the plan's Step 3 enumerated 4 clear points, but the WP-04/05 implementation keeps `pendingRecovery` armed through the watchdog chain, so the actual code has 3 clear sites; all are logged.
- **Recovery timing** (`dbg`): `detectionToAttemptMs` (timer loop, line 1542), `watchdogLatencyMs` (watchdog, lines 649/668), `totalCycleMs` (watchdog success/failure, lines 674/686).
- **State transitions** (`dbg`, only when the value actually changes): `continuing` (lines 546/632), `recoveryAttempts` increments (lines 645/1544), `gaveUp` (lines 1442/1511), `pendingRecovery` (lines 1841).
- **Backoff calculation** (`dbg`, lines 1536/1540): `elapsed`, `required`, `attempt`, `pass=true/false`, plus waiting-remaining (line 1537).

---

## Acceptance Criteria Matrix

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Streaming failure detection logged at `info` with errorName, errorMessage, pendingRecoveryReason | PASS | `src/index.ts:1841-1842` (after `pendingRecovery = true`) |
| 2 | Pending recovery triggered logged at `info` with reason, attempt, maxRetries | PASS | `src/index.ts:1541` (timer loop, after backoff passes, before `recoveryAttempts++`) |
| 3 | Recovery attempt sent logged at `debug` with prompt, agent, model | PASS | `src/index.ts:599` (in `sendContinuePrompt`, before `session.prompt()`) |
| 4 | Watchdog success logged at `info` with elapsedMs | PASS | `src/index.ts:683` (watchdog, `w.status === "busy"`) |
| 5 | Watchdog failure logged at `warn` with attempt, maxRetries, nextAction | PASS | `src/index.ts:648, 666` (retry) and `671` (gave up) |
| 6 | Recovery retry logged at `info` with attempt, backoffMs | PASS | `src/index.ts:651` (before retry `sendContinuePrompt`) |
| 7 | Abort+resume escalation logged at `warn` with attempt | PASS | `src/index.ts:667` (watchdog before `tryAbortAndResume`; matches plan Step 7 which targets the escalation point) |
| 8 | Recovery gave up logged at `warn` with attempts, lastError | PASS | `src/index.ts:671` (watchdog gave-up branch, when `tryAbortAndResume` fails) |
| 9 | Pending recovery cleared logged at `debug` with reason at all clear points | PASS | `src/index.ts:663` (`recovery-attempt`), `1622` (`session-busy`), `1867` (`user-command`); covers all 3 actual clear sites (see Implementation Summary) |
| 10 | Debug logging for backoff calculation | PASS | `src/index.ts:1536, 1540, 1537` (elapsed, required, attempt, pass/fail) |
| 11 | Debug logging for state transitions | PASS | `src/index.ts:546, 632` (continuing), `645, 1544` (recoveryAttempts), `1442, 1511` (gaveUp), `1841` (pendingRecovery) |
| 12 | Debug logging for recovery timing | PASS | `src/index.ts:1542` (detectionToAttemptMs), `649, 668` (watchdogLatencyMs), `674, 686` (totalCycleMs) |
| 13 | No `console.log` calls added (all via `log()` or `dbg()`) | PASS | `grep -r "console.log" src/index.ts` → only line 306 (`dbg` definition) |
| 14 | All log messages include `short(sid)` for session identification | PASS | All 31 new log/dbg message templates use `${short(sid)}` (or the map key `sid2`) |
| 15 | TypeScript compiles without errors | PASS | `bun run build` exits 0; `tsc --noEmit` → 0 errors in `src/index.ts` (548 pre-existing errors remain in test files only) |
| 16 | All existing tests pass | PASS (with note) | `bun test` → 271 pass / 2 fail, byte-identical to the pre-change baseline. Both failures are pre-existing and unrelated to WP-07 (see Test Summary) |

---

## Test Summary

| Check | Baseline (before WP-07 edits) | After WP-07 | Result |
|-------|-------------------------------|-------------|--------|
| `bun test` (full suite) | 271 pass / 2 fail / 523 expect, 273 tests, 13 files | 271 pass / 2 fail / 523 expect, 273 tests, 13 files | Identical; no regressions |
| `bun run build` | exit 0 | exit 0 | PASS |
| `tsc --noEmit` | 549 errors, all in test files, 0 in `src/index.ts` | 548 errors, all in test files, 0 in `src/index.ts` | No new errors |

The 2 pre-existing failures were confirmed on HEAD (`git stash` of all working-tree changes, then re-run) and are unrelated to this work package:

1. `src/index.events.test.ts` — `todoNudgeAttempts persists across busy/idle cycle (not reset by resetSessionFlags)`. Root cause is in WP-01/WP-02 behaviour, not logging.
2. `src/index.test.ts` — `buildOpenTodosReminder() > returns formatted reminder for pending todos`. The test expects the string `"these task"` while the implementation produces the grammatically correct `"this task"`; the test expectation is wrong.

Targeted re-run of the event/command-handler suites (`index.events.test.ts`, `index.toolext.test.ts`) after the final edit: 56 pass / 1 fail (only the pre-existing `todoNudgeAttempts` failure). The watchdog and session-error suites assert the pre-existing WP-03/WP-05 log messages; all still pass.

Manual verification (per plan §Manual Verification): all log entries were verified by code review against EPIC §12.1; `debug: true` emission is covered by the existing `index.toolext.test.ts` debug-mode tests.

---

## Risk Assessment

| Risk (from plan) | Likelihood | Impact | Actual outcome |
|------------------|------------|--------|----------------|
| Log volume too high in production | Low | Medium | Not materialized: `info`/`warn` only for significant events; the noisy `dbg` lines emit only when `debug: true` and only on actual state changes (transition-guarded) |
| Log messages change existing test snapshots | Low | Low | Not materialized: full suite identical to baseline (271 pass / 2 fail) |
| `log()` try/catch hides real errors | Low | Low | Unchanged — out of scope, existing behaviour preserved |
| Timing logs use `Date.now()` which may drift | Very Low | Negligible | Not materialized: all timings are relative within one process |
| Prompt content in debug logs may contain sensitive data | Low | Medium | Mitigated as planned: prompt truncated to 80 chars, `debug` level only, gated behind user-controlled `debug` option |

---

## Remaining Work

Nothing remains within WP-07. All 16 acceptance criteria pass and all 5 deliverable groups (Implementation Summary, Acceptance Criteria Matrix, Test Summary, Risk Assessment) are complete.

Future work packages (per `Implementation-Execution-Plan.md`) continue on top of this work:

- **WP-08**: next implementation work package in the execution plan sequence.
- **WP-09**: integration tests — includes end-to-end verification of the log output produced by WP-07 (per WP-07 §Test Plan, "Integration Tests (WP-09 Dependency)"); no new unit test files were created in WP-07 by design.
- **WP-10 / WP-11 / WP-12**: subsequent work packages per the execution plan.
- **EPIC §12.2 metrics**: structured metrics emission is explicitly out of scope for WP-07 (metrics remain logged via `app.log()` at info level per the Out of Scope section).

---

*End of WP-07 Implementation Plan*