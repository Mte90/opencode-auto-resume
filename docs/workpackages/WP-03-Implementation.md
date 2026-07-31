# WP-03 Implementation Plan: Extended session.error Handler

## Executive Summary

Extend the `session.error` handler in `src/index.ts` (lines 1587-1616) to classify streaming failures using the `isStreamingFailure` function from WP-01 and set pending recovery state fields from WP-02 when a streaming failure occurs on an active session with a valid session ID.

## Scope

**In Scope:**
- Modify `handleEvent` case `"session.error"` in `src/index.ts` (lines 1587-1616)
- Add streaming failure detection after `MessageAbortedError` check but before `busyCount() === 0` check
- Set `w.pendingRecovery`, `w.pendingRecoveryReason`, `w.pendingRecoveryAt` on streaming failure with valid `sid`
- Log warning when streaming failure occurs without valid `sid`
- Preserve existing behavior for `MessageAbortedError`, generic errors, and idle sessions

**Out of Scope:**
- Implementation of `isStreamingFailure` (WP-01)
- Definition of `Watch` type fields (WP-02)
- Recovery execution logic (WP-04+)
- Configuration changes

## Affected Files

| File | Lines | Change Type |
|------|-------|-------------|
| `src/index.ts` | 1587-1616 | Modify `session.error` case in `handleEvent` |
| `src/index.ts` | Import section | Import `isStreamingFailure` from WP-01 |

## Affected Components

| Component | Location | Change Type |
|-----------|----------|-------------|
| `handleEvent` function | `src/index.ts:1587` | Modify `session.error` case |
| `Watch` type | `src/index.ts` (WP-02) | Uses new fields from WP-02 |
| `isStreamingFailure` | `src/streaming-failure.ts` (WP-01) | Import and call |

## Detailed Implementation Steps

### Step 1: Add Import for `isStreamingFailure`
**File:** `src/index.ts` (import section)
**Action:** Add import for `isStreamingFailure` from WP-01 module

```typescript
import { isStreamingFailure } from "./streaming-failure.js";
```

### Step 2: Extract `errorMessage` Earlier
**File:** `src/index.ts:1587-1616`
**Action:** Move `errorMessage` extraction before the `busyCount() === 0` check (after `errorName` extraction)

**Current code (lines ~1595-1600):**
```typescript
const errorName = (errorObj?.name as string) ?? ""
const isMessageAborted = errorName === "MessageAbortedError"

if (isMessageAborted) { ... }

if (busyCount() === 0) break  // <-- errorMessage extracted AFTER this

const errorMessage = ...
```

**New code order:**
```typescript
const errorName = (errorObj?.name as string) ?? ""
const errorMessage =
    (errorObj?.data as Record<string, unknown>)?.message as string | undefined ??
    String(errorObj?.data ?? "")
const isMessageAborted = errorName === "MessageAbortedError"

if (isMessageAborted) { ... }

// Streaming failure check HERE (before busyCount check)
const isStreamingFail = isStreamingFailure(errorName, errorMessage)

if (isStreamingFail) {
    if (sid) {
        const w = sessions.get(sid)
        if (w) {
            w.pendingRecovery = true
            w.pendingRecoveryReason = errorName
            w.pendingRecoveryAt = Date.now()
            log("info", `Streaming failure detected: ${errorName} - ${errorMessage}`, { sid })
        }
    } else {
        log("warn", `Streaming failure detected but no session ID: ${errorName} - ${errorMessage}`)
    }
}

if (busyCount() === 0) break
```

### Step 3: Preserve Existing Generic Error Handling
**File:** `src/index.ts:1610-1616`
**Action:** Keep existing generic error handling after the streaming failure check and `busyCount() === 0` check

**Existing code to preserve:**
```typescript
if (busyCount() === 0) break

const errorMessage = ...
log("debug", `Session error: ${errorName} - ${errorMessage}`)

if (sid) {
    const w = sessions.get(sid)
    if (w) { w.pendingTools = 0; w.pendingCommands = 0 }
}
break
```

### Step 4: Verify Ordering
Verify the final order in `session.error` case:
1. Extract `errorObj`, `errorName`, `errorMessage`
2. Check `isMessageAborted` → handle abort, break
3. Check `isStreamingFailure` → set pending recovery / log warning
4. Check `busyCount() === 0` → break (idle, no recovery)
5. Generic error handling → log debug, clear pendingTools/pendingCommands

## Internal Dependencies

| Dependency | Work Package | Status |
|------------|--------------|--------|
| `isStreamingFailure` function | WP-01 | Required |
| `Watch.pendingRecovery` field | WP-02 | Required |
| `Watch.pendingRecoveryReason` field | WP-02 | Required |
| `Watch.pendingRecoveryAt` field | WP-02 | Required |
| `sessions` Map, `Watch` type | Base | Existing |
| `busyCount()`, `sessions` Map, `log()` | Base | Existing |

## External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| TypeScript | >=5.0 | Type checking |
| Node.js | >=18 | Runtime |

## Required Refactoring

| Item | Current Location | Target Location | Reason |
|------|------------------|-----------------|--------|
| `errorMessage` extraction | Line ~1610 | Line ~1592 (before busyCount) | Needed for streaming failure check before busyCount check |

## State Changes

### Watch Type (from WP-02) - Fields Modified in WP-03

| Field | Type | Set When |
|-------|------|----------|
| `pendingRecovery` | `boolean` | Streaming failure + valid `sid` |
| `pendingRecoveryReason` | `string` | Streaming failure + valid `sid` (set to `errorName`) |
| `pendingRecoveryAt` | `number` | Streaming failure + valid `sid` (set to `Date.now()`) |

### Session Map State Transitions

| Event | Condition | State Change |
|-------|-----------|--------------|
| `session.error` (streaming failure) | `sid` exists, session found | `pendingRecovery=true`, `pendingRecoveryReason=errorName`, `pendingRecoveryAt=Date.now()` |
| `session.error` (streaming failure) | No `sid` | Log warning only |
| `session.error` (MessageAbortedError) | Any | Existing behavior (set `userCancelled=true`, `status="idle"`) |
| `session.error` (generic, idle) | `busyCount() === 0` | Break, no state change |
| `session.error` (generic, busy) | `busyCount() > 0` | Clear `pendingTools`, `pendingCommands` |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `isStreamingFailure` throws | Let it propagate (should not throw per WP-01 spec) |
| `sessions.get(sid)` returns undefined | Skip setting fields (session already cleaned up) |
| `errorObj` is null/undefined | `errorName=""`, `errorMessage=""` → `isStreamingFailure` handles empty strings |
| `Date.now()` unavailable | Not possible in Node.js |

## Logging

| Log Level | Message | Context |
|-----------|---------|---------|
| `info` | `Streaming failure detected: ${errorName} - ${errorMessage}` | Streaming failure + valid `sid` + session found |
| `warn` | `Streaming failure detected but no session ID: ${errorName} - ${errorMessage}` | Streaming failure + no `sid` |
| `debug` | `Session error: ${errorName} - ${errorMessage}` | Generic error (existing, preserved) |
| `info` | `User abort (ESC)` | MessageAbortedError (existing, preserved) |

## Configuration

No configuration changes required. The `isStreamingFailure` function (WP-01) handles classification logic internally.

## Test Plan

### Unit Tests (src/index.ts - session.error handler)

| Test Case | Input | Expected Behavior |
|-----------|-------|-------------------|
| TC-01 | `session.error` with `ErrorNames.StreamTimeoutError`, valid `sid`, busy session | `pendingRecovery=true`, `pendingRecoveryReason="StreamTimeoutError"`, `pendingRecoveryAt=timestamp`, log info |
| TC-02 | `session.error` with `ErrorNames.ConnectionReset`, valid `sid`, busy session | `pendingRecovery=true`, log info |
| TC-03 | `session.error` with `MessageAbortedError`, any `sid` | Existing behavior: `userCancelled=true`, `status="idle"`, log info "User abort (ESC)" |
| TC-04 | `session.error` with generic `Error`, valid `sid`, busy session | No pendingRecovery, log debug, clear `pendingTools`/`pendingCommands` |
| TC-05 | `session.error` with streaming failure, no `sid` | Log warning, no pendingRecovery set |
| TC-06 | `session.error` with streaming failure, valid `sid` but `busyCount() === 0` | Log info (streaming failure), then break at busyCount check, NO pendingRecovery |
| TC-07 | `session.error` with streaming failure, valid `sid` but session not in map | Log info, no pendingRecovery set (session undefined) |

### Integration Tests

| Test Case | Scenario | Expected |
|-----------|----------|----------|
| IT-01 | Stream timeout during active session | Recovery pending set, WP-04 recovery triggers |
| IT-02 | Connection reset during idle | Warning logged, no recovery pending |

### Manual Verification

1. Start opencode session
2. Trigger stream timeout (network disruption)
3. Verify `pendingRecovery=true` on session watch
4. Verify `pendingRecoveryReason` matches error name
5. Verify `pendingRecoveryAt` is recent timestamp
6. Verify recovery executes (WP-04)

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-01 | Streaming failure with valid `sid` → `pendingRecovery = true` | Unit test TC-01, TC-02 |
| AC-02 | `MessageAbortedError` → unchanged behavior | Unit test TC-03 |
| AC-03 | Generic error → unchanged behavior | Unit test TC-04 |
| AC-04 | Streaming failure with no `sid` → warning only | Unit test TC-05 |
| AC-05 | Streaming failure on idle (`busyCount() === 0`) → logged, no pending recovery | Unit test TC-06 |
| AC-06 | Streaming failure with valid `sid` but no session in map → logged, no pending recovery | Unit test TC-07 |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Ordering bug: streaming check after busyCount | Medium | High | Unit test TC-06 explicitly tests ordering |
| `isStreamingFailure` not imported | Low | High | TypeScript compile error |
| WP-02 fields not defined | Low | High | TypeScript compile error |
| Session cleaned up before handler runs | Low | Medium | Check `sessions.get(sid)` returns defined |
| `isStreamingFailure` false negative | Medium | High | Comprehensive WP-01 tests |

## Estimated Review Checklist

- [ ] Import for `isStreamingFailure` added correctly
- [ ] `errorMessage` extracted before `busyCount()` check
- [ ] Streaming failure check placed AFTER `MessageAbortedError` check
- [ ] Streaming failure check placed BEFORE `busyCount() === 0` check
- [ ] `pendingRecovery`, `pendingRecoveryReason`, `pendingRecoveryAt` set correctly
- [ ] Warning logged when no `sid`
- [ ] Generic error handling preserved after busyCount check
- [ ] TypeScript compiles without errors
- [ ] Unit tests cover all acceptance criteria
- [ ] No regression in existing `MessageAbortedError` handling
- [ ] No regression in generic error handling

## Out of Scope

- Implementation of `isStreamingFailure` (WP-01)
- Definition of `Watch` type fields (WP-02)
- Recovery execution logic (WP-04)
- Retry policy configuration (WP-05)
- Session recovery coordination (WP-06)
- Notification/alerting (WP-07)
- Tests for WP-01, WP-02 functions

## Deliverables

| Deliverable | Location | Description |
|-------------|----------|-------------|
| Modified `session.error` handler | `src/index.ts:1587-1616` | Extended with streaming failure detection |
| Import statement | `src/index.ts` imports | Import `isStreamingFailure` from WP-01 |
| Unit tests | `tests/wp03-session-error-handler.test.ts` | Tests for all acceptance criteria |

---

**Dependencies:** WP-01 (isStreamingFailure), WP-02 (Watch fields)
**Estimated Effort:** Medium (2-3 hours including tests)
**Priority:** High (blocks WP-04 recovery execution)