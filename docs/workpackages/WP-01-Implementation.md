# WP-01: Streaming Failure Classification - Implementation Plan

## Executive Summary

**Purpose:** Implement error classification to distinguish streaming failures from other error types, enabling targeted recovery strategies for stream-related failures.

**Goal:** Add a pure function `isStreamingFailure(errorName: string, errorMessage: string): boolean` that identifies streaming-related errors based on configurable error name patterns and message content patterns.

**Expected Behaviour:**
- `isStreamingFailure("ProviderError", "Streaming response failed")` → `true`
- `isStreamingFailure("MessageAbortedError", "")` → `false`
- `isStreamingFailure("TimeoutError", "Stream timed out")` → `true`
- `isStreamingFailure("UnknownError", "Something else")` → `false`
- Patterns configurable via plugin options with sensible defaults

---

## Scope

### In Scope
- New function `isStreamingFailure` in `src/index.ts`
- Two new plugin configuration options: `streamingFailureErrorNames` and `streamingFailureMessagePatterns`
- Default constants for error name patterns and message patterns
- Unit tests for the new function
- Documentation updates (README config table)

### Out of Scope
- Integration with existing error handling paths (WP-02+ will consume this)
- Modifications to `handleEvent` or session error handling
- Any retry logic changes
- New event types or hooks

---

## Affected Files

### Existing Files (Modified)
| File | Reason |
|------|--------|
| `src/index.ts` | Add constants, function, config options extraction, and export |
| `README.md` | Document new config options in configuration table |

### New Files
| File | Reason |
|------|--------|
| `src/index.streaming-failure.test.ts` | Unit tests for `isStreamingFailure` |

### Potential Files (If Needed)
| File | Why It Might Be Needed |
|------|------------------------|
| `src/types.ts` (new) | If we extract types for plugin options — not needed for WP-01 as types stay inline |

---

## Affected Components

### Functions (New)
- `isStreamingFailure(errorName: string, errorMessage: string): boolean` — exported, pure function

### Configuration (New Options)
```typescript
interface PluginOptions {
    // ... existing options
    streamingFailureErrorNames?: string[]
    streamingFailureMessagePatterns?: string[]
}
```

### Constants (New)
```typescript
const DEFAULT_STREAMING_FAILURE_ERROR_NAMES = [
    "ProviderError",
    "APIError",
    "StreamError",
    "ConnectionError",
    "TimeoutError",
]

const DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS = [
    "streaming response failed",
    "stream.*fail",           // regex: "stream" + "fail" anywhere
    "connection.*reset",      // regex: "connection" + "reset"
    "connection.*closed",     // regex: "connection" + "closed"
]
```

### Tests (New)
- Unit tests covering all acceptance criteria + edge cases

---

## Detailed Implementation Steps

### Step 1: Add Default Constants (src/index.ts, ~line 65)
Add after `DEFAULT_DEBUG` constant:
```typescript
const DEFAULT_STREAMING_FAILURE_ERROR_NAMES = [
    "ProviderError",
    "APIError",
    "StreamError",
    "ConnectionError",
    "TimeoutError",
]

const DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS = [
    "streaming response failed",
    "stream.*fail",
    "connection.*reset",
    "connection.*closed",
]
```

### Step 2: Add Config Option Extraction (src/index.ts, ~line 232)
In the plugin factory function, after `debug` extraction:
```typescript
const streamingFailureErrorNames: string[] =
    (options?.streamingFailureErrorNames as string[]) ?? DEFAULT_STREAMING_FAILURE_ERROR_NAMES

const streamingFailureMessagePatterns: string[] =
    (options?.streamingFailureMessagePatterns as string[]) ?? DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS
```

### Step 3: Implement `isStreamingFailure` Function (src/index.ts, ~line 190)
Add after `containsDoneClaimPattern` function (before `buildOpenTodosReminder`):
```typescript
function isStreamingFailure(errorName: string, errorMessage: string): boolean {
    if (!errorName && !errorMessage) return false

    // Check error name patterns (exact match, case-sensitive)
    if (errorName && streamingFailureErrorNames.includes(errorName)) {
        return true
    }

    // Check message patterns (case-insensitive regex match)
    if (errorMessage) {
        const lowerMessage = errorMessage.toLowerCase()
        for (const pattern of streamingFailureMessagePatterns) {
            try {
                const regex = new RegExp(pattern, "i")
                if (regex.test(lowerMessage)) return true
            } catch {
                // Fallback: simple substring match if regex invalid
                if (lowerMessage.includes(pattern.toLowerCase())) return true
            }
        }
    }

    return false
}
```

### Step 4: Export the Function (src/index.ts, ~line 204)
Add to exports at top of file:
```typescript
export { isStreamingFailure } from "./index"
// OR add to existing exports if using namespace export
```
Actually, since this is a single file plugin, add `export function isStreamingFailure` directly in the function declaration.

### Step 5: Create Test File (src/index.streaming-failure.test.ts)
```typescript
import { describe, test, expect } from "bun:test"
import { isStreamingFailure } from "./index"

describe("isStreamingFailure()", () => {
    // Acceptance criteria tests
    test("ProviderError with streaming response failed → true", () => {
        expect(isStreamingFailure("ProviderError", "Streaming response failed")).toBe(true)
    })

    test("MessageAbortedError with empty message → false", () => {
        expect(isStreamingFailure("MessageAbortedError", "")).toBe(false)
    })

    test("TimeoutError with stream timed out → true", () => {
        expect(isStreamingFailure("TimeoutError", "Stream timed out")).toBe(true)
    })

    test("UnknownError with something else → false", () => {
        expect(isStreamingFailure("UnknownError", "Something else")).toBe(false)
    })

    // Error name pattern tests
    test("APIError matches default names", () => {
        expect(isStreamingFailure("APIError", "")).toBe(true)
    })

    test("StreamError matches default names", () => {
        expect(isStreamingFailure("StreamError", "")).toBe(true)
    })

    test("ConnectionError matches default names", () => {
        expect(isStreamingFailure("ConnectionError", "")).toBe(true)
    })

    test("TimeoutError matches default names", () => {
        expect(isStreamingFailure("TimeoutError", "")).toBe(true)
    })

    // Message pattern tests (case-insensitive)
    test("streaming response failed (exact) → true", () => {
        expect(isStreamingFailure("AnyError", "streaming response failed")).toBe(true)
    })

    test("Stream fail anywhere in message → true", () => {
        expect(isStreamingFailure("AnyError", "The stream operation failed")).toBe(true)
    })

    test("Connection reset → true", () => {
        expect(isStreamingFailure("AnyError", "Connection was reset by peer")).toBe(true)
    })

    test("Connection closed → true", () => {
        expect(isStreamingFailure("AnyError", "Connection closed unexpectedly")).toBe(true)
    })

    // Case insensitivity
    test("STREAMING RESPONSE FAILED (uppercase) → true", () => {
        expect(isStreamingFailure("AnyError", "STREAMING RESPONSE FAILED")).toBe(true)
    })

    test("Stream Fail (mixed case) → true", () => {
        expect(isStreamingFailure("AnyError", "Stream Fail")).toBe(true)
    })

    // Negative cases
    test("ProviderError but unrelated message → true (name matches)", () => {
        expect(isStreamingFailure("ProviderError", "Rate limited")).toBe(true)
    })

    test("Non-streaming error name + non-streaming message → false", () => {
        expect(isStreamingFailure("ValidationError", "Invalid input")).toBe(false)
    })

    // Edge cases
    test("Empty error name and message → false", () => {
        expect(isStreamingFailure("", "")).toBe(false)
    })

    test("Only error name, empty message → matches name patterns", () => {
        expect(isStreamingFailure("ProviderError", "")).toBe(true)
        expect(isStreamingFailure("OtherError", "")).toBe(false)
    })

    test("Only message, empty error name → matches message patterns", () => {
        expect(isStreamingFailure("", "stream failed")).toBe(true)
        expect(isStreamingFailure("", "unrelated")).toBe(false)
    })

    test("Invalid regex pattern falls back to substring", () => {
        // This tests internal robustness - pattern with invalid regex chars
        // would be handled by try/catch fallback
        expect(isStreamingFailure("Error", "stream[failed")).toBe(false) // bracket not closed
    })
})
```

### Step 6: Update README.md Configuration Table
Add two rows to the "Configurable options" table (after `loopWindowMs`):
| Option | Default | Description |
|---|---|---|
| `streamingFailureErrorNames` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Error names that classify as streaming failures |
| `streamingFailureMessagePatterns` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Regex patterns (case-insensitive) in error messages indicating streaming failure |

Also add note: "Patterns are matched case-insensitively. Error names use exact match."

---

## Internal Dependencies

### Must Happen First
1. **Step 1 (Constants)** → **Step 2 (Config Extraction)** → **Step 3 (Function Implementation)**
   - Constants must exist before config extraction references them
   - Config variables must exist before function uses them

### Can Happen Independently
- **Step 5 (Tests)** — can be written after Step 3, but doesn't block other steps
- **Step 6 (README)** — documentation only, no code dependency

### Must Happen Last
- **Step 4 (Export)** — after function is implemented

---

## External Dependencies

### Previous WPs Required
- **None** — WP-01 has no dependencies

### Later WPs Depending on This
- **WP-03** (Streaming Error Handling) — will call `isStreamingFailure` to classify errors before retry
- **WP-03** (Streaming Error Handling) — will use classification for specialized recovery
- **WP-04** (Metrics/Logging) — may log streaming failure classifications

---

## Required Refactoring

### Minimal Refactoring Needed
- No existing code needs modification — this is purely additive
- The function is self-contained and uses closure over config variables (same pattern as existing helpers like `backoffMs`, `containsToolCallAsText`)

---

## State Changes

### New State (Plugin Closure Variables)
- `streamingFailureErrorNames: string[]` — loaded from config or defaults
- `streamingFailureMessagePatterns: string[]` — loaded from config or defaults

### No Changes To
- `SessionWatch` interface
- Any existing session state fields
- Event handling flow

---

## Error Handling

### New Error Paths in `isStreamingFailure`
1. **Invalid regex in message patterns** — caught by try/catch, falls back to case-insensitive substring match
2. **Null/undefined inputs** — handled by early return `false` if both empty
3. **Non-string inputs** — TypeScript prevents; JS callers get coerced by `.includes()`/`.toLowerCase()`

### No Error Propagation
- Function is pure, throws no errors
- All regex errors caught internally

---

## Logging

### No New Log Entries in WP-01
- `isStreamingFailure` is a pure classification function — no side effects
- Logging will be added in WP-02/03 when the function is consumed

---

## Configuration

### New Options
| Option | Type | Default | Validation |
|--------|------|---------|------------|
| `streamingFailureErrorNames` | `string[]` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Array of strings; empty array disables name matching |
| `streamingFailureMessagePatterns` | `string[]` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Array of regex pattern strings; empty array disables message matching |

### Config Extraction Location
In plugin factory function (`AutoResumePlugin`), lines ~206-232 area, after existing option extractions.

### Validation
- No runtime validation beyond TypeScript — invalid regex handled gracefully in function
- Empty arrays are valid (disable that matching mode)

---

## Test Plan

### Unit Tests (New File: `src/index.streaming-failure.test.ts`)
| Category | Tests |
|----------|-------|
| Acceptance Criteria | 4 tests (exact spec examples) |
| Error Name Patterns | 4 tests (each default name) |
| Message Patterns | 4 tests (each default pattern) |
| Case Insensitivity | 2 tests |
| Negative Cases | 2 tests |
| Edge Cases | 5 tests (empty, partial, invalid regex) |

### Integration Tests
- **None in WP-01** — function is pure, no integration needed

### Regression Tests
- **None** — no existing behaviour modified

### Fault Injection
- Invalid regex patterns in config (handled by try/catch fallback)

### Edge Cases Covered
- Both inputs empty
- Only error name provided
- Only message provided
- Invalid regex in patterns
- Case variations
- Non-matching names/messages

### Existing Tests That Must Not Break
- All existing tests in `src/index.test.ts`, `src/index.events.test.ts`, etc.
- No modifications to existing test files required

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `isStreamingFailure("ProviderError", "Streaming response failed")` returns `true` | Unit test |
| 2 | `isStreamingFailure("MessageAbortedError", "")` returns `false` | Unit test |
| 3 | `isStreamingFailure("TimeoutError", "Stream timed out")` returns `true` | Unit test |
| 4 | `isStreamingFailure("UnknownError", "Something else")` returns `false` | Unit test |
| 5 | Configurable via `streamingFailureErrorNames` option | Manual test: pass custom array, verify behaviour changes |
| 6 | Configurable via `streamingFailureMessagePatterns` option | Manual test: pass custom patterns, verify behaviour changes |
| 7 | Case-insensitive message matching | Unit test (uppercase/mixed case) |
| 8 | Invalid regex falls back to substring | Unit test (malformed pattern) |
| 9 | All existing tests pass | `bun test` |
| 10 | Function exported and importable | `import { isStreamingFailure } from "./index"` works |

---

## Risks

### Implementation Risks Only
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Regex performance with many patterns | Low | Low | Patterns are few (4 default); compiled per-call but negligible |
| Config option name collision | None | N/A | Names are unique, prefixed with `streamingFailure` |
| Case sensitivity confusion | Low | Medium | Document clearly: names = exact, messages = case-insensitive |
| Breaking existing tests | Very Low | High | Pure additive change; no existing code touched |

---

## Estimated Review Checklist

Reviewer should verify:
- [ ] Default constants defined at top of file with other `DEFAULT_*` constants
- [ ] Config options extracted in plugin factory with correct defaults
- [ ] `isStreamingFailure` function implemented with correct signature
- [ ] Function uses closure variables (not re-reading config each call)
- [ ] Error name matching: exact, case-sensitive
- [ ] Message pattern matching: regex, case-insensitive, with try/catch fallback
- [ ] Function exported (available on module)
- [ ] Test file created with all acceptance criteria + edge cases
- [ ] All tests pass: `bun test`
- [ ] README updated with new config options in table
- [ ] No modifications to existing functions, interfaces, or event handlers
- [ ] TypeScript compiles without errors: `bun run build` or `tsc --noEmit`

---

## Out of Scope

**WP-01 MUST NOT:**
- Call `isStreamingFailure` anywhere in the codebase
- Modify `handleEvent` or `session.error` handling
- Add retry logic based on streaming failure classification
- Add new event types or hooks
- Modify `SessionWatch` interface
- Change any existing config options
- Add logging calls inside `isStreamingFailure`
- Create integration tests involving the plugin runtime

---

## Deliverables

After WP-01 is complete, the following must exist:

### Code
1. ✅ `DEFAULT_STREAMING_FAILURE_ERROR_NAMES` constant in `src/index.ts`
2. ✅ `DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS` constant in `src/index.ts`
3. ✅ Config extraction for `streamingFailureErrorNames` and `streamingFailureMessagePatterns`
4. ✅ `isStreamingFailure(errorName: string, errorMessage: string): boolean` function (exported)
5. ✅ `src/index.streaming-failure.test.ts` with ≥21 unit tests

### Documentation
6. ✅ README.md updated with two new config option rows in table

### Verification
7. ✅ `bun test` passes (all existing + new tests)
8. ✅ `bun run build` succeeds (TypeScript compiles)

---

*End of WP-01 Implementation Plan*