# WP-10: Fault Injection Tests - Implementation Plan

## Executive Summary

**Purpose:** Add fault injection tests for edge cases and race conditions to validate the plugin's resilience against API failures, timing issues, and concurrent event handling.

**Goal:** Create comprehensive fault injection test scenarios in `src/index.integration.test.ts` that verify:
- Recovery state is properly cleaned up after failures
- No state leaks or corruption occur under fault conditions
- All fault injection scenarios have defined expected behavior

**Expected Behaviour:** Tests simulate API failures (prompt/abort throwing), race conditions (concurrent events, timer interleaving), and edge cases (empty responses, stale data) to ensure the plugin handles failures gracefully without corrupting internal state.

---

## Scope

### In Scope
- Fault injection tests for `session.prompt()` returning 200 but session stays idle
- Fault injection tests for `session.prompt()` throwing errors
- Fault injection tests for `session.abort()` failing
- Fault injection tests for concurrent `session.error` + `session.status` events
- Fault injection tests for timer loop + event interleaving
- Fault injection tests for session cleanup during pending recovery
- All tests added to `src/index.integration.test.ts` (existing test file)
- Mock patterns using `mock(async () => { throw new Error(...) })` from `bun:test`

### Out of Scope
- Modifying production code (WP-10 is test-only)
- New test infrastructure or utilities
- Performance/load testing
- Modifying existing test patterns
- Adding new test files (uses existing integration test file)

---

## Affected Files

### Existing Files (Modified)
| File | Reason |
|------|--------|
| `src/index.integration.test.ts` | Add all fault injection test suites |

### No New Files
- WP-10 is purely additive to existing test infrastructure

---

## Affected Components

### Test Scenarios (New)
1. **Prompt Returns 200 But Session Stays Idle** - Mock `prompt` resolves successfully but status remains idle
2. **Prompt Throws Error** - Mock `prompt` throws `Error("API failure")`
3. **Abort Fails** - Mock `abort` throws `Error("Abort failed")`
4. **Concurrent Error + Status Events** - Fire `session.error` and `session.status` simultaneously
5. **Timer Loop + Event Interleaving** - Timer fires while events are being processed
6. **Session Cleanup During Pending Recovery** - Cleanup runs while `tryAbortAndResume`/`tryResume` in progress

### Mock Patterns (Reused from existing tests)
```typescript
// Throwing mock
mock(async () => { throw new Error("API failure") })

// Empty response mock
mock(async () => ({}))

// Stale data mock
mock(async () => ({ data: { "session-1": { type: "idle" } } }))
```

---

## Detailed Implementation Steps

### Step 1: Add Prompt Returns 200 But Session Stays Idle Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Prompt Returns 200 But Session Stays Idle", () => {
    test("prompt resolves but status remains idle - recovery state cleaned up", async () => {
        // Setup: session idle, prompt succeeds but no status change
        // Verify: toolTextAttempts incremented, no state corruption
        // Verify: subsequent idle events still processed
    })

    test("prompt resolves but status remains idle - multiple retries", async () => {
        // Setup: session idle, prompt succeeds 3x but status stays idle
        // Verify: toolTextAttempts increments each time
        // Verify: maxRetries respected
        // Verify: gaveUp flag set after exhaustion
    })
})
```

### Step 2: Add Prompt Throws Error Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Prompt Throws Error", () => {
    test("prompt throws - recovery attempt counted, state intact", async () => {
        // Setup: mock prompt throws Error("API failure")
        // Verify: resumeAttempts/toolTextAttempts incremented
        // Verify: lastRetryAt updated for backoff
        // Verify: no crash, session watch remains valid
    })

    test("prompt throws repeatedly - backoff respected", async () => {
        // Setup: prompt throws on each call
        // Verify: backoffMs applied between attempts
        // Verify: no tight loop (timer not starved)
    })

    test("prompt throws during tryAbortAndResume - abort state cleaned", async () => {
        // Setup: abort succeeds, then continue prompt throws
        // Verify: w.aborting reset to false
        // Verify: orphanWatchStartAt cleared
    })
})
```

### Step 3: Add Abort Fails Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Abort Fails", () => {
    test("abort throws - aborting flag reset, no state leak", async () => {
        // Setup: mock abort throws Error("Abort failed")
        // Verify: w.aborting reset to false in catch block
        // Verify: function returns false
        // Verify: session watch still usable for future operations
    })

    test("abort fails during orphan watch - parent not corrupted", async () => {
        // Setup: orphan watch triggers, abort throws
        // Verify: orphanWatchStartAt reset to now (retry later)
        // Verify: parent session watch not corrupted
        // Verify: no crash in timer loop
    })

    test("abort fails during chunkTimeout - retry state intact", async () => {
        // Setup: chunkTimeout triggers tryAbortAndResume, abort throws
        // Verify: resumeAttempts not incremented on abort failure
        // Verify: gaveUp not set prematurely
    })
})
```

### Step 4: Add Concurrent Error + Status Events Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Concurrent Error + Status Events", () => {
    test("session.error + session.status:idle fired simultaneously", async () => {
        // Setup: fire both events in same tick (Promise.all)
        // Verify: error handler runs first (clears busy sessions)
        // Verify: status handler processes idle correctly
        // Verify: no race condition in session state
    })

    test("session.error + session.status:busy fired simultaneously", async () => {
        // Setup: error clears busy, status sets busy
        // Verify: final state is busy (status wins)
        // Verify: userCancelled not stuck true
    })

    test("rapid alternating error/status events", async () => {
        // Setup: fire error, status, error, status rapidly
        // Verify: each event processed atomically
        // Verify: no intermediate state visible to timer
    })
})
```

### Step 5: Add Timer Loop + Event Interleaving Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Timer Loop + Event Interleaving", () => {
    test("timer fires during handleEvent processing", async () => {
        // Setup: slow handleEvent, timer callback runs mid-event
        // Verify: session state consistent (no partial updates)
        // Verify: timer sees either pre-event or post-event state
    })

    test("timer fires during tryResume async chain", async () => {
        // Setup: tryResume in progress, timer checks same session
        // Verify: resumeAttempts not double-counted
        // Verify: backoff logic not bypassed
    })

    test("timer fires during tryAbortAndResume async chain", async () => {
        // Setup: abort+resume in progress, timer checks same session
        // Verify: w.aborting prevents duplicate abort
        // Verify: orphanWatchStartAt not incorrectly modified
    })

    test("multiple timer intervals overlap", async () => {
        // Setup: slow timer iteration, next interval fires before completion
        // Verify: no concurrent iteration on same session
        // Verify: cleanupIdleSessions not run concurrently
    })
})
```

### Step 6: Add Session Cleanup During Pending Recovery Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Session Cleanup During Pending Recovery", () => {
    test("cleanupIdleSessions runs while tryResume pending", async () => {
        // Setup: tryResume started (async), cleanup runs before completion
        // Verify: session not cleaned up (has recent activity)
        // Verify: tryResume completes normally
    })

    test("cleanupIdleSessions runs while tryAbortAndResume pending", async () => {
        // Setup: tryAbortAndResume in progress, cleanup runs
        // Verify: session not cleaned up (aborting = true)
        // Verify: abort+resume completes, state consistent
    })

    test("session removed from map during recovery - no crash", async () => {
        // Setup: manually delete session during recovery, then complete
        // Verify: no unhandled promise rejection
        // Verify: no memory leak (timers cleared)
    })

    test("discoveryTimer finds session during recovery", async () => {
        // Setup: discoverSessions runs while tryResume in progress
        // Verify: ensureWatch returns existing watch (not new)
        // Verify: existing recovery state preserved
    })
})
```

### Step 7: Add Integration Verification Tests
**Location:** `src/index.integration.test.ts` - new describe block

```typescript
describe("Fault Injection: Integration Verification", () => {
    test("full recovery cycle with injected failures", async () => {
        // Scenario: idle -> prompt fails -> abort fails -> retry succeeds
        // Verify: final state = recovered, no orphaned flags
    })

    test("concurrent sessions with mixed fault injection", async () => {
        // Scenario: session A prompt fails, session B abort fails, session C success
        // Verify: each session state isolated
        // Verify: no cross-contamination
    })

    test("timer continues after all fault scenarios", async () => {
        // Scenario: run all fault injections, verify timer still runs
        // Verify: periodic cleanup works
        // Verify: discoveryTimer works
        // Verify: new sessions can be tracked
    })
})
```

---

## Internal Dependencies

### Must Happen First
1. **Step 1-6** (Individual fault scenarios) → **Step 7** (Integration verification)
   - Individual scenarios must pass before combined verification

### Can Happen Independently
- Steps 1-6 can be implemented in any order
- Each describe block is independent

### Must Happen Last
- **Step 7** - Integration verification requires all individual scenarios working

---

## External Dependencies

### Previous WPs Required
- **WP-01 through WP-09** - All plugin functionality must be implemented and stable
- Existing test infrastructure (`src/index.integration.test.ts`) must be functional

### Test Infrastructure Dependencies
- `bun:test` - `describe, test, expect, mock, beforeEach`
- `@opencode-ai/sdk` types for event structures
- Existing `createRealisticContext()` helper

---

## Required Refactoring

### No Refactoring Required
- WP-10 is test-only
- Uses existing mock patterns from integration tests
- No production code changes

---

## State Changes

### Test-Only State Verification
Tests verify these internal states are properly managed during faults:
- `w.aborting` - reset on abort failure
- `w.toolTextAttempts` / `w.resumeAttempts` - incremented correctly
- `w.lastRetryAt` - updated for backoff
- `w.orphanWatchStartAt` - managed during orphan watch faults
- `w.gaveUp` - not set prematurely
- `w.pendingTools` / `w.pendingCommands` - not corrupted
- `sessions` Map - no leaks, entries cleaned up properly
- Timers (`toolTextTimer`, `timer`, `discoveryTimer`) - not leaked

### No Production State Changes
- Zero modifications to `src/index.ts`

---

## Error Handling

### Test Error Scenarios Covered
| Scenario | Expected Handling |
|----------|-------------------|
| `prompt` throws | Caught in `tryResume`/`sendContinuePrompt`, `lastRetryAt` updated, attempt counted |
| `abort` throws | Caught in `tryAbortAndResume`, `w.aborting = false`, returns `false` |
| `messages` throws | Caught in `checkForToolCallAsText`, logged debug, no crash |
| `status` throws | Caught in `getSessionStatusMap`, returns empty map, timer continues |
| Concurrent events | Each `handleEvent` call atomic, no shared mutable state between calls |
| Timer + event race | Session state accessed via `sessions.get(sid)` - atomic Map operations |

---

## Logging

### Test Logging Verification
Tests should verify appropriate log levels:
- `warn` for recoverable failures (prompt/abort throws)
- `debug` for expected internal errors (messages fetch fails)
- `info` for state transitions (retry sent, abort done)
- No `error` level for expected fault injections

---

## Configuration

### Test Configuration
Fault injection tests use aggressive timings:
```typescript
{
    enabled: true,
    checkIntervalMs: 50,        // Fast timer for testing
    subagentWaitMs: 50,
    gracePeriodMs: 0,
    maxRetries: 3,
    toolTextCheckDelayMs: 100,  // Fast tool-text check
    loopMaxContinues: 1,        // Trigger hallucination guard quickly
}
```

---

## Test Plan (Most Detailed)

### Test Matrix

| Test Category | Test Count | Description |
|---------------|------------|-------------|
| Prompt 200/Idle | 2 | Prompt succeeds but no status change |
| Prompt Throws | 3 | Prompt throws various errors |
| Abort Fails | 3 | Abort throws, various contexts |
| Concurrent Events | 3 | Error + Status race conditions |
| Timer Interleaving | 4 | Timer fires during async operations |
| Cleanup During Recovery | 4 | Cleanup runs during pending ops |
| Integration Verification | 3 | Combined scenarios |
| **Total** | **22** | |

### Test Implementation Patterns

#### Pattern 1: Mock Throwing
```typescript
prompt: mock(async () => { throw new Error("API failure") })
```

#### Pattern 2: Mock Empty Response
```typescript
prompt: mock(async () => ({}))
```

#### Pattern 3: Mock Stale Status
```typescript
status: mock(async () => ({ data: { [sid]: { type: "idle" } } }))
```

#### Pattern 4: Concurrent Events
```typescript
await Promise.all([
    hooks.event({ event: { type: "session.error", ... } }),
    hooks.event({ event: { type: "session.status", ... } })
])
```

#### Pattern 5: Timer Interleaving
```typescript
// Slow mock that allows timer to fire
prompt: mock(async () => {
    await new Promise(r => setTimeout(r, 100))
    return {}
})
```

#### Pattern 6: State Verification
```typescript
const w = sessions.get(sid)!
expect(w.toolTextAttempts).toBe(1)
expect(w.aborting).toBe(false)
expect(w.lastRetryAt).toBeGreaterThan(0)
```

### Test Execution
```bash
# Run all tests
bun test

# Run only fault injection tests
bun test --filter "Fault Injection"

# Run with verbose output
bun test --reporter=verbose
```

### Regression Prevention
- All existing tests must continue to pass
- No modifications to existing test describe blocks
- New tests only additive

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | Prompt returns 200 but session stays idle - state cleaned up | Test: `toolTextAttempts` incremented, no flags stuck |
| 2 | Prompt throws error - recovery attempt counted, backoff applied | Test: `resumeAttempts` incremented, `lastRetryAt` updated |
| 3 | Abort fails - `w.aborting` reset, no state leak | Test: `w.aborting === false` after catch |
| 4 | Concurrent error + status events - no race condition | Test: final state consistent, atomic processing |
| 5 | Timer fires during event handling - state consistent | Test: session state either pre or post event, not partial |
| 6 | Timer fires during tryAbortAndResume - no duplicate abort | Test: `w.aborting` prevents re-entry |
| 7 | Cleanup runs during recovery - session not prematurely removed | Test: session remains in Map, recovery completes |
| 8 | All fault scenarios combined - timer continues functioning | Test: periodic cleanup/discovery still work |
| 9 | No state leaks across fault scenarios | Test: `sessions` Map size correct, no orphaned timers |
| 10 | All existing tests still pass | `bun test` passes completely |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Flaky tests due to timing | Medium | High | Use deterministic mocks, avoid real timers where possible |
| Test interference (shared state) | Medium | High | Fresh context per test, no cross-test pollution |
| Missing edge case in production code | Low | High | Tests designed to expose gaps, not just verify |
| Timer tests non-deterministic | Medium | Medium | Use `checkIntervalMs: 50`, mock time where possible |
| Over-mocking hiding real bugs | Low | Medium | Verify mocks match actual SDK interfaces |

---

## Estimated Review Checklist

Reviewer should verify:
- [ ] All 6 fault scenario describe blocks added
- [ ] Integration verification describe block added
- [ ] ~22 new tests total
- [ ] Each test uses proper mock patterns from existing tests
- [ ] Tests verify internal state (not just external behavior)
- [ ] No modifications to `src/index.ts` or other production files
- [ ] No modifications to existing test describe blocks
- [ ] Fresh context created per test (no shared state)
- [ ] Aggressive timings used for fast test execution
- [ ] All tests pass: `bun test`
- [ ] TypeScript compiles: `bun run build`
- [ ] Tests cover all acceptance criteria from EPIC v3
- [ ] Proper cleanup of mocks/timers in tests
- [ ] No console.log/test debugging left in tests

---

## Out of Scope

**WP-10 MUST NOT:**
- Modify any production code (`src/index.ts`)
- Add new test files (uses `src/index.integration.test.ts`)
- Add new test utilities or helpers
- Test performance or load
- Modify existing test patterns or describe blocks
- Add configuration options
- Change any existing functionality

---

## Deliverables

After WP-10 is complete, the following must exist:

### Code
1. ☐ `describe("Fault Injection: Prompt Returns 200 But Session Stays Idle", ...)` with 2 tests
2. ☐ `describe("Fault Injection: Prompt Throws Error", ...)` with 3 tests
3. ☐ `describe("Fault Injection: Abort Fails", ...)` with 3 tests
4. ☐ `describe("Fault Injection: Concurrent Error + Status Events", ...)` with 3 tests
5. ☐ `describe("Fault Injection: Timer Loop + Event Interleaving", ...)` with 4 tests
6. ☐ `describe("Fault Injection: Session Cleanup During Pending Recovery", ...)` with 4 tests
7. ☐ `describe("Fault Injection: Integration Verification", ...)` with 3 tests

### Verification
8. ☐ `bun test` passes (all existing + 22 new tests)
9. ☐ `bun run build` succeeds (TypeScript compiles)
10. ☐ No test flakiness (run 3x to verify)
11. ☐ Code coverage maintained or improved

---

*End of WP-10 Implementation Plan*