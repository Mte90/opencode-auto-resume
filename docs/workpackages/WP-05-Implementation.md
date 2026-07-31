# WP-05 Implementation Plan: Watchdog Enhancement

## Overview
Enhance the deferred watchdog in `sendContinuePrompt` to escalate recovery failures instead of only logging warnings. The watchdog currently only logs a warning when the session is not "busy" after the prompt delay. This enhancement adds recovery escalation logic.

---

## Current State Analysis

### Current Watchdog Code (src/index.ts:511-516)
```typescript
setTimeout(async () => {
    if (w.status !== "busy") {
        await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
    }
}, toolTextCheckDelayMs)
```

### Timing Critical Issue
**Critical Timing Problem**: The watchdog's `setTimeout` callback fires ~3s AFTER `sendContinuePrompt` completes. By that time, line 507 (`w.continuing = false`) has already executed. Calling `sendContinuePrompt` from within the watchdog will hit the `w.continuing` guard at lines 427-430:

```typescript
// src/index.ts:427-430
if (w.continuing) {
    await log("debug", `${short(sid)} - sendContinuePrompt skipped, already continuing`)
    return
}
w.continuing = true
```

**Solution Required**: The watchdog must set `w.continuing = true` BEFORE calling `sendContinuePrompt`, or bypass the guard via a retry flag.

### tryAbortAndResume (src/index.ts:1084-1122)
```typescript
async function tryAbortAndResume(sid: string, w: SessionWatch): Promise<boolean> {
    // Calls session.abort(), waits 2s, then calls sendContinuePrompt
    // Returns boolean success
}
```

---

## Implementation Plan

### 1. Data Model Extensions (SessionWatch interface)

Add new fields to `SessionWatch` interface (src/index.ts ~line 100):

```typescript
interface SessionWatch {
    // ... existing fields ...
    pendingRecovery: boolean          // NEW: Set when sendContinuePrompt initiates recovery
    recoveryAttempts: number          // NEW: Count of recovery attempts
    maxRetries: number                // NEW: Max retries before abort (configurable, default 2)
    watchdogRetryGuard: boolean       // NEW: Guard to bypass w.continuing guard for watchdog retries
}
```

**Field Purposes:**
- `pendingRecovery`: Set to `true` in `sendContinuePrompt` when initiating a recovery send (line ~504). Reset to `false` on success/failure.
- `recoveryAttempts`: Incremented each time watchdog retries. Starts at 0.
- `maxRetries`: Configurable (default 2). After max retries, escalate to `tryAbortAndResume`.
- `watchdogRetryGuard`: Set to `true` by watchdog before calling `sendContinuePrompt` to bypass `w.continuing` guard.

---

### 2. Modified Watchdog Logic (src/index.ts:511-516)

Replace the existing watchdog callback with enhanced logic:

```typescript
setTimeout(async () => {
    if (w.status !== "busy") {
        // Check if this was a recovery attempt
        if (w.pendingRecovery) {
            w.pendingRecovery = false  // Reset for potential retry
            
            if (w.recoveryAttempts < w.maxRetries) {
                w.recoveryAttempts++
                w.watchdogRetryGuard = true  // Bypass w.continuing guard
                await log("warn", `${short(sid)} - recovery attempt ${w.recoveryAttempts}/${w.maxRetries} after prompt timeout`)
                await sendContinuePrompt(sid, w)
                w.watchdogRetryGuard = false
            } else {
                await log("warn", `${short(sid)} - max recovery attempts (${w.maxRetries}) reached, escalating to abort+resume`)
                await tryAbortAndResume(sid, w)
            }
        } else {
            // Existing backward-compatible log-only path
            await log("warn", `${short(sid)} - prompt sent >${toolTextCheckDelayMs / 1000}s ago but session is still ${w.status}`)
        }
    }
    // If session IS busy, do nothing (normal case - tool is running)
}, toolTextCheckDelayMs)
```

---

### 3. Modify sendContinuePrompt Guard (src/index.ts:427-430)

Update the `w.continuing` guard to allow watchdog retries:

```typescript
// BEFORE (lines 427-430):
if (w.continuing) {
    await log("debug", `${short(sid)} - sendContinuePrompt skipped, already continuing`)
    return
}
w.continuing = true

// AFTER:
if (w.continuing && !w.watchdogRetryGuard) {
    await log("debug", `${short(sid)} - sendContinuePrompt skipped, already continuing`)
    return
}
w.continuing = true
w.watchdogRetryGuard = false  // Reset guard after passing
```

**Rationale**: The `watchdogRetryGuard` flag allows the watchdog to bypass the "already continuing" guard for legitimate retries, while preserving the guard for concurrent calls from other code paths.

---

### 4. Set pendingRecovery Flag in sendContinuePrompt

In `sendContinuePrompt`, when initiating a recovery send (around line 504), set the flag:

```typescript
// Around line 504, where sendContinuePrompt is called for recovery
w.pendingRecovery = true
w.recoveryAttempts = 0  // Reset on new recovery initiation
w.maxRetries = config.maxRecoveryRetries ?? 2  // Configurable, default 2
await sendContinuePrompt(sid, w)
```

**Note**: Also set `w.pendingRecovery = false` in the success/error paths of `sendContinuePrompt` after the prompt sends successfully.

---

### 5. Configuration Addition

Add to configuration (src/index.ts config schema, ~line 50):

```typescript
interface Config {
    // ... existing fields ...
    maxRecoveryRetries?: number  // Default: 2
    toolTextCheckDelayMs?: number  // Already exists, default 3000
}
```

---

### 4. Reset Logic in sendContinuePrompt

Ensure `pendingRecovery` is cleared on success/failure in `sendContinuePrompt`:

```typescript
// After successful prompt send (around line 507)
w.continuing = false
w.pendingRecovery = false  // Clear on success

// In catch block (around line 515)
w.continuing = false
w.pendingRecovery = false  // Clear on error too (watchdog will handle retry)
```

---

## Timing Diagram

```
T=0ms      sendContinuePrompt called
           w.continuing = true
           w.pendingRecovery = true
           w.recoveryAttempts = 0
           sendContinuePrompt() executes...
T=~100ms   sendContinuePrompt completes
           w.continuing = false
           w.pendingRecovery = true (still pending watchdog check)
T=3000ms   setTimeout fires (toolTextCheckDelayMs)
           Watchdog callback executes:
           - w.status !== "busy" (tool never started)
           - w.pendingRecovery === true
           - w.recoveryAttempts (0) < maxRetries (2)
           - w.recoveryAttempts = 1
           - w.watchdogRetryGuard = true
           - sendContinuePrompt(sid, w) called
           - w.watchdogRetryGuard = false
T=~3100ms  sendContinuePrompt executes again
           w.continuing = true (guard bypassed by watchdogRetryGuard)
           w.pendingRecovery = true
           sendContinuePrompt() executes...
T=~3200ms  sendContinuePrompt completes
           w.continuing = false
           w.pendingRecovery = true
T=6200ms   Second watchdog fires
           - w.recoveryAttempts (1) < maxRetries (2)
           - Retry again...
T=9300ms   Third watchdog fires
           - w.recoveryAttempts (2) >= maxRetries (2)
           - tryAbortAndResume(sid, w) called
           - session.abort() -> wait 2s -> sendContinuePrompt()
```

---

## Integration Points with Dependencies

### WP-02 (sendContinuePrompt Extraction)
- This WP depends on `sendContinuePrompt` being extracted as a standalone function (WP-02)
- The watchdog calls `sendContinuePrompt(sid, w)` directly
- Ensure WP-02 exports `sendContinuePrompt` in a way accessible to watchdog

### WP-04 (tryAbortAndResume Enhancement)
- This WP depends on `tryAbortAndResume` being enhanced (WP-04)
- WP-05 calls `tryAbortAndResume(sid, w)` after max retries
- WP-04 should ensure `tryAbortAndResume` properly resets `w.continuing`, `w.pendingRecovery`, `w.recoveryAttempts` on success

---

## Configuration

Add to config schema (src/index.ts):

```typescript
interface Config {
    // ... existing ...
    maxRecoveryRetries?: number      // Default: 2
    toolTextCheckDelayMs?: number    // Default: 3000 (existing)
}
```

Default values in config defaults:
```typescript
const DEFAULT_CONFIG: Required<Config> = {
    // ... existing ...
    maxRecoveryRetries: 2,
    toolTextCheckDelayMs: 3000,
}
```

---

## Testing Strategy

### Unit Tests (new file: tests/wp05-watchdog.test.ts)

1. **Watchdog triggers retry on non-busy session with pendingRecovery**
   - Mock session status = "idle"
   - Set w.pendingRecovery = true, w.recoveryAttempts = 0, w.maxRetries = 2
   - Fire watchdog timeout
   - Assert: sendContinuePrompt called, recoveryAttempts = 1

2. **Watchdog escalates to tryAbortAndResume after maxRetries**
   - Set w.recoveryAttempts = 2, w.maxRetries = 2
   - Fire watchdog timeout
   - Assert: tryAbortAndResume called, sendContinuePrompt NOT called

3. **Watchdog does nothing when session is busy (normal case)**
   - Mock session status = "busy"
   - Fire watchdog timeout
   - Assert: No log warning, no retry, no abort

4. **Watchdog logs only when pendingRecovery is false (backward compat)**
   - Mock session status = "idle"
   - w.pendingRecovery = false
   - Fire watchdog timeout
   - Assert: Warning logged, no retry, no abort

5. **watchdogRetryGuard bypasses w.continuing guard**
   - Set w.continuing = true, w.watchdogRetryGuard = true
   - Call sendContinuePrompt
   - Assert: Function proceeds (doesn't return early)

6. **sendContinuePrompt clears pendingRecovery on success**
   - Mock successful prompt send
   - Assert: w.pendingRecovery = false after completion

### Integration Tests (tests/integration/wp05-watchdog-integration.test.ts)

1. **Full recovery retry flow**
   - Mock session that stays "idle" after prompt
   - Verify watchdog retries 2x then calls tryAbortAndResume

2. **Recovery success on retry**
   - Mock session becomes "busy" on 2nd retry
   - Verify watchdog doesn't escalate further

3. **Concurrent continue prompts handled correctly**
   - Simulate watchdog retry + user-triggered continue
   - Verify guard prevents double-send

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/index.ts` | Add fields to SessionWatch, modify watchdog, modify sendContinuePrompt guard, add config |
| `src/index.ts` | Add config defaults for maxRecoveryRetries |
| `tests/wp05-watchdog.test.ts` | New unit tests |
| `tests/integration/wp05-watchdog-integration.test.ts` | New integration tests |

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Watchdog retry hits `w.continuing` guard | High | `watchdogRetryGuard` flag bypasses guard |
| Infinite retry loop | High | `maxRetries` hard limit, escalates to abort |
| Race condition: watchdog + user continue | Medium | `watchdogRetryGuard` is short-lived; `w.continuing` still protects |
| tryAbortAndResume not ready (WP-04) | High | Dependency on WP-04; sequence WP-04 before WP-05 |
| Config not propagated to SessionWatch | Medium | Initialize `maxRetries` from config in session init |

---

## Implementation Order

1. Add config field `maxRecoveryRetries` with default
2. Extend `SessionWatch` interface with 4 new fields
3. Initialize new fields in session watch creation
4. Modify `sendContinuePrompt` guard for `watchdogRetryGuard`
5. Set `pendingRecovery`/`recoveryAttempts`/`maxRetries` in sendContinuePrompt
6. Replace watchdog callback with enhanced logic
7. Clear `pendingRecovery` in sendContinuePrompt success/error paths
8. Write unit tests
9. Write integration tests
10. Run lint/typecheck

---

## Acceptance Criteria

- [ ] Watchdog retries `sendContinuePrompt` up to `maxRetries` times when session not busy and `pendingRecovery=true`
- [ ] Watchdog calls `tryAbortAndResume` after `maxRetries` exhausted
- [ ] Watchdog logs warning only (backward compatible) when `pendingRecovery=false`
- [ ] Watchdog does nothing when session status is "busy" (normal operation)
- [ ] `watchdogRetryGuard` bypasses `w.continuing` guard for watchdog retries only
- [ ] Config `maxRecoveryRetries` defaults to 2, is configurable
- [ ] All new and existing tests pass
- [ ] Lint and typecheck pass