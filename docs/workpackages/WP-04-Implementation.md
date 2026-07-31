# WP-04: Timer Loop Pending Recovery Check

## Executive Summary

**Purpose:** Add pending recovery detection to the timer loop's idle session processing, enabling deferred recovery execution for streaming failures.

**Goal:** When a streaming failure sets `pendingRecovery = true` on a session, the timer loop (5s interval) checks idle sessions for pending recovery and triggers `sendContinuePrompt` when backoff conditions are satisfied.

**Expected Behaviour:** The timer loop's idle session processing block gains a new check at the top of the loop body. When `pendingRecovery = true` and the session is idle (and all guard conditions pass), the timer loop clears `pendingRecovery`, increments `recoveryAttempts`, calls `sendContinuePrompt`, and logs the recovery attempt. Backoff is respected between attempts.

---

## Scope

### Belongs
- Adding a pending recovery check block to the timer loop's second `for` loop (idle session recheck, src/index.ts:1337-1362)
- Checking all guard conditions: `userCancelled`, `aborting`, `continuing`, `gaveUp`
- Backoff validation using `backoffMs(w.recoveryAttempts)`
- Clearing `pendingRecovery` before calling `sendContinuePrompt`
- Incrementing `recoveryAttempts` counter
- Logging the recovery attempt
- Error handling for `sendContinuePrompt` throw

### Does NOT belong
- Modifying the first timer loop (busy session check, src/index.ts:1209-1335)
- Modifying the open todos check (existing, stays unchanged)
- Modifying `backoffMs` function
- Modifying `sendContinuePrompt` function (handled in WP-05)
- Adding new config options
- Adding new logging beyond the recovery attempt message
- Watchdog enhancement (WP-05)
- Unit tests (WP-08)
- Integration tests (WP-09)

---

## Affected Files

### Existing files
- `src/index.ts` — timer loop idle session recheck block (lines 1337-1362)

### New files
- None

### Potential files
- None

---

## Affected Components

| Component | Location | Impact |
|-----------|----------|--------|
| Timer loop (idle recheck) | `src/index.ts:1337-1362` | New pending recovery guard + trigger added |
| `backoffMs` | `src/index.ts:383-385` | Used for recovery backoff (no modification needed) |
| `sendContinuePrompt` | `src/index.ts:426-517` | Called by the new check (no modification needed, handled in WP-05) |
| `SessionWatch` fields | `src/index.ts:20-50` | Reads `pendingRecovery`, `pendingRecoveryAt`, `recoveryAttempts` (added in WP-02) |
| `continuePrompt` | `src/index.ts` (closure variable) | Used as the prompt text for recovery |

---

## Detailed Implementation Steps

### Step 1: Locate the timer loop's idle session recheck
Find the second `for` loop in `startTimer()` at line 1337. This loop iterates over idle sessions and checks for open todos, completion signals, and periodic nudges.

### Step 2: Add pending recovery guard block at the top of the loop body
Insert a new `if` block at the very beginning of the `for` loop body (before the existing `if (w.isSubagent) continue` check at line 1340). The block checks:
- `w.pendingRecovery === true`
- `w.status === "idle"`
- `!w.userCancelled`
- `!w.aborting`
- `!w.continuing`
- `!w.gaveUp`

### Step 3: Add backoff check
Inside the guard block, check if backoff has elapsed:
```
Date.now() - w.pendingRecoveryAt >= backoffMs(w.recoveryAttempts)
```
If backoff has NOT elapsed, skip (the loop continues to the next session, this session will be revisited on the next 5s cycle).

### Step 4: Execute recovery
If backoff has elapsed:
1. Set `w.pendingRecovery = false`
2. Increment `w.recoveryAttempts++`
3. Call `await sendContinuePrompt(sid, continuePrompt, w)` wrapped in try/catch
4. Log: `Pending recovery triggered on ${short(sid)} (attempt ${w.recoveryAttempts}/${maxRetries})`

### Step 5: Continue loop
After the pending recovery block, allow the loop to continue to the existing open todos check. If `pendingRecovery` was set and processed, the session should still be eligible for existing recovery paths (they have their own guards).

### Step 6: Verify ordering
Ensure the new block runs BEFORE the `w.isSubagent` check at line 1340 — subagents should also be recoverable via pending recovery.

### Step 7: Verify the skip condition for backoff
When backoff has not elapsed, the check uses `continue` to skip to the next session. This prevents the open todos recovery from firing during backoff wait, which is correct behaviour — we want to avoid competing recovery mechanisms.

---

## Internal Dependencies

### Must happen first
- Step 1 (locate the loop) — no dependency
- Step 2 (add guard block) — no dependency

### Can happen later
- None — all steps are sequential

### Can happen independently
- None — all steps are in the same function block

---

## External Dependencies

### Required previous WPs
- **WP-02:** Must be implemented first — provides `pendingRecovery`, `pendingRecoveryReason`, `pendingRecoveryAt`, `recoveryAttempts` fields on `SessionWatch`
- **WP-03:** Must be implemented first — sets `pendingRecovery = true` in the `session.error` handler

### Dependent later WPs
- **WP-05:** Uses the `recoveryAttempts` counter for watchdog escalation
- **WP-07:** Adds observability logging for the recovery attempt
- **WP-08:** Tests the timer loop pending recovery check
- **WP-09:** Integration tests exercise this code path

---

## Required Refactoring

- **None required.** The timer loop's idle recheck is a self-contained block. Adding a new guard block at the top is a clean, additive change.

---

## State Changes

### New state transitions managed by this WP

| Current State | Event | New State |
|---------------|-------|-----------|
| `idle` + `pendingRecovery=true` | Timer loop fires, backoff passes | Recovery attempt initiated (`sendContinuePrompt` called) |
| `idle` + `pendingRecovery=true` | Timer loop fires, backoff NOT elapsed | `idle` (skip, wait next cycle) |

### Field changes

| Field | When | Change |
|-------|------|--------|
| `w.pendingRecovery` | Backoff passes, before `sendContinuePrompt` | `true` → `false` |
| `w.recoveryAttempts` | Backoff passes, before `sendContinuePrompt` | Incremented by 1 |

### Lifecycle
The `pendingRecovery` → recovery execution transition is a one-way trip: once cleared, `pendingRecovery` is not re-set by this WP. It can be re-set by WP-03 if a new `session.error` event arrives.

---

## Error Handling

### sendContinuePrompt throws
Wrapped in try/catch. If `sendContinuePrompt` throws:
- `pendingRecovery` is already cleared (set to `false` before the call)
- The error is logged at `warn` level
- Recovery is aborted for this cycle
- The session will need a new `session.error` to re-set `pendingRecovery`

### Backoff calculation overflow
`backoffMs()` already caps at `maxBackoffMs`, so no overflow risk.

### Guard conditions
All guard conditions (`userCancelled`, `aborting`, `continuing`, `gaveUp`) are checked before recovery. These are boolean fields that can change between timer cycles — the check is fresh each cycle.

---

## Logging

### New log entry

| Event | Level | Message | Fields |
|-------|-------|---------|--------|
| Pending recovery triggered | `info` | `Pending recovery triggered on ${short(sid)} (attempt ${w.recoveryAttempts}/${maxRetries})` | session ID, attempt number, max retries |

### Existing log entries this may affect
None. The existing open todos check continues to log independently.

---

## Configuration

### No new config options
This WP reuses:
- `backoffMs()` — existing exponential backoff function
- `maxRetries` — existing constant (default 3)
- `toolTextCheckDelayMs` — used by watchdog (WP-05 reuses this)
- `continuePrompt` — existing prompt text

---

## Test Plan

### Unit Tests (via WP-08)

| Test | Description | Verification |
|------|-------------|--------------|
| Pending recovery triggers on idle session | Set `pendingRecovery=true` on idle session, run timer loop check | `sendContinuePrompt` called |
| Backoff blocks premature recovery | Set `pendingRecoveryAt` to now, backoff not elapsed | `sendContinuePrompt` NOT called |
| Backoff allows recovery after delay | Set `pendingRecoveryAt` to `now - backoffMs(0)` | `sendContinuePrompt` called |
| Guard: userCancelled blocks recovery | Set `userCancelled=true`, `pendingRecovery=true` | Recovery skipped |
| Guard: aborting blocks recovery | Set `aborting=true`, `pendingRecovery=true` | Recovery skipped |
| Guard: continuing blocks recovery | Set `continuing=true`, `pendingRecovery=true` | Recovery skipped |
| Guard: gaveUp blocks recovery | Set `gaveUp=true`, `pendingRecovery=true` | Recovery skipped |
| `pendingRecovery` cleared before prompt | Check value before and after recovery | `false` after recovery |
| `recoveryAttempts` increments | Multiple timer cycles with pending recovery | Count increases |
| Error in sendContinuePrompt | Mock `sendContinuePrompt` to throw | Error logged, no crash |
| Backoff calculated per attempt | Set `recoveryAttempts` to 0, 1, 2 | Backoff increases exponentially |

### Integration Tests (via WP-09)

| Test | Description |
|------|-------------|
| End-to-end: error → pending → idle → timer → recovery | Full lifecycle with mock events |
| Timer loop + backoff timing | Verify recovery happens after correct delay |

### Edge Cases

| Case | Expected |
|------|----------|
| Two sessions with pending recovery same cycle | Both checked independently |
| `pendingRecovery` cleared by concurrent event (e.g. session.busy) | No recovery attempted |
| `recoveryAttempts` at `maxRetries` | Backoff at max, `sendContinuePrompt` still called (watchdog handles escalation) |

### Existing tests that must pass
All existing tests in `src/index.*.test.ts` must continue to pass unchanged.

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| AC-1 | Timer loop detects `pendingRecovery = true` on idle sessions | Unit test: pending recovery triggers |
| AC-2 | Backoff is respected before recovery attempt | Unit test: backoff blocks/ allows |
| AC-3 | `pendingRecovery` cleared before `sendContinuePrompt` | Unit test: field value after recovery |
| AC-4 | Recovery attempt logged with attempt number | Unit test: log output verification |
| AC-5 | No recovery if `userCancelled`, `aborting`, `continuing`, or `gaveUp` | Unit tests: each guard condition |
| AC-6 | Error in `sendContinuePrompt` does not crash timer loop | Unit test: exception handling |
| AC-7 | Recovery attempt count increments correctly | Unit test: `recoveryAttempts` value |
| AC-8 | All existing timer loop functionality preserved | Existing tests pass |

---

## Risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| Ordering conflict with open todos check | The pending recovery check could interfere with the existing open todos recovery | The new check is placed before the open todos check. Both have independent guards. If `pendingRecovery` fires, it clears the flag and calls `sendContinuePrompt`. The subsequent open todos check will see `continuing=true` and skip. |
| `sendContinuePrompt` throws | If the prompt API fails, recovery is lost | Error is caught and logged. The session will need a new `session.error` event to retry. |
| Backoff too long | If `recoveryAttempts` is high, backoff could be 8s (maxBackoffMs) | Acceptable — this is the existing backoff behaviour used by stall recovery. |
| `pendingRecovery` cleared by concurrent event | If `session.status → busy` fires during a timer cycle, `resetSessionFlags` (WP-02) clears `pendingRecovery` | This is correct behaviour — the session is recovering on its own. |

---

## Estimated Review Checklist

- [ ] New guard block added at the top of the idle session recheck loop (line 1337)
- [ ] Guard block checks: `pendingRecovery`, `status === "idle"`, `!userCancelled`, `!aborting`, `!continuing`, `!gaveUp`
- [ ] Backoff check uses `backoffMs(w.recoveryAttempts)` with `Date.now() - w.pendingRecoveryAt`
- [ ] `pendingRecovery` set to `false` before `sendContinuePrompt` call
- [ ] `recoveryAttempts` incremented before `sendContinuePrompt` call
- [ ] `sendContinuePrompt` wrapped in try/catch
- [ ] Recovery attempt logged at `info` level with attempt number and max retries
- [ ] Backoff skip uses `continue` to move to next session
- [ ] Exiting open todos check unchanged
- [ ] No new constants or config options introduced
- [ ] All existing timer loop behaviour preserved
- [ ] Existing test suite passes

---

## Out of Scope

- Watchdog enhancement (WP-05)
- `session.prompt()` return value validation (WP-06)
- Additional logging beyond the recovery attempt message (WP-07)
- New configuration options (WP-01)
- Unit tests for this WP (WP-08)
- Integration tests (WP-09)
- Any modifications to `sendContinuePrompt`, `backoffMs`, or `tryResume` functions
- Any modifications to the first timer loop (busy session processing)

---

## Deliverables

After this WP is complete:

1. Modified `src/index.ts` with the pending recovery guard block added to the timer loop's idle session recheck
2. The guard block correctly checks all conditions and triggers recovery with backoff
3. The existing timer loop behaviour for open todos, completion signals, and all other recovery paths is unchanged
4. All existing tests pass without modification
