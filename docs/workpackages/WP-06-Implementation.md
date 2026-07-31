# WP-06 Implementation Plan: session.prompt() Return Value Validation

## Executive Summary

**Work Package:** WP-06: session.prompt() Return Value Validation
**Epic:** EPIC v3 - Auto-Resume Reliability Enhancement
**Complexity:** Low (Diagnostic Enhancement Only)
**Dependencies:** None (WP-05 recommended for functional validation)
**Type:** Diagnostic Enhancement Only - No Functional Behavior Change

This work package implements diagnostic logging for the return value of `session.prompt()` calls in the `sendContinuePrompt` function. The implementation captures and inspects the `SessionPromptResponses` return value to detect stream initiation failures through diagnostic logging only - no functional behavior changes.

---

## Scope

### In Scope
- Capture return value of `ctx.client.session.prompt()` at two call sites in `sendContinuePrompt` (src/index.ts:477-484 and 495-499)
- Inspect `SessionPromptResponses` type: `{ info: AssistantMessage, parts: Part[] }`
- Inspect `response.info` for error indicators
- Inspect `response.parts` for content presence
- Log response at debug level for diagnostic purposes
- Log warning when response indicates failure (empty parts, error in info)
- No functional behavior changes - diagnostic logging only

### Out of Scope
- Any functional behavior changes (recovery logic, retries, etc.)
- Changes to WP-05 watchdog implementation
- Changes to session management or prompt sending logic
- SDK type definition changes
- Any functional recovery behavior modifications

---

## Affected Files

### Primary File
- **src/index.ts** - Lines 477-484 (initial prompt call) and 495-499 (retry prompt call)

### Supporting Files (Reference Only)
- **src/index.ts** - `sendContinuePrompt` function (lines ~470-510)
- **src/index.ts** - `SessionPromptResponses` type reference (SDK type)

---

## Affected Components

### Primary Component
- **`sendContinuePrompt` function** (src/index.ts:470-510)
  - Two `session.prompt()` call sites requiring return value capture
  - Lines 477-484: Initial continue prompt
  - Lines 495-499: Retry prompt (after empty response)

### Related Components (Reference Only)
- **`session.prompt()` SDK method** - Returns `SessionPromptResponses`
- **`SessionPromptResponses` type** - `{ info: AssistantMessage, parts: Part[] }`
- **`AssistantMessage` type** - Contains `info` field with potential error indicators
- **`Part[]` type** - Array of content parts; empty array indicates no content

---

## Detailed Implementation Steps

### Step 1: Capture Return Value at First Prompt Call (Line 477-484)

**Current Code (lines 477-484):**
```typescript
await ctx.client.session.prompt({
    path: { id: sid },
    body: {
        parts: [{ type: "text", text }],
        agent,
        model,
    },
})
```

**Target Implementation:**
```typescript
const response = await ctx.client.session.prompt({
    path: { id: sid },
    body: {
        parts: [{ type: "text", text }],
        agent,
        model,
    },
})

// Diagnostic logging
ctx.log.debug("session.prompt() response received", {
    sessionId: sid,
    hasParts: response.parts.length > 0,
    partsCount: response.parts.length,
    infoKeys: Object.keys(response.info || {}),
    info: response.info,
})

// Diagnostic: Check for failure indicators
if (response.parts.length === 0) {
    ctx.log.warn("session.prompt() returned empty parts array - possible stream initiation failure", {
        sessionId: sid,
        responseInfo: response.info,
        partsCount: response.parts.length,
    })
}

if (response.info && typeof response.info === 'object' && 'error' in response.info) {
    ctx.log.warn("session.prompt() response.info contains error indicator", {
        sessionId: sid,
        errorInfo: response.info,
    })
}

// Log raw response for debugging if structure unclear
ctx.log.debug("Raw session.prompt() response for debugging", {
    sessionId: sid,
    rawResponse: JSON.stringify(response, null, 2),
})
```

### Step 2: Capture Return Value at Retry Prompt Call (Line 495-499)

**Current Code (lines 495-499):**
```typescript
await ctx.client.session.prompt({
    path: { id: sid },
    body: { parts: [{ type: "text", text }], agent, model },
})
```

**Target Implementation:**
```typescript
const retryResponse = await ctx.client.session.prompt({
    path: { id: sid },
    body: { parts: [{ type: "text", text }], agent, model },
})

// Diagnostic logging for retry
ctx.log.debug("session.prompt() retry response received", {
    sessionId: sid,
    isRetry: true,
    hasParts: retryResponse.parts.length > 0,
    partsCount: retryResponse.parts.length,
    infoKeys: Object.keys(retryResponse.info || {}),
    info: retryResponse.info,
})

// Diagnostic: Check for failure indicators on retry
if (retryResponse.parts.length === 0) {
    ctx.log.warn("session.prompt() retry returned empty parts array - stream initiation failed on retry", {
        sessionId: sid,
        retryInfo: retryResponse.info,
        partsCount: retryResponse.parts.length,
    })
}

if (retryResponse.info && typeof retryResponse.info === 'object' && 'error' in retryResponse.info) {
    ctx.log.warn("session.prompt() retry response.info contains error indicator", {
        sessionId: sid,
        retryErrorInfo: retryResponse.info,
    })
}

// Log raw response for debugging
ctx.log.debug("Raw session.prompt() retry response for debugging", {
    sessionId: sid,
    isRetry: true,
    rawResponse: JSON.stringify(retryResponse, null, 2),
})
```

### Step 3: Add Type Import (If Needed)

**Check:** Verify if `SessionPromptResponses`, `AssistantMessage`, `Part` types are already imported from SDK.

**Action:** If not imported, add import statement at top of file:
```typescript
import type { SessionPromptResponses, AssistantMessage, Part } from "@opencode-ai/sdk";
```
*Note: Verify actual SDK import path from existing imports in src/index.ts*

### Step 4: Add Diagnostic Logging Helper (Optional - Reduce Duplication)

**Optional Enhancement:** Extract diagnostic logging to a helper function to avoid duplication between the two call sites.

```typescript
function logPromptResponse(ctx: typeof ctx, response: SessionPromptResponses, context: { sessionId: string; isRetry?: boolean }) {
    ctx.log.debug("session.prompt() response received", {
        sessionId: context.sessionId,
        isRetry: context.isRetry ?? false,
        hasParts: response.parts.length > 0,
        partsCount: response.parts.length,
        infoKeys: Object.keys(response.info || {}),
        info: response.info,
    })

    if (response.parts.length === 0) {
        ctx.log.warn("session.prompt() returned empty parts array - possible stream initiation failure", {
            sessionId: context.sessionId,
            isRetry: context.isRetry ?? false,
            responseInfo: response.info,
            partsCount: response.parts.length,
        })
    }

    if (response.info && typeof response.info === 'object' && 'error' in response.info) {
        ctx.log.warn("session.prompt() response.info contains error indicator", {
            sessionId: context.sessionId,
            isRetry: context.isRetry ?? false,
            errorInfo: response.info,
        })
    }

    ctx.log.debug("Raw session.prompt() response for debugging", {
        sessionId: context.sessionId,
        isRetry: context.isRetry ?? false,
        rawResponse: JSON.stringify(response, null, 2),
    })
}
```

---

## Internal Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `src/index.ts` - `sendContinuePrompt` function | **Required** | Primary modification target |
| `src/index.ts` - Existing logger (`ctx.log`) | **Required** | Used for debug/warn logging |
| `src/index.ts` - Existing `ctx.client.session.prompt()` calls | **Required** | Two call sites to modify |
| SDK Type Imports (`@opencode-ai/sdk`) | **Likely Required** | Verify existing imports for `SessionPromptResponses` |

---

## External Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `@opencode-ai/sdk` - `SessionPromptResponses` type | **Required (Type Only)** | Type definition: `{ info: AssistantMessage, parts: Part[] }` |
| `@opencode-ai/sdk` - `AssistantMessage` type | **Required (Type Only)** | Contains `info` field with potential error indicators |
| `@opencode-ai/sdk` - `Part` type | **Required (Type Only)** | Array element type; empty array = no content |

*Note: These are type-only dependencies. No runtime dependency changes required.*

---

## Required Refactoring

### Minimal Refactoring (Required)
1. **Variable Assignment** - Assign return value of both `session.prompt()` calls to `const` variables
2. **Logging Insertion** - Insert diagnostic logging after each call
3. **Type Import** - Add/verify SDK type imports if not present

### Optional Refactoring (Recommended for Maintainability)
1. **Extract Logging Helper** - Create `logPromptResponse()` helper to reduce code duplication between two call sites
2. **Type Guards** - Add type guards for `response.info` error checking if SDK types are complex

### No Refactoring Required
- No changes to function signatures
- No changes to control flow
- No changes to error handling paths
- No changes to retry logic
- No changes to session management

---

## State Changes

### No Functional State Changes
- **Session state:** Unchanged
- **Prompt sending logic:** Unchanged
- **Retry behavior:** Unchanged (still controlled by WP-05 watchdog)
- **Error recovery:** Unchanged
- **Session lifecycle:** Unchanged

### Diagnostic State Added (Logging Only)
- **Debug logs:** Response structure, parts count, info keys
- **Warning logs:** Empty parts detection, error indicators in info
- **Raw response logs:** Full JSON serialization for debugging

---

## Error Handling

### Diagnostic Error Detection (Logging Only - No Throwing)

| Condition | Log Level | Action |
|-----------|-----------|--------|
| `response.parts.length === 0` | `warn` | Log warning with sessionId, info, partsCount |
| `response.info.error` exists | `warn` | Log warning with sessionId, errorInfo |
| `response.info` has unexpected structure | `debug` | Log raw response for debugging |
| Any response received | `debug` | Log response structure for diagnostics |

### Error Handling Principles
1. **Never throw** - This is diagnostic only
2. **Never alter control flow** - Continue normal execution after logging
3. **Log at appropriate levels** - Debug for diagnostics, warn for anomalies
4. **Include context** - Always include `sessionId` and `isRetry` context

---

## Logging

### Log Levels Used
- **`debug`** - Routine response inspection, raw response dumps
- **`warn`** - Anomalies detected (empty parts, error indicators)

### Structured Log Fields

**Standard Response Log (debug):**
```json
{
  "sessionId": "session-id",
  "isRetry": false,
  "hasParts": true,
  "partsCount": 3,
  "infoKeys": ["id", "role", "content"],
  "info": { "id": "msg-123", "role": "assistant", "content": "..." }
}
```

**Empty Parts Warning (warn):**
```json
{
  "sessionId": "session-id",
  "isRetry": false,
  "responseInfo": { "id": "msg-123", "role": "assistant" },
  "partsCount": 0
}
```

**Error Indicator Warning (warn):**
```json
{
  "sessionId": "session-id",
  "isRetry": true,
  "errorInfo": { "error": "stream_failed", "code": "STREAM_INIT_FAILED" }
}
```

**Raw Response Debug (debug):**
```json
{
  "sessionId": "session-id",
  "isRetry": false,
  "rawResponse": "{\n  \"info\": {...},\n  \"parts\": [...]\n}"
}
```

### Log Sampling Consideration
- Debug logs on every call (low volume - only on continue prompts)
- Warn logs only on anomalies (expected to be rare)
- No sampling needed at expected volumes

---

## Configuration

### No Configuration Changes Required
- No new configuration options
- No environment variables
- No feature flags
- Uses existing logger configuration

---

## Test Plan

### Unit Tests (Diagnostic Verification)

| Test Case | Description | Expected Outcome |
|-----------|-------------|------------------|
| **StructureLogCall** | Verify `log.debug` called with response structure on successful prompt | Debug log contains `hasParts: true`, `partsCount > 0` |
| **EmptyPartsWarning** | Verify `log.warn` called when `parts.length === 0` | Warn log with `partsCount: 0`, sessionId present |
| **ErrorInfoWarning** | Verify `log.warn` called when `response.info.error` exists | Warn log with `errorInfo` containing error details |
| **RetryCallLogging** | Verify both initial and retry calls log responses | Two sets of logs with `isRetry: false/true` |
| **RawResponseLogging** | Verify raw JSON response logged at debug level | Debug log contains `rawResponse` string |

### Integration Test Scenarios

| Scenario | Setup | Verification |
|----------|-------|--------------|
| **Normal Continue** | Normal session continue with response | Debug logs show parts present, no warnings |
| **Empty Response** | SDK returns empty parts array | Warn log for empty parts, debug log shows structure |
| **Error in Info** | SDK returns error in info object | Warn log for error indicator |
| **Retry After Empty** | First call empty, retry succeeds | First call warns, retry call logs success |
| **SDK Structure Change** | Unexpected response shape | Debug log captures raw response for debugging |

### Manual Verification
1. Enable debug logging
2. Trigger auto-resume continue prompt
3. Verify debug logs appear with response structure
4. Simulate SDK failure (if possible) and verify warnings

---

## Acceptance Criteria

| # | Criterion | Verification Method |
|---|-----------|---------------------|
| **AC-01** | Return value of first `session.prompt()` call is captured in `const response` | Code review: variable assignment at line ~477 |
| **AC-02** | Return value of retry `session.prompt()` call is captured in `const retryResponse` | Code review: variable assignment at line ~495 |
| **AC-03** | Debug log emitted for every `session.prompt()` response with structure info | Unit test / manual test: verify debug log output |
| **AC-04** | Debug log includes `hasParts`, `partsCount`, `infoKeys`, `sessionId` | Log inspection: verify structured fields present |
| **AC-05** | Warn log emitted when `response.parts.length === 0` | Unit test: mock empty parts, verify warn log |
| **AC-06** | Warn log emitted when `response.info.error` exists | Unit test: mock error in info, verify warn log |
| **AC-07** | Raw response logged at debug level for SDK structure debugging | Log inspection: verify `rawResponse` JSON string present |
| **AC-08** | Retry call logs include `isRetry: true` context | Log inspection: verify retry context flag |
| **AC-09** | No functional behavior changes (retry logic, recovery unchanged) | Regression test: verify existing behavior unchanged |
| **AC-10** | Type imports added/verified for `SessionPromptResponses` | Code review: verify imports at top of file |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **SDK Type Mismatch** | Low | Low | Log raw response for debugging; type guards for safety |
| **Log Volume** | Low | Low | Debug level only; continue prompts are infrequent |
| **Performance Overhead** | Very Low | Negligible | JSON.stringify only on debug; conditional logging |
| **False Positive Warnings** | Low | Low | Warnings are diagnostic only; no functional impact |
| **Missing SDK Types** | Low | Low | Add import from `@opencode-ai/sdk`; verify in existing code |

---

## Estimated Review Checklist

### Code Review Focus Areas
- [ ] Return values captured at both call sites (lines ~477 and ~495)
- [ ] Variable names are clear (`response`, `retryResponse`)
- [ ] Debug logging includes all required structured fields
- [ ] Warning conditions correctly check `parts.length === 0` and `info.error`
- [ ] Retry call logging includes `isRetry: true` context
- [ ] Raw response logged via `JSON.stringify` at debug level
- [ ] No functional behavior changes introduced
- [ ] Type imports correct (verify against SDK)
- [ ] No `try/catch` added (not needed for diagnostic logging)
- [ ] No control flow changes
- [ ] Logger usage consistent with existing patterns in file

### Architecture Review
- [ ] Confirmed: No functional changes to recovery logic
- [ ] Confirmed: WP-05 watchdog remains primary validation
- [ ] Confirmed: Diagnostic-only implementation

---

## Out of Scope

| Item | Reason |
|------|--------|
| Functional retry logic changes | WP-05 handles functional validation |
| Session state modifications | Not a diagnostic concern |
| SDK type modifications | External dependency |
| Alerting/notification on warnings | Logging only; alerting is operational concern |
| Metrics/monitoring integration | Out of scope for diagnostic enhancement |
| Configuration for log levels | Uses existing logger configuration |
| Response parsing beyond info/parts | Minimal inspection per spec |

---

## Deliverables

### Primary Deliverable
- **Modified `src/index.ts`** with return value capture and diagnostic logging at two `session.prompt()` call sites in `sendContinuePrompt`

### Verification Deliverables
- **Unit tests** covering:
  - Normal response logging
  - Empty parts warning
  - Error info warning
  - Retry call context logging
  - Raw response debug logging

### Documentation Updates
- **This implementation plan** (WP-06-Implementation.md) - Complete
- No other documentation updates required (diagnostic only)

---

## Implementation Notes for Developer

### Key Implementation Principles

1. **Diagnostic First** - This is observability, not functionality. Log everything that might help debug stream initiation failures.

2. **No Behavior Changes** - Do not add `try/catch`, do not change control flow, do not affect retry logic. The WP-05 watchdog handles functional validation.

3. **Defensive Type Handling** - Use optional chaining and type checks:
   ```typescript
   if (response.info && typeof response.info === 'object' && 'error' in response.info)
   ```

4. **Structured Logging** - Always include `sessionId` and `isRetry` context. Use consistent field names.

5. **Raw Response for Debugging** - `JSON.stringify(response, null, 2)` at debug level captures full structure for SDK evolution.

### SDK Type Reference
From architecture audit:
```typescript
// SDK Type (verify actual import path)
type SessionPromptResponses = {
    info: AssistantMessage;  // Contains potential error indicators
    parts: Part[];           // Empty array = no content = possible stream failure
}

type AssistantMessage = {
    // ... fields including potential error info
    info?: { error?: string; code?: string; [key: string]: unknown };
    // ...
}

type Part = { type: "text"; text: string } | { type: "tool"; ... } | ...
```

### Log Level Guidance
- **Debug:** Every response, raw JSON, structure inspection
- **Warn:** Anomalies only (empty parts, error in info) - actionable for operators
- **Never Error/Info** - This is background diagnostic telemetry

---

## Summary

WP-06 is a **low-risk, diagnostic-only enhancement** that adds observability to the `session.prompt()` return values at two call sites in `sendContinuePrompt`. The implementation:

1. **Captures return values** at both initial and retry prompt calls
2. **Logs structured diagnostics** at debug level for every call
3. **Warns on anomalies** (empty parts, error indicators) at warn level
4. **Preserves raw responses** for SDK structure debugging
5. **Changes zero functional behavior** - WP-05 remains the functional validation layer

Estimated implementation: **< 2 hours** (including tests)
Estimated review: **< 30 minutes** (straightforward logging additions)