# Streaming Failure Recovery Examples

This guide provides practical examples for configuring and using streaming failure recovery in opencode-auto-resume.

All configuration goes through the plugin options in your `opencode.jsonc` (there are no environment variables — configuration is code-based by design).

## Quick Start

Minimal configuration to enable streaming failure recovery:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "maxRecoveryRetries": 2,
        "baseBackoffMs": 1000
      }
    ]
  ]
}
```

This uses all default error names and message patterns with 2 recovery attempts and a 1 second base delay.

---

## Example 1: Custom Error Names for Specific Provider

If your AI provider uses custom error names for streaming failures:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "streamingFailureErrorNames": [
          "ProviderError",
          "APIError",
          "StreamError",
          "ProviderStreamError",
          "AnthropicStreamError",
          "OpenAIStreamError",
          "NetworkError",
          "TimeoutError"
        ],
        "maxRecoveryRetries": 5,
        "baseBackoffMs": 2000
      }
    ]
  ]
}
```

**Use case**: Provider throws `ProviderStreamError` when streaming fails. Error names are matched exactly and case-sensitively, so the name must match the error's `name` property exactly.

---

## Example 2: Custom Message Patterns for Specific Errors

If your provider returns specific error messages:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "streamingFailureMessagePatterns": [
          "stream.*interrupt",
          "stream.*cancel",
          "provider.*timeout",
          "upstream.*timeout",
          "stream.*closed.*unexpected",
          "incomplete.*stream"
        ],
        "maxRecoveryRetries": 2,
        "baseBackoffMs": 1500
      }
    ]
  ]
}
```

**Use case**: Provider returns messages like "stream interrupted by provider" or "upstream timeout". Patterns are regex, matched case-insensitively against the error message. If a pattern is not a valid regex, it falls back to substring matching.

---

## Example 3: Aggressive Retry for Unreliable Networks

For environments with unreliable network connectivity:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "maxRecoveryRetries": 10,
        "baseBackoffMs": 500,
        "maxBackoffMs": 60000
      }
    ]
  ]
}
```

This configuration:
- Retries up to 10 times
- Starts at 500ms base delay
- Caps at 60 seconds
- Uses the built-in 2x exponential backoff

**Delays** (`backoffMs(attempt) = min(base * 2^(attempt-1), max)`): 500ms, 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped), 60s, 60s. The initial trigger fires once `backoffMs(0)` (base/2) has elapsed since detection.

---

## Example 4: Conservative Retry for Rate-Limited APIs

For APIs with strict rate limits:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "maxRecoveryRetries": 2,
        "baseBackoffMs": 5000,
        "maxBackoffMs": 30000
      }
    ]
  ]
}
```

**Delays**: 5s, 10s (then escalate to abort+resume).

---

## Example 5: Configuration via Plugin Options

The plugin is configured exclusively through options in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-auto-resume",
      {
        // Error names (exact, case-sensitive)
        "streamingFailureErrorNames": ["ProviderError", "StreamError", "NetworkError", "TimeoutError", "ConnectionError"],
        // Message patterns (regex, case-insensitive)
        "streamingFailureMessagePatterns": ["stream.*fail", "connection.*reset", "connection.*closed", "timeout"],
        // Retry settings
        "maxRecoveryRetries": 5,
        "baseBackoffMs": 2000,
        "maxBackoffMs": 60000
      }
    ]
  ]
}
```

This is the equivalent of the (not supported) environment-variable approach in containerized setups — mount or generate `opencode.jsonc` per environment.

---

## Example 6: Monitoring Recovery Activity

The plugin has no event bus — observability is log-based. All recovery actions emit structured `app.log` messages (service: `auto-resume`) and, with `"debug": true`, `[debug]` console output:

```
[INFO] auto-resume: Streaming failure detected on ...ses_1234: errorName=ConnectionError, errorMessage=connection reset, pendingRecoveryReason=ConnectionError
[INFO] auto-resume: Pending recovery triggered on ...ses_1234: reason=ConnectionError, attempt=1, maxRetries=2
[INFO] auto-resume: Recovery successful on ...ses_1234: elapsedMs=1500
[WARN] auto-resume: ...ses_1234 - recovery attempt 1/2 after prompt timeout
[WARN] auto-resume: Recovery failed on ...ses_1234 - session still idle: attempt=1, maxRetries=2, nextAction=retry
[INFO] auto-resume: Retrying recovery on ...ses_1234: attempt=2, backoffMs=2000
[WARN] auto-resume: ...ses_1234 - max recovery attempts (2) reached, escalating to abort+resume
[WARN] auto-resume: Recovery exhausted on ...ses_1234: attempts=2, lastError=abort+resume failed
```

For monitoring/alerting, tail OpenCode's logs and match on `auto-resume` service entries with the `Streaming failure detected` / `Recovery failed` / `Recovery exhausted` messages.

---

## Example 7: Using the Exported Functions Programmatically

The detection and backoff logic are exported as pure functions from `src/index.ts`, so they can be reused or unit-tested independently:

```typescript
import { isStreamingFailure, backoffMs } from "./src/index"

// Classify an error the same way the plugin does
const isFail = isStreamingFailure(
  error.name,
  error.message,
  ["ProviderError", "StreamError", "NetworkError", "TimeoutError", "ConnectionError"],
  ["stream.*fail", "connection.*reset", "connection.*closed", "timeout"],
)

// Compute the delay for recovery attempt 3 with defaults (base 1000, max 8000)
const delay = backoffMs(3) // 4000

// With custom base/cap
const customDelay = backoffMs(3, 500, 60000) // 2000
```

When the defaults match your provider, the arguments can be omitted entirely: `isStreamingFailure(error.name, error.message)`.

---

## Example 8: Testing Streaming Failure Recovery

Unit test example (bun test):

```typescript
import { describe, test, expect } from "bun:test"
import { isStreamingFailure, backoffMs } from "../src/index"

describe("isStreamingFailure()", () => {
  test("matches configured error names exactly (case-sensitive)", () => {
    expect(isStreamingFailure("ConnectionError", "")).toBe(true)
    expect(isStreamingFailure("connectionerror", "")).toBe(false)
  })

  test("matches message patterns case-insensitively", () => {
    expect(isStreamingFailure("", "CONNECTION RESET")).toBe(true)
  })

  test("invalid regex patterns fall back to substring matching", () => {
    expect(isStreamingFailure("", "(invalid", [], ["(invalid"])).toBe(true)
  })

  test("empty config disables detection", () => {
    expect(isStreamingFailure("ConnectionError", "connection reset", [], [])).toBe(false)
  })
})

describe("backoffMs()", () => {
  test("doubles each attempt and caps at max", () => {
    expect(backoffMs(1, 100, 1000)).toBe(100)
    expect(backoffMs(2, 100, 1000)).toBe(200)
    expect(backoffMs(5, 100, 1000)).toBe(1000)
  })
})
```

---

## Example 9: Debugging Recovery Issues

Enable debug logging:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "debug": true,
        "maxRecoveryRetries": 2,
        "baseBackoffMs": 1000
      }
    ]
  ]
}
```

Debug output shows state transitions and classification decisions:

```
[debug] State transition on ...ses_1234: pendingRecovery=false -> true, reason=ConnectionError
[debug] Pending recovery check on ...ses_1234: pendingRecovery=true, status=idle, userCancelled=false, aborting=false, continuing=false, gaveUp=false, recoveryAttempts=0, pendingRecoveryAt=1754000000000
[debug] Backoff check on ...ses_1234: elapsed=1200ms, required=500ms, attempt=0, pass=true
[debug] State transition on ...ses_1234: recoveryAttempts=0 -> 1
[debug] Watchdog check on ...ses_1234: status=idle, recoveryAttempts=1, maxRetries=2, watchdogLatencyMs=3100 -> RETRY
[debug] Retrying recovery on ...ses_1234: recoveryAttempts=2, backoffMs=2000, pendingRecoveryReason=ConnectionError
[debug] Watchdog check on ...ses_1234: status=idle, recoveryAttempts=2, maxRetries=2, watchdogLatencyMs=3200 -> ABORT_RESUME
[debug] Watchdog check on ...ses_1234: status=idle -> GAVE_UP
```

---

## Example 10: Disabling Streaming Failure Recovery

To disable streaming failure recovery entirely:

```json
{
  "plugin": [
    [
      "opencode-auto-resume",
      {
        "streamingFailureErrorNames": [],
        "streamingFailureMessagePatterns": []
      }
    ]
  ]
}
```

With both lists empty, no error is ever classified as a streaming failure and the pending-recovery path is never armed. The generic stall recovery continues to work as before.

---

## Configuration Reference Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `streamingFailureErrorNames` | `string[]` | `["ProviderError","APIError","StreamError","ConnectionError","TimeoutError"]` | Error class names indicating streaming failure (exact, case-sensitive) |
| `streamingFailureMessagePatterns` | `string[]` | `["streaming response failed","stream.*fail","connection.*reset","connection.*closed"]` | Regex patterns matching failure messages (case-insensitive) |
| `maxRecoveryRetries` | `number` | `2` | Maximum recovery attempts before abort+resume escalation |
| `baseBackoffMs` | `number` | `1000` | Initial backoff delay (ms) |
| `maxBackoffMs` | `number` | `8000` | Maximum backoff delay (ms) |

---

## Troubleshooting

### Recovery Not Triggering

1. Check the error name matches `streamingFailureErrorNames` exactly (case-sensitive)
2. Check the error message matches `streamingFailureMessagePatterns` (regex, case-insensitive)
3. Enable `"debug": true` to see classification decisions
4. Verify the failure arrives as a `session.error` event while the session is busy — the recovery is only armed for busy sessions
5. `MessageAbortedError` (ESC) is deliberately never treated as a streaming failure

### Recovery Looping Infinitely

1. Ensure `maxRecoveryRetries` is set (default 2)
2. Check that the retry operation eventually succeeds or fails differently
3. Verify `Recovery exhausted` / `Recovery successful` log entries are emitted — the recovery chain always terminates in one of these

### Delays Too Short/Long

Adjust backoff parameters:
- `baseBackoffMs`: Initial delay
- `maxBackoffMs`: Cap

The multiplier is fixed at 2 (`backoffMs(attempt) = min(base * 2^(attempt-1), max)`).

### Recovery Not Escalating

After `maxRecoveryRetries` failed attempts, the plugin should log `max recovery attempts (...) reached, escalating to abort+resume`. If the abort+continue also fails, it logs `Recovery exhausted`. Check for `userCancelled` (ESC) or `command.executed` events, which clear the pending recovery.

---

## Related Documentation

- [Recovery Flow Architecture](../architecture/recovery-flow.md)
- [Architecture Audit](../audits/architecture-audit.md)
- [README — Streaming Failure Recovery](../../README.md#streaming-failure-recovery)
