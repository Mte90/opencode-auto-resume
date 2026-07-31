# WP-08: Unit Tests - Implementation Plan

## Executive Summary

**Purpose:** Add comprehensive unit tests for all new functionality introduced in WP-01 through WP-07.

**Goal:** Achieve >95% test coverage for new code with tests following existing patterns in `src/index.it.test.ts`, `src/index.events.test.ts`, and `src/index.inflight.test.ts`.

**Expected Behaviour:**
- All new functions have unit tests with positive and negative cases
- Test coverage >95% for new code paths
- All tests pass with `bun test`
- No modifications to existing test files required

---

## Scope

### In Scope
- Unit tests for `isStreamingFailure()` classification function (WP-01)
- Unit tests for `SessionWatch` pending recovery field initialization and reset (WP-02, WP-03, WP-04)
- Unit tests for pending recovery timer loop check (WP-04, WP-05)
- Unit tests for watchdog escalation logic (WP-05)
- Unit tests for backoff calculation for recovery (WP-02, WP-04)
- Unit tests for state transitions in extended state machine (WP-02 through WP-05)
- Test file organization following existing patterns

### Out of Scope
- Integration tests (covered by WP-09)
- Modification of existing test files
- End-to-end scenario tests
- Performance/load tests

---

## Affected Files

### Existing Test Files (Reference Patterns)
| File | Pattern Used For |
|------|------------------|
| `src/index.it.test.ts` | Core logic / SessionWatch state machine / pure functions / backoff calculations |
| `src/index.events.test.ts` | Event handler tests with `createMockContext()` and `AutoResumePlugin` hooks |
| `src/index.inflight.test.ts` | In-flight tool/command tracking with deterministic mock timers |
| `src/index.integration.test.ts` | End-to-end scenarios (reference only, not modified) |
| `src/index.coverage.test.ts` | Regex pattern coverage (reference only) |

### New Test Files (To Be Created)
| File | Purpose | Test Categories |
|------|---------|-----------------|
| `src/index.streaming-failure.test.ts` | WP-01: `isStreamingFailure()` unit tests | Classification function, config options, edge cases |
| `src/index.session-watch.test.ts` | WP-02/03/04: `SessionWatch` pending recovery fields | Field initialization, reset, state transitions |
| `src/index.pending-recovery.test.ts` | WP-04/05: Timer loop pending recovery logic | Backoff checks, trigger conditions, clearing logic |
| `src/index.watchdog.test.ts` | WP-05: Watchdog escalation logic | Success, retry, abort+resume, gave up paths |
| `src/index.backoff.test.ts` | WP-02/04: Backoff calculation functions | Formula verification, edge cases, config variations |
| `src/index.state-machine.test.ts` | WP-02-05: Extended state machine transitions | All state field transitions, edge cases |

---

## Affected Components

### Functions Requiring Unit Tests (New in WP-01 to WP-07)

| Function/Component | Source WP | Test File | Key Behaviors to Test |
|--------------------|-----------|-----------|----------------------|
| `isStreamingFailure(errorName, errorMessage)` | WP-01 | `index.streaming-failure.test.ts` | Error name matching, message regex patterns, case insensitivity, config overrides, edge cases |
| `SessionWatch.pendingRecovery` field | WP-02 | `index.session-watch.test.ts` | Default `false`, set to `true` on streaming failure, cleared on trigger/gaveUp/busy/userCancel |
| `SessionWatch.pendingRecoveryReason` field | WP-02 | `index.session-watch.test.ts` | Set to error name, persists until cleared |
| `SessionWatch.pendingRecoveryAt` field | WP-02 | `index.session-watch.test.ts` | Set to `Date.now()` on detection, used for backoff |
| `SessionWatch.recoveryAttempts` field | WP-02 | `index.session-watch.test.ts` | Starts at 0, increments on each attempt, resets on new detection |
| `SessionWatch.gaveUp` field | WP-05 | `index.session-watch.test.ts` | Starts `false`, set `true` when exhausted |
| Timer loop pending recovery check | WP-04 | `index.pending-recovery.test.ts` | Only runs when `status === "idle"`, checks `userCancelled`, `aborting`, `continuing`, `gaveUp`, backoff calculation |
| Backoff calculation `backoffMs(attempt)` | WP-02 | `index.backoff.test.ts` | Exponential backoff with cap, configurable base/max |
| `sendContinuePrompt` watchdog | WP-05 | `index.watchdog.test.ts` | Success (busy), retry (< maxRetries), abort+resume (>= maxRetries), gave up |
| `tryAbortAndResume` escalation | WP-05 | `index.watchdog.test.ts` | Called when maxRetries exceeded, logs escalation |
| State transitions: `continuing` flag | WP-04/05 | `index.state-machine.test.ts` | Set before prompt, cleared in watchdog finally/on success |
| State transitions: all `SessionWatch` fields | WP-02-05 | `index.state-machine.test.ts` | Comprehensive transition coverage |

---

## Detailed Implementation Steps

### Step 1: Create `src/index.streaming-failure.test.ts` (WP-01 Tests)

**Pattern:** Follow `src/index.it.test.ts` pure function testing style. Use `describe/test/expect` from `bun:test`.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Acceptance Criteria (4) | Exact spec examples: ProviderError+streaming, MessageAbortedError, TimeoutError+stream, UnknownError |
| Error Name Patterns (5) | Each default name: ProviderError, APIError, StreamError, ConnectionError, TimeoutError |
| Message Patterns (4) | Each default regex: "streaming response failed", "stream.*fail", "connection.*reset", "connection.*closed" |
| Case Insensitivity (2) | UPPERCASE, Mixed Case message matching |
| Negative Cases (3) | Non-matching names, non-matching messages, both non-matching |
| Edge Cases (5) | Empty strings, only name, only message, invalid regex fallback, null/undefined handling |
| Config Override (2) | Custom `streamingFailureErrorNames`, custom `streamingFailureMessagePatterns` |

**Implementation Notes:**
- Import `isStreamingFailure` from `./index`
- Create fresh plugin instance with custom config for config override tests
- Test both exact match (error names) and regex match (messages)
- Verify try/catch fallback for invalid regex patterns

**File Structure:**
```typescript
import { describe, test, expect } from "bun:test"
import { isStreamingFailure } from "./index"

describe("isStreamingFailure()", () => {
  describe("acceptance criteria", () => { /* 4 tests */ })
  describe("error name patterns", () => { /* 5 tests */ })
  describe("message patterns", () => { /* 4 tests */ })
  describe("case insensitivity", () => { /* 2 tests */ })
  describe("negative cases", () => { /* 3 tests */ })
  describe("edge cases", () => { /* 5 tests */ })
  describe("config overrides", () => { /* 2 tests */ })
})
```

---

### Step 2: Create `src/index.session-watch.test.ts` (WP-02/03/04 Tests)

**Pattern:** Follow `src/index.it.test.ts` - use local `Map` and `ensureWatch` helper to test `SessionWatch` state in isolation.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Field Initialization (6) | Default values for all 6 new fields: `pendingRecovery`, `pendingRecoveryReason`, `pendingRecoveryAt`, `recoveryAttempts`, `gaveUp`, `continuing` |
| Field Set on Streaming Failure (3) | `pendingRecovery=true`, `pendingRecoveryReason=errorName`, `pendingRecoveryAt=Date.now()` |
| Field Reset on Recovery Triggered (3) | `pendingRecovery=false`, `recoveryAttempts++`, `continuing=true` |
| Field Reset on Gave Up (2) | `pendingRecovery=false`, `gaveUp=true` |
| Field Reset on Session Busy (2) | `pendingRecovery=false`, `continuing=false` |
| Field Reset on User Cancel (2) | `pendingRecovery=false`, `userCancelled=true` |
| Recovery Attempts Increment (2) | Increments on each retry, resets on new detection |

**Implementation Notes:**
- Recreate the `SessionWatch` interface shape locally (or import if exported)
- Use `ensureWatch(sid)` pattern from `index.it.test.ts`
- Test field mutations directly without full plugin initialization
- Focus on state transitions, not event handlers

**File Structure:**
```typescript
import { describe, test, expect, beforeEach } from "bun:test"

interface SessionWatch {
  // existing fields
  status?: "busy" | "idle"
  lastActivityAt: number
  resumeAttempts: number
  lastRetryAt: number
  // WP-02 new fields
  pendingRecovery: boolean
  pendingRecoveryReason: string | null
  pendingRecoveryAt: number | null
  recoveryAttempts: number
  gaveUp: boolean
  continuing: boolean
  // ... other fields
}

const sessions = new Map<string, SessionWatch>()

function ensureWatch(sid: string): SessionWatch {
  // ... local implementation
}

describe("SessionWatch pending recovery fields", () => {
  beforeEach(() => { sessions.clear() })
  describe("initialization", () => { /* 6 tests */ })
  describe("set on streaming failure", () => { /* 3 tests */ })
  describe("clear on recovery triggered", () => { /* 3 tests */ })
  describe("clear on gave up", () => { /* 2 tests */ })
  describe("clear on session busy", () => { /* 2 tests */ })
  describe("clear on user cancel", () => { /* 2 tests */ })
  describe("recovery attempts counter", () => { /* 2 tests */ })
})
```

---

### Step 3: Create `src/index.pending-recovery.test.ts` (WP-04/05 Tests)

**Pattern:** Follow `src/index.inflight.test.ts` - use `createMockContext()` with FAST config, mock timers via `wait()`.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Timer Loop Guard Conditions (6) | Skips when: not idle, userCancelled, aborting, continuing, gaveUp, no pendingRecovery |
| Backoff Calculation (4) | Elapsed < required (wait), elapsed >= required (trigger), attempt 0, attempt N |
| Recovery Triggered (3) | Logs info, increments recoveryAttempts, sets continuing, clears pendingRecovery |
| Recovery Not Triggered - Backoff (2) | Logs debug with remaining ms, does not increment attempts |
| Pending Recovery Cleared - Multiple Paths (4) | Before sendContinuePrompt, on gaveUp, on session busy, on user cancel |
| Concurrent Session Busy Protection (2) | New busy event clears pendingRecovery, prevents stale recovery |

**Implementation Notes:**
- Use `FAST` config from `index.inflight.test.ts`: `checkIntervalMs: 20, chunkTimeoutMs: 50, gracePeriodMs: 0, baseBackoffMs: 1, maxBackoffMs: 1`
- Mock `ctx.client.session.list()` to return controlled session list
- Use `wait(ms)` for timer advancement
- Test the internal timer loop logic by triggering session status events

**File Structure:**
```typescript
import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

const FAST = {
  checkIntervalMs: 20,
  chunkTimeoutMs: 50,
  gracePeriodMs: 0,
  subagentWaitMs: 100_000,
  maxRetries: 3,
  baseBackoffMs: 1,
  maxBackoffMs: 10,
  loopMaxContinues: 99,
}

function createMockContext(overrides = {}) {
  // ... copy pattern from index.events.test.ts / index.inflight.test.ts
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("Pending recovery timer loop", () => {
  describe("guard conditions", () => { /* 6 tests */ })
  describe("backoff calculation", () => { /* 4 tests */ })
  describe("recovery triggered", () => { /* 3 tests */ })
  describe("recovery not triggered - backoff", () => { /* 2 tests */ })
  describe("pending recovery cleared paths", () => { /* 4 tests */ })
  describe("concurrent session busy protection", () => { /* 2 tests */ })
})
```

---

### Step 4: Create `src/index.watchdog.test.ts` (WP-05 Tests)

**Pattern:** Follow `src/index.inflight.test.ts` - use `createMockContext()` with FAST config, test `sendContinuePrompt` deferred watchdog.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Watchdog Success (3) | Session becomes busy within window, logs info with elapsedMs, clears continuing |
| Watchdog Failure - Retry (4) | Session still idle, attempts < maxRetries, logs warn with nextAction=retry, schedules retry |
| Watchdog Failure - Abort+Resume (4) | Session still idle, attempts >= maxRetries, logs warn with nextAction=abort-resume, calls tryAbortAndResume |
| Watchdog Failure - Gave Up (3) | Abort+resume failed or non-streaming, logs warn with attempts, sets gaveUp |
| Watchdog Legacy Path (2) | No pendingRecovery set, logs existing warn message only |
| Recovery Retry Logging (2) | Logs info with attempt and backoffMs before retry sendContinuePrompt |
| Abort+Resume Escalation (3) | tryAbortAndResume entry logs warn, abort success logs debug, continue sent logs info |

**Implementation Notes:**
- Mock `ctx.client.session.prompt()` to control response
- Mock `ctx.client.session.abort()` for abort+resume path
- Use `wait()` to advance past watchdog timeout (WP-05 uses `WATCHDOG_DELAY_MS = 8000` but test with FAST config)
- Verify `promptCalls` and `abortCalls` arrays for call verification
- Test both streaming recovery (pendingRecovery=true) and legacy stall recovery paths

**File Structure:**
```typescript
import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

const FAST = {
  checkIntervalMs: 20,
  chunkTimeoutMs: 50,
  gracePeriodMs: 0,
  subagentWaitMs: 100_000,
  maxRetries: 2,
  baseBackoffMs: 1,
  maxBackoffMs: 10,
  loopMaxContinues: 99,
  // WP-05 specific
  watchdogDelayMs: 50,  // Override for fast tests
}

function createMockContext(overrides = {}) { /* ... */ }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("Watchdog escalation logic", () => {
  describe("watchdog success", () => { /* 3 tests */ })
  describe("watchdog failure - retry", () => { /* 4 tests */ })
  describe("watchdog failure - abort+resume", () => { /* 4 tests */ })
  describe("watchdog failure - gave up", () => { /* 3 tests */ })
  describe("watchdog legacy path", () => { /* 2 tests */ })
  describe("recovery retry logging", () => { /* 2 tests */ })
  describe("abort+resume escalation", () => { /* 3 tests */ })
})
```

---

### Step 5: Create `src/index.backoff.test.ts` (WP-02/04 Tests)

**Pattern:** Follow `src/index.it.test.ts` - pure function tests for `backoffMs(attempt)`.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Formula Verification (5) | attempt 0 = base, attempt 1 = 2*base, attempt 2 = 4*base, attempt N = 2^N * base |
| Cap Enforcement (3) | Result capped at maxBackoffMs, attempt 10 with small base, attempt 20 with large base |
| Config Variations (4) | Custom baseBackoffMs, custom maxBackoffMs, both custom, defaults |
| Edge Cases (3) | Negative attempt (treated as 0), zero base (returns 0), zero max (returns 0) |
| Integration with Timer Loop (2) | backoffMs used correctly in pending recovery check, recovery retry |

**Implementation Notes:**
- The `backoffMs` function is internal to the plugin closure; test by creating plugin instance with FAST config and accessing via internal state, OR extract the formula to a testable pure function if not already
- If `backoffMs` is not exported, test indirectly via timer loop behavior in `index.pending-recovery.test.ts`
- Add export for `backoffMs` in WP-01/02 implementation if needed for testability

**File Structure:**
```typescript
import { describe, test, expect } from "bun:test"
// If backoffMs is exported:
import { backoffMs } from "./index"
// Otherwise test via plugin instance

describe("Backoff calculation", () => {
  describe("formula verification", () => { /* 5 tests */ })
  describe("cap enforcement", () => { /* 3 tests */ })
  describe("config variations", () => { /* 4 tests */ })
  describe("edge cases", () => { /* 3 tests */ })
  describe("integration", () => { /* 2 tests */ })
})
```

---

### Step 6: Create `src/index.state-machine.test.ts` (WP-02-05 Tests)

**Pattern:** Follow `src/index.it.test.ts` - comprehensive state transition tests using local `SessionWatch` map.

**Test Categories:**

| Category | Tests |
|----------|-------|
| Full State Machine - Streaming Failure Path (8) | Idle → busy → error(streaming) → pendingRecovery=true → idle (backoff pass) → continuing=true → busy (success) → all cleared |
| Full State Machine - Retry Path (6) | ... → continuing=true → idle (watchdog fail) → retry (attempt++) → continuing=true → busy |
| Full State Machine - Abort+Resume Path (6) | ... → maxRetries reached → abort+resume → success/fail |
| Full State Machine - Gave Up Path (4) | ... → all retries exhausted → gaveUp=true → pendingRecovery=false |
| User Cancel Interruption (4) | pendingRecovery set → user interrupted → userCancelled=true → pendingRecovery cleared |
| Concurrent Busy Interruption (3) | pendingRecovery set → new busy event → pendingRecovery cleared |
| Session Created/Updated Reset (3) | session.created resets flags, session.updated preserves recovery state |
| Field Persistence Across Cycles (4) | todoNudgeAttempts, toolTextAttempts persist; recoveryAttempts resets on new detection |

**Implementation Notes:**
- Test the complete state machine flow using local `ensureWatch` helper
- Verify each field transition at each step
- Test edge cases: concurrent events, rapid state changes, maxRetries boundary

**File Structure:**
```typescript
import { describe, test, expect, beforeEach } from "bun:test"

interface SessionWatch {
  // All fields from WP-01 through WP-07
  status?: "busy" | "idle"
  lastActivityAt: number
  resumeAttempts: number
  lastRetryAt: number
  // WP-02
  pendingRecovery: boolean
  pendingRecoveryReason: string | null
  pendingRecoveryAt: number | null
  recoveryAttempts: number
  gaveUp: boolean
  continuing: boolean
  // WP-03/04/05/06/07
  userCancelled: boolean
  aborting: boolean
  toolTextRecovered: boolean
  toolTextAttempts: number
  completionSignaled: boolean
  todoNudgeAttempts: number
  idleSince: number | null
  orphanWatchStartAt: number | null
  isSubagent: boolean
  // ... etc
}

const sessions = new Map<string, SessionWatch>()

function ensureWatch(sid: string): SessionWatch { /* ... */ }

describe("Extended state machine transitions", () => {
  beforeEach(() => { sessions.clear() })
  describe("streaming failure recovery path", () => { /* 8 tests */ })
  describe("retry path", () => { /* 6 tests */ })
  describe("abort+resume path", () => { /* 6 tests */ })
  describe("gave up path", () => { /* 4 tests */ })
  describe("user cancel interruption", () => { /* 4 tests */ })
  describe("concurrent busy interruption", () => { /* 3 tests */ })
  describe("session created/updated reset", () => { /* 3 tests */ })
  describe("field persistence across cycles", () => { /* 4 tests */ })
})
```

---

## Internal Dependencies

### Test File Creation Order (No Runtime Dependencies)

| Step | File | Depends On |
|------|------|------------|
| 1 | `index.streaming-failure.test.ts` | None (pure function) |
| 2 | `index.session-watch.test.ts` | None (local state) |
| 3 | `index.backoff.test.ts` | None (pure function or indirect) |
| 4 | `index.pending-recovery.test.ts` | WP-04 implementation complete |
| 5 | `index.watchdog.test.ts` | WP-05 implementation complete |
| 6 | `index.state-machine.test.ts` | All WP-02-05 implementations complete |

### Required Exports for Testability

The following must be exported from `src/index.ts` (or made testable via plugin instance):

| Export | Purpose | Test File |
|--------|---------|-----------|
| `isStreamingFailure` | Direct unit test | `index.streaming-failure.test.ts` |
| `backoffMs` (if not exported, test via plugin) | Direct unit test | `index.backoff.test.ts` |
| `SessionWatch` interface (if not exported, recreate locally) | Type reference | All state machine tests |
| Plugin factory `AutoResumePlugin` | Integration-style unit tests | `index.pending-recovery.test.ts`, `index.watchdog.test.ts` |

---

## External Dependencies

- **None** - All tests use `bun:test` built-in (`describe`, `test`, `expect`, `mock`, `beforeEach`, `spyOn`)
- **No additional packages** required
- Existing test utilities (`wait`, `createMockContext` pattern) replicated in each test file

---

## Required Refactoring (Testability)

### Minimal Refactoring Needed in `src/index.ts`

| Refactoring | Reason | Impact |
|-------------|--------|--------|
| Export `backoffMs` function | Enable direct unit testing in `index.backoff.test.ts` | Low - pure function, no side effects |
| Export `SessionWatch` interface (or move to `types.ts`) | Type reference for test files | Low - types only |
| Ensure `isStreamingFailure` is exported | Already required by WP-01 spec | None - already planned |

### No Refactoring Required
- No changes to existing functions
- No changes to event handler signatures
- No changes to plugin options interface
- All new test files are additive

---

## State Changes Tested

### SessionWatch Fields (WP-02) - Initialization & Transitions

| Field | Initial Value | Set On Streaming Failure | Cleared On Trigger | Cleared On GaveUp | Cleared On Busy | Cleared On UserCancel |
|-------|---------------|-------------------------|-------------------|-------------------|-----------------|----------------------|
| `pendingRecovery` | `false` | `true` | `false` | `false` | `false` | `false` |
| `pendingRecoveryReason` | `null` | `errorName` | (persists) | `null` | `null` | `null` |
| `pendingRecoveryAt` | `null` | `Date.now()` | (persists) | `null` | `null` | `null` |
| `recoveryAttempts` | `0` | (unchanged) | `++` | (persists) | (unchanged) | (unchanged) |
| `gaveUp` | `false` | `false` | `false` | `true` | `false` | `false` |
| `continuing` | `false` | `false` | `true` | `false` | `false` | `false` |

### Additional Fields (WP-03/04/05/06/07) - Verified in State Machine Tests

| Field | Initial | Key Transitions |
|-------|---------|-----------------|
| `userCancelled` | `false` | `true` on interrupted, cleared on busy |
| `aborting` | `false` | `true` during abort, `false` after |
| `toolTextRecovered` | `false` | `true` on tool recovery success |
| `toolTextAttempts` | `0` | Increment on each tool-text check |
| `completionSignaled` | `false` | `true` on 🏁 or task_complete |
| `todoNudgeAttempts` | `0` | Increment on idle with open todos (persists across busy) |
| `idleSince` | `null` | Set on idle, cleared on busy |
| `orphanWatchStartAt` | `null` | Set when subagent finishes, cleared on recovery |

---

## Error Handling Tested

### isStreamingFailure
- Invalid regex in config patterns → falls back to substring match
- Null/undefined inputs → returns `false`
- Empty strings → returns `false`

### Pending Recovery Timer Loop
- Backoff not met → debug log, no action
- Backoff met but guards fail → no action (userCancelled, aborting, continuing, gaveUp)
- sendContinuePrompt throws → continuing cleared in finally, pendingRecovery NOT cleared (retry next cycle)

### Watchdog
- session.prompt() throws → caught, logged, continuing cleared, pendingRecovery preserved for retry
- session.abort() throws → caught, logged, aborting=false, returns false
- Watchdog timeout fires during shutdown → log fails silently (existing log() try/catch)

---

## Logging Tested

**Note:** WP-07 adds logging but no new functions. Logging verified via:
- Code review (log calls at correct locations)
- WP-09 integration tests (assert log output)

**Unit Test Scope for Logging:**
- `index.pending-recovery.test.ts`: Verify debug/info/warn calls via mocked `ctx.client.app.log`
- `index.watchdog.test.ts`: Verify debug/info/warn calls via mocked `ctx.client.app.log`

---

## Configuration Tested

| Config Option | Test File | Scenarios |
|---------------|-----------|-----------|
| `streamingFailureErrorNames` | `index.streaming-failure.test.ts` | Custom array overrides defaults |
| `streamingFailureMessagePatterns` | `index.streaming-failure.test.ts` | Custom regex patterns |
| `baseBackoffMs` | `index.backoff.test.ts`, `index.pending-recovery.test.ts` | Affects backoff formula |
| `maxBackoffMs` | `index.backoff.test.ts`, `index.pending-recovery.test.ts` | Caps backoff |
| `maxRetries` | `index.pending-recovery.test.ts`, `index.watchdog.test.ts` | Limits recovery attempts |
| `watchdogDelayMs` (WP-05) | `index.watchdog.test.ts` | Timing of watchdog check |

---

## Test Plan Summary

### New Test Files (6 files, ~150-200 tests total)

| File | Est. Tests | Focus |
|------|------------|-------|
| `src/index.streaming-failure.test.ts` | 25 | WP-01 classification function |
| `src/index.session-watch.test.ts` | 20 | WP-02/03/04 SessionWatch fields |
| `src/index.pending-recovery.test.ts` | 20 | WP-04/05 timer loop logic |
| `src/index.watchdog.test.ts` | 25 | WP-05 escalation logic |
| `src/index.backoff.test.ts` | 15 | WP-02/04 backoff calculation |
| `src/index.state-machine.test.ts` | 35 | WP-02-05 full state transitions |

### Coverage Targets
- **New functions**: 100% (isStreamingFailure, backoffMs)
- **New SessionWatch fields**: 100% initialization and all transitions
- **Timer loop branches**: >95% (all guard conditions, backoff pass/fail, trigger paths)
- **Watchdog branches**: >95% (success, retry, abort+resume, gave up, legacy)
- **State machine paths**: >95% (all major recovery paths + edge cases)

### Test Execution
```bash
# Run all tests
bun test

# Run only new unit tests
bun test src/index.streaming-failure.test.ts
bun test src/index.session-watch.test.ts
bun test src/index.backoff.test.ts
bun test src/index.pending-recovery.test.ts
bun test src/index.watchdog.test.ts
bun test src/index.state-machine.test.ts

# Verify coverage
bun test --coverage
```

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `isStreamingFailure()` has unit tests covering all acceptance criteria + edge cases | `bun test src/index.streaming-failure.test.ts` passes |
| 2 | SessionWatch pending recovery fields tested for init, set, clear on all paths | `bun test src/index.session-watch.test.ts` passes |
| 3 | Pending recovery timer loop backoff logic tested (pass/fail/guards) | `bun test src/index.pending-recovery.test.ts` passes |
| 4 | Watchdog escalation tested: success, retry, abort+resume, gave up | `bun test src/index.watchdog.test.ts` passes |
| 5 | Backoff calculation formula and caps verified | `bun test src/index.backoff.test.ts` passes |
| 6 | Extended state machine transitions tested for all recovery paths | `bun test src/index.state-machine.test.ts` passes |
| 7 | Overall test coverage >95% for new code | `bun test --coverage` shows >95% on new files |
| 8 | All existing tests still pass | `bun test` passes (no regressions) |
| 9 | No modifications to existing test files | `git diff src/*.test.ts` shows only new files |
| 10 | TypeScript compiles without errors | `bun run build` or `tsc --noEmit` succeeds |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `backoffMs` not exported, cannot test directly | Medium | Low | Test indirectly via timer loop in `index.pending-recovery.test.ts` |
| `SessionWatch` interface not exported, type mismatch in tests | Low | Low | Recreate interface locally in test file (pattern from `index.it.test.ts`) |
| Timer loop internal logic not easily testable | Medium | Medium | Use FAST config + `wait()` to drive timer ticks via event simulation |
| Watchdog delay too long for unit tests | Low | Low | Override `watchdogDelayMs` in FAST config (WP-05 should expose this) |
| Mock context complexity for integration-style unit tests | Medium | Medium | Copy proven `createMockContext` pattern from `index.events.test.ts` |
| Flaky tests due to async timing | Low | Medium | Use deterministic `wait()` with FAST config, avoid real timers |

---

## Estimated Review Checklist

Reviewer should verify:
- [ ] All 6 new test files created with appropriate test counts
- [ ] Test patterns follow `index.it.test.ts` (pure logic) and `index.events.test.ts` / `index.inflight.test.ts` (mock context)
- [ ] `isStreamingFailure` tests cover all 4 acceptance criteria + 21 additional cases
- [ ] SessionWatch field tests cover all 6 fields × all transition paths
- [ ] Timer loop tests cover all 6 guard conditions + backoff pass/fail
- [ ] Watchdog tests cover all 4 outcome branches + legacy path
- [ ] Backoff tests verify formula, cap, config variations, edge cases
- [ ] State machine tests cover 4 major recovery paths + 4 edge case categories
- [ ] All tests use `mock()` from `bun:test` for ctx.client.session.prompt/abort
- [ ] All tests use `wait(ms)` for async timing (no real setTimeout)
- [ ] `bun test` passes with zero failures
- [ ] `bun test --coverage` shows >95% on new code
- [ ] `bun run build` succeeds (TypeScript compiles)
- [ ] No existing test files modified

---

## Out of Scope

**WP-08 MUST NOT:**
- Create integration tests (WP-09)
- Modify existing test files (`index.test.ts`, `index.events.test.ts`, `index.integration.test.ts`, etc.)
- Add test utilities/helpers outside test files
- Test logging output (verified in WP-09)
- Test configuration validation (no validation exists)
- Test performance or load scenarios
- Add snapshot testing

---

## Deliverables

After WP-08 is complete, the following must exist:

### New Test Files (6)
1. ✅ `src/index.streaming-failure.test.ts` - 25 tests for WP-01
2. ✅ `src/index.session-watch.test.ts` - 20 tests for WP-02/03/04
3. ✅ `src/index.pending-recovery.test.ts` - 20 tests for WP-04/05
4. ✅ `src/index.watchdog.test.ts` - 25 tests for WP-05
5. ✅ `src/index.backoff.test.ts` - 15 tests for WP-02/04
6. ✅ `src/index.state-machine.test.ts` - 35 tests for WP-02-05

### Verification
7. ✅ `bun test` passes (all existing + new tests)
8. ✅ `bun test --coverage` shows >95% coverage on new code
9. ✅ `bun run build` succeeds (TypeScript compiles)
10. ✅ No modifications to existing test files (`git status` shows only new test files)

---

*End of WP-08 Implementation Plan*