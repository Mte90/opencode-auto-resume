# WP-02 Implementation Plan: SessionWatch State Extension

## Executive Summary

This work package adds four new pending recovery state fields to the `SessionWatch` interface in `src/index.ts`. These fields enable tracking of pending recovery operations that must persist across idle-to-busy transitions but should be cleared when a session transitions to "busy" status (indicating active user engagement).

**Scope**: Add 4 fields to `SessionWatch` interface, update `ensureWatch()` initialization, modify `resetSessionFlags()` to clear recovery fields, and modify `resetIdleFlags()` to preserve recovery fields.

**Complexity**: Low (no new logic, only state field additions and initialization/reset modifications)

---

## Scope

### In Scope
- Add 4 new fields to `SessionWatch` interface (`src/index.ts:20-50`)
- Update `ensureWatch()` initialization (lines 276-313) with default values
- Update `resetSessionFlags()` (lines 699-719) to clear all 4 new fields
- Update `resetIdleFlags()` (lines 721-727) to preserve `pendingRecovery` and `pendingRecoveryReason`
- Add test coverage for new field initialization and reset behavior

### Out of Scope
- Recovery triggering logic (covered in WP-04, WP-05)
- Recovery prompt generation (WP-04)
- Recovery attempt tracking beyond `recoveryAttempts` field
- Recovery completion/success handling (WP-05)
- Any UI or user-facing changes

---

## Affected Files

| File | Location | Changes |
|------|----------|---------|
| `src/index.ts` | Lines 20-50 (SessionWatch interface) | Add 4 new fields |
| `src/index.ts` | Lines 276-313 (ensureWatch) | Initialize 4 new fields with defaults |
| `src/index.ts` | Lines 699-719 (resetSessionFlags) | Clear all 4 new fields |
| `src/index.ts` | Lines 721-727 (resetIdleFlags) | Preserve `pendingRecovery` and `pendingRecoveryReason` |
| `src/index.it.test.ts` | New test cases | Add tests for initialization and reset behavior |

---

## Affected Components

### 1. SessionWatch Interface (`src/index.ts:20-50`)
**Current fields (50):** createdAt, lastActivityAt, status, userCancelled, resumeAttempts, lastRetryAt, gaveUp, orphanWatchStartAt, aborting, toolTextRecovered, toolTextAttempts, continueTimestamps, idleSince, continuing, todos, todoCheckAttempts, toolTextTimer, checkingToolText, lastSubagentCheckAt, interruptedContinueCount, recentToolCalls, toolLoopAttempts, isSubagent, completionSignaled, todoNudgeAttempts, taskCompleteOverrides, doneClaimNoTodosAttempts, pendingTools, pendingCommands

**New fields (4):**
- `pendingRecovery: boolean` (default: `false`)
- `pendingRecoveryReason: string \| null` (default: `null`)
- `pendingRecoveryAt: number` (default: `0`)
- `recoveryAttempts: number` (default: `0`)

### 2. ensureWatch() Function (`src/index.ts:276-313`)
**Current behavior:** Creates new SessionWatch with all 50 fields initialized.
**Required change:** Add initialization for 4 new fields with specified defaults.

### 3. resetSessionFlags() Function (`src/index.ts:699-719`)
**Current behavior:** Resets 24 fields when `session.status` transitions to `"busy"`.
**Required change:** Add clearing of all 4 new pending recovery fields.

### 4. resetIdleFlags() Function (`src/index.ts:721-727`)
**Current behavior:** Resets 5 fields when session becomes idle.
**Required change:** Must NOT clear `pendingRecovery` and `pendingRecoveryReason` (must persist across idle transitions). Should continue clearing the other 3 existing fields (`aborting`, `orphanWatchStartAt`, `idleSince`, `pendingTools`, `pendingCommands`).

---

## Detailed Implementation Steps

### STEP 1: Add 4 New Fields to SessionWatch Interface
**File:** `src/index.ts`  
**Location:** Lines 20-50 (inside `interface SessionWatch { ... }`)

Add the following 4 fields after `pendingCommands: number` (line ~50):

```typescript
pendingRecovery: boolean
pendingRecoveryReason: string | null
pendingRecoveryAt: number
recoveryAttempts: number
```

**Field Details:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| pendingRecovery | boolean | false | Indicates a recovery operation is pending |
| pendingRecoveryReason | string \| null | null | Reason for pending recovery (e.g., "stream_stalled", "tool_text_detected") |
| pendingRecoveryAt | number | 0 | Timestamp (Date.now()) when pendingRecovery was set to true |
| recoveryAttempts | number | 0 | Number of recovery attempts made for current pending recovery |

---

### STEP 2: Update ensureWatch() Initialization
**File:** `src/index.ts`  
**Location:** Lines 276-313 (inside `function ensureWatch(sid: string)`)

Add the following 4 property initializations to the object literal (after `pendingCommands: 0`):

```typescript
pendingRecovery: false,
pendingRecoveryReason: null,
pendingRecoveryAt: 0,
recoveryAttempts: 0,
```

**Exact placement:** After line `pendingCommands: 0,` and before the closing `}` of the object literal.

---

### STEP 3: Update resetSessionFlags() to Clear Recovery Fields
**File:** `src/index.ts`  
**Location:** Lines 699-719 (inside `function resetSessionFlags(w: SessionWatch)`)

Add the following 4 statements at the end of the function (before the closing `}`):

```typescript
w.pendingRecovery = false
w.pendingRecoveryReason = null
w.pendingRecoveryAt = 0
w.recoveryAttempts = 0
```

**Placement rationale:** These resets occur when `session.status` transitions to `"busy"`, which indicates active user engagement - any pending recovery should be cleared at this point.

---

### STEP 4: Update resetIdleFlags() to Preserve Recovery Fields
**File:** `src/index.ts`  
**Location:** Lines 721-727 (inside `function resetIdleFlags(w: SessionWatch)`)

**Current code:**
```typescript
function resetIdleFlags(w: SessionWatch) {
    w.aborting = false
    w.orphanWatchStartAt = null
    w.idleSince = Date.now()
    w.pendingTools = 0
    w.pendingCommands = 0
}
```

**Required change:** DO NOT ADD any clearing of `pendingRecovery` or `pendingRecoveryReason`. The function must remain exactly as-is (only clearing the 5 existing fields). 

**Verification:** Confirm the function does NOT contain:
- `w.pendingRecovery = false`
- `w.pendingRecoveryReason = null`
- `w.pendingRecoveryAt = 0`
- `w.recoveryAttempts = 0`

These fields MUST persist across idle transitions.

---

### STEP 5: Add Test Coverage
**File:** `src/index.it.test.ts`  
**Location:** Add new test cases in the "SessionWatch state machine" describe block

**Test Case 1: ensureWatch initializes new fields with defaults**
```typescript
test("ensureWatch initializes pending recovery fields with defaults", () => {
    const sessions = new Map<string, any>()
    
    function ensureWatch(sid: string) {
        if (!sessions.has(sid)) {
            sessions.set(sid, {
                // ... existing fields ...
                pendingRecovery: false,
                pendingRecoveryReason: null,
                pendingRecoveryAt: 0,
                recoveryAttempts: 0,
            })
        }
        return sessions.get(sid)
    }

    const w = ensureWatch("test-session")
    
    expect(w.pendingRecovery).toBe(false)
    expect(w.pendingRecoveryReason).toBeNull()
    expect(w.pendingRecoveryAt).toBe(0)
    expect(w.recoveryAttempts).toBe(0)
})
```

**Test Case 2: resetSessionFlags clears recovery fields**
```typescript
test("resetSessionFlags clears pending recovery fields", () => {
    const w = {
        // ... existing fields ...
        pendingRecovery: true,
        pendingRecoveryReason: "stream_stalled",
        pendingRecoveryAt: Date.now(),
        recoveryAttempts: 2,
    }
    
    function resetSessionFlags(w: any) {
        // ... existing resets ...
        w.pendingRecovery = false
        w.pendingRecoveryReason = null
        w.pendingRecoveryAt = 0
        w.recoveryAttempts = 0
    }
    
    resetSessionFlags(w)
    
    expect(w.pendingRecovery).toBe(false)
    expect(w.pendingRecoveryReason).toBeNull()
    expect(w.pendingRecoveryAt).toBe(0)
    expect(w.recoveryAttempts).toBe(0)
})
```

**Test Case 3: resetIdleFlags preserves recovery fields**
```typescript
test("resetIdleFlags preserves pendingRecovery and pendingRecoveryReason", () => {
    const w = {
        aborting: true,
        orphanWatchStartAt: Date.now(),
        idleSince: null,
        pendingTools: 5,
        pendingCommands: 3,
        // Recovery fields - must be preserved
        pendingRecovery: true,
        pendingRecoveryReason: "tool_text_detected",
        pendingRecoveryAt: Date.now(),
        recoveryAttempts: 1,
    }
    
    function resetIdleFlags(w: any) {
        w.aborting = false
        w.orphanWatchStartAt = null
        w.idleSince = Date.now()
        w.pendingTools = 0
        w.pendingCommands = 0
        // MUST NOT clear recovery fields
    }
    
    const beforeRecovery = w.pendingRecovery
    const beforeReason = w.pendingRecoveryReason
    const beforeAt = w.pendingRecoveryAt
    const beforeAttempts = w.recoveryAttempts
    
    resetIdleFlags(w)
    
    // These should be preserved
    expect(w.pendingRecovery).toBe(beforeRecovery)
    expect(w.pendingRecoveryReason).toBe(beforeReason)
    expect(w.pendingRecoveryAt).toBe(beforeAt)
    expect(w.recoveryAttempts).toBe(beforeAttempts)
    
    // These should be reset
    expect(w.aborting).toBe(false)
    expect(w.orphanWatchStartAt).toBeNull()
    expect(w.idleSince).not.toBeNull()
    expect(w.pendingTools).toBe(0)
    expect(w.pendingCommands).toBe(0)
})
```

---

## Internal Dependencies

| Dependency | Type | Description |
|------------|------|-------------|
| `src/index.ts` | Source | Main implementation file containing SessionWatch, ensureWatch, resetSessionFlags, resetIdleFlags |
| `src/index.it.test.ts` | Test | Integration test file for SessionWatch state machine |

**No external dependencies** - This WP is independent (complements WP-01).

---

## External Dependencies

None. This work package only modifies internal TypeScript interfaces and functions.

---

## Required Refactoring

**None required.** The implementation is purely additive (new fields) and modifies existing initialization/reset functions. No architectural changes, no new files, no refactoring of existing logic.

---

## State Changes

### SessionWatch State Machine Additions

| State Transition | Current Behavior | New Behavior |
|------------------|------------------|--------------|
| Session created (`ensureWatch`) | 50 fields initialized | 54 fields initialized (4 new with defaults) |
| `session.status` → `"busy"` (`resetSessionFlags`) | 24 fields reset | 28 fields reset (4 new fields cleared) |
| Session becomes idle (`resetIdleFlags`) | 5 fields reset | 5 fields reset (recovery fields preserved) |
| `pendingRecovery` set to `true` | N/A | `pendingRecoveryAt` set to `Date.now()` |

### Field Lifecycle

```
pendingRecovery: false → (set true when recovery triggered) → true → (resetSessionFlags on busy) → false
pendingRecoveryReason: null → "stream_stalled"/"tool_text_detected" → null (on busy)
pendingRecoveryAt: 0 → Date.now() (when pendingRecovery=true) → 0 (on busy)
recoveryAttempts: 0 → 1, 2, 3... (incremented on each attempt) → 0 (on busy)
```

---

## Error Handling

**No new error handling required.** This WP only adds state fields and initialization/reset logic. No I/O operations, no network calls, no parsing that could fail.

**Defensive coding considerations:**
- `pendingRecoveryReason` uses `string | null` (not `undefined`) for explicit nullability
- `pendingRecoveryAt` uses `number` with `0` as sentinel (not `null`) for timestamp consistency with `createdAt`, `lastActivityAt`
- All fields initialized in `ensureWatch` - no undefined state possible

---

## Logging

**No new logging required.** This WP only adds state fields. Logging of recovery state changes will be added in WP-04 (Recovery Trigger) and WP-05 (Recovery Execution).

---

## Configuration

**No configuration changes.** The 4 new fields have hardcoded defaults and are not user-configurable.

---

## Test Plan

### Unit Tests (src/index.it.test.ts)

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| WP02-T01 | `ensureWatch` initializes `pendingRecovery: false` | Pass |
| WP02-T02 | `ensureWatch` initializes `pendingRecoveryReason: null` | Pass |
| WP02-T03 | `ensureWatch` initializes `pendingRecoveryAt: 0` | Pass |
| WP02-T04 | `ensureWatch` initializes `recoveryAttempts: 0` | Pass |
| WP02-T05 | `resetSessionFlags` clears `pendingRecovery` to `false` | Pass |
| WP02-T06 | `resetSessionFlags` clears `pendingRecoveryReason` to `null` | Pass |
| WP02-T07 | `resetSessionFlags` clears `pendingRecoveryAt` to `0` | Pass |
| WP02-T08 | `resetSessionFlags` clears `recoveryAttempts` to `0` | Pass |
| WP02-T09 | `resetIdleFlags` preserves `pendingRecovery` value | Pass |
| WP02-T10 | `resetIdleFlags` preserves `pendingRecoveryReason` value | Pass |
| WP02-T11 | `resetIdleFlags` preserves `pendingRecoveryAt` value | Pass |
| WP02-T12 | `resetIdleFlags` preserves `recoveryAttempts` value | Pass |
| WP02-T13 | `resetIdleFlags` still resets `aborting`, `orphanWatchStartAt`, `idleSince`, `pendingTools`, `pendingCommands` | Pass |

### Integration Tests
- Run existing test suite to ensure no regressions: `npm test` (or `bun test`)
- Verify all existing SessionWatch tests still pass

---

## Acceptance Criteria

| # | Criterion | Verification Method |
|---|-----------|---------------------|
| AC1 | `SessionWatch` interface has 4 new fields with correct types | TypeScript compilation passes; interface shows 54 fields |
| AC2 | `ensureWatch()` initializes all 4 fields to specified defaults | Unit tests WP02-T01 through WP02-T04 pass |
| AC3 | `resetSessionFlags()` clears all 4 new fields | Unit tests WP02-T05 through WP02-T08 pass |
| AC4 | `resetIdleFlags()` preserves `pendingRecovery` and `pendingRecoveryReason` | Unit tests WP02-T09, WP02-T10 pass |
| AC5 | `resetIdleFlags()` preserves `pendingRecoveryAt` and `recoveryAttempts` | Unit tests WP02-T11, WP02-T12 pass |
| AC6 | `resetIdleFlags()` still resets its 5 original fields | Unit test WP02-T13 passes |
| AC7 | All existing tests pass (no regressions) | Full test suite passes |
| AC8 | TypeScript compiles without errors | `npx tsc --noEmit` passes |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Accidentally clearing recovery fields in `resetIdleFlags` | Medium | High (breaks recovery persistence) | Explicit test WP02-T09/T010; code review checklist item |
| Forgetting to initialize in `ensureWatch` | Low | Medium (undefined fields) | TypeScript strict mode catches; unit test WP02-T01-T04 |
| Forgetting to clear in `resetSessionFlags` | Low | Medium (stale recovery state) | Unit tests WP02-T05-T08; code review |
| Type errors from new fields | Low | Low | TypeScript strict mode; run `tsc --noEmit` |

---

## Estimated Review Checklist

- [ ] SessionWatch interface has exactly 4 new fields with correct types and defaults
- [ ] ensureWatch() initializes all 4 fields in object literal
- [ ] resetSessionFlags() clears all 4 fields (4 statements added)
- [ ] resetIdleFlags() does NOT clear any recovery fields (verified by diff)
- [ ] resetIdleFlags() still clears its original 5 fields
- [ ] All 13 unit tests added and passing
- [ ] Full test suite passes (no regressions)
- [ ] TypeScript compiles without errors
- [ ] No new imports, no new files, no configuration changes
- [ ] Code follows existing style (no comments added, consistent formatting)

---

## Out of Scope (Explicitly NOT in this WP)

- [ ] Recovery trigger logic (WP-04)
- [ ] Recovery prompt building (WP-04)
- [ ] Recovery attempt execution (WP-05)
- [ ] Recovery success/failure handling (WP-05)
- [ ] Integration with streaming recovery (WP-01)
- [ ] Subagent recovery handling (WP-06)
- [ ] Configuration options for recovery behavior (WP-08)
- [ ] Logging of recovery state transitions (WP-04/05)
- [ ] Metrics/telemetry for recovery attempts (WP-07)

---

## Deliverables

1. **Modified:** `src/index.ts` - SessionWatch interface + 3 functions updated
2. **Modified:** `src/index.it.test.ts` - 13 new test cases added
3. **Verification:** All tests pass, TypeScript compiles cleanly