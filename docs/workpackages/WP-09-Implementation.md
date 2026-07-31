# WP-09 Implementation Plan: Integration Tests

## Overview
Add comprehensive integration tests for end-to-end streaming failure recovery scenarios in the opencode-auto-resume plugin.

## Dependencies
- WP-01 through WP-08 must be complete
- Plugin core functionality implemented and stable
- Existing test infrastructure (bun:test) available at `src/index.integration.test.ts`

## Test Infrastructure

### Existing Test Infrastructure (from `src/index.integration.test.ts`)
```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test"
import { AutoResumePlugin } from "./index"

// Mock context structure:
ctx.client.session.list
ctx.client.session.status
ctx.client.session.messages
ctx.client.session.prompt
ctx.client.session.abort
ctx.client.app.log

// Event dispatch:
hooks.event({ event: { type, sessionID, properties } })

// Timing helper:
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
```

## Test Scenarios to Implement

### 1. Full Lifecycle: Streaming Failure → Pending Recovery → Idle → Recovery Attempt → Session Busy
**Scenario**: Complete end-to-end flow from streaming failure through successful recovery.

**Test Steps**:
1. Create session and start streaming
2. Simulate streaming failure event (`session.streaming.error`)
3. Verify session enters `pending_recovery` state
4. Wait for recovery delay (configurable delay)
4. Verify session transitions to `idle` state
5. Verify recovery attempt initiated via `session.prompt` with `continue`
5. Verify session transitions to `busy` state
6. Verify streaming resumes successfully

**Assertions**:
- State transitions: `streaming` → `pending_recovery` → `idle` → `busy` → `streaming`
- Recovery prompt sent with `continue: true`
- Recovery delay respected (configurable delay respected)
- Session state machine transitions correctly

### 2. Recovery with Retry: First Attempt Fails, Second Succeeds
**Scenario**: First recovery attempt fails, retry logic kicks in, second attempt succeeds.

**Test Steps**:
1. Create session, trigger streaming failure
2. Verify first recovery attempt sent
3. Simulate second streaming failure on same session
3. Verify retry logic triggers (max retries = 2 by default)
4. Verify second recovery attempt sent
5. Verify session recovers to `streaming` state

**Assertions**:
- Recovery attempt count = 2 (max retries)
- Session state: `pending_recovery` → `idle` → `busy` → `pending_recovery` → `idle` → `busy` → `streaming`
- Retry delay applied between attempts
- No abort+continue escalation yet (only 2 attempts)

### 3. Recovery with Abort+Continue Escalation
**Scenario**: After max retries exhausted, plugin escalates to abort+continue sequence.

**Test Steps**:
1. Configure `maxRetries = 2`
2. Create session, trigger streaming failure
3. Fail first recovery attempt (session stays in error)
3. Fail second recovery attempt
4. Verify abort+continue escalation triggered
4. Verify `session.abort` called then `session.prompt` with `continue: true`
5. Verify session recovers to `streaming`

**Assertions**:
- Exactly 2 recovery attempts via `session.prompt(continue: true)`
- Then 1 abort+continue sequence: `session.abort()` → `session.prompt(continue: true)`
- Total recovery attempts = maxRetries + 1 (escalation)
- Session reaches `streaming` state

### 4. Streaming Failure + User Abort (ESC Priority)
**Scenario**: User presses ESC (sends abort) during streaming failure recovery.

**Test Steps**:
1. Create session, trigger streaming failure
2. Session enters `pending_recovery` → `idle`
3. Before recovery attempt, simulate user abort event (`session.abort` called externally)
3. Verify plugin detects user abort and cancels pending recovery
4. Verify session stays in `idle` or `aborted` state
5. Verify no recovery prompt sent after user abort

**Assertions**:
- User abort takes priority over pending recovery
- No recovery prompt sent after user abort
- Session state reflects user abort (idle/aborted)
- Plugin cleanup: pending timers cleared

### 5. Multiple Streaming Failures on Same Session
**Scenario**: Multiple streaming failures on same session, each triggering recovery.

**Test Steps**:
1. Create session, trigger streaming failure → recovery succeeds
2. Trigger second streaming failure on same session → recovery succeeds
3. Trigger third streaming failure → recovery succeeds
4. Verify each failure triggers independent recovery cycle

**Assertions**:
- Each failure triggers independent recovery cycle
- Session state resets properly between failures
- Recovery delay applied each time
- No interference between recovery cycles
- Session returns to `streaming` after each recovery

### 6. Streaming Failure on Subagent Session
**Scenario**: Streaming failure occurs on a subagent session (spawned session).

**Test Steps**:
1. Create parent session
2. Spawn subagent session (via `session.spawn` or similar)
3. Trigger streaming failure on subagent session
4. Verify recovery works on subagent session
5. Verify parent session unaffected

**Assertions**:
- Subagent session handled independently
- Recovery operates on subagent session ID
- Parent session state unchanged
- Subagent session recovers to `streaming`

## Test Implementation Patterns

### Test Structure Template
```typescript
describe("WP-09: Integration Tests - Streaming Failure Recovery", () => {
  let plugin: AutoResumePlugin
  let ctx: MockContext
  let hooks: MockHooks

  beforeEach(() => {
    // Setup plugin, mock context, hooks
    plugin = new AutoResumePlugin()
    ctx = createMockContext()
    hooks = createMockHooks()
    plugin.setup(ctx, hooks)
  })

  test("Full lifecycle: streaming failure -> pending_recovery -> idle -> recovery -> busy", async () => {
    // 1. Setup session
    const sessionId = "session-123"
    setupSession(ctx, sessionId, "streaming")
    
    // 2. Trigger streaming failure
    hooks.event({ event: { type: "session.streaming.error", sessionID: sessionId, properties: { error: "connection lost" }}})
    
    // 3. Verify pending_recovery state
    await wait(10)
    expect(ctx.client.session.status.get(sessionId)).toBe("pending_recovery")
    
    // 4. Wait for recovery delay
    await wait(config.recoveryDelay + 10)
    
    // 5. Verify idle state
    expect(ctx.client.session.status.get(sessionId)).toBe("idle")
    
    // 6. Verify recovery prompt sent
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(sessionId, { continue: true })
    
    // 7. Verify busy state
    expect(ctx.client.session.status.get(sessionId)).toBe("busy")
    
    // 8. Simulate streaming resume
    hooks.event({ event: { type: "session.streaming.start", sessionID: sessionId }})
    expect(ctx.client.session.status.get(sessionId)).toBe("streaming")
  })
```

### Mock Context Factory
```typescript
function createMockContext() {
  return {
    client: {
      session: {
        list: mock(() => Promise.resolve([])),
        status: new Map(),
        messages: mock(() => Promise.resolve([])),
        prompt: mock(() => Promise.resolve()),
        abort: mock(() => Promise.resolve()),
        spawn: mock(() => Promise.resolve("subagent-id")),
      },
      app: {
        log: { info: mock(), warn: mock(), error: mock(), debug: mock() }
      }
    },
    config: {
      recoveryDelay: 1000,
      maxRetries: 2,
      abortTimeout: 5000,
      // ... other config
    }
  }
}
```

### Event Simulation Helpers
```typescript
const emitStreamingError = (hooks, sessionId, error = "connection lost") => 
  hooks.event({ event: { type: "session.streaming.error", sessionID: sessionId, properties: { error }}})

const emitStreamingStart = (hooks, sessionId) =>
  hooks.event({ event: { type: "session.streaming.start", sessionID: sessionId }})

const emitSessionAbort = (hooks, sessionId) =>
  hooks.event({ event: { type: "session.abort", sessionID: sessionId }})

const emitSessionIdle = (hooks, sessionId) =>
  hooks.event({ event: { type: "session.idle", sessionID: sessionId }})
```

### State Verification Helpers
```typescript
const expectSessionState = (ctx, sessionId, expectedState) => {
  expect(ctx.client.session.status.get(sessionId)).toBe(expectedState)
}

const expectRecoveryPromptSent = (ctx, sessionId, times = 1) => {
  expect(ctx.client.session.prompt).toHaveBeenCalledTimes(times)
  expect(ctx.client.session.prompt).toHaveBeenCalledWith(sessionId, { continue: true })
}

const expectAbortCalled = (ctx, sessionId, times = 1) => {
  expect(ctx.client.session.abort).toHaveBeenCalledTimes(times)
  expect(ctx.client.session.abort).toHaveBeenCalledWith(sessionId)
}
```

## Test File Location
- **File**: `src/index.integration.test.ts` (extend existing file)
- **Test suite name**: `describe("WP-09: Integration Tests - Streaming Failure Recovery", () => { ... })`

## Configuration for Tests
```typescript
const testConfig = {
  recoveryDelay: 100,        // Fast for tests
  maxRetries: 2,
  abortTimeout: 1000,
  subagentRecovery: true,
  enableAbortEscalation: true,
}
```

## Test Execution
```bash
# Run all integration tests
bun test src/index.integration.test.ts

# Run specific test suite
bun test src/index.integration.test.ts -t "WP-09"

# Run with verbose output
bun test src/index.integration.test.ts --verbose
```

## Acceptance Criteria
- [ ] All 6 test scenarios implemented
- [ ] All tests pass with `bun test`
- [ ] Tests follow existing patterns in `src/index.integration.test.ts`
- [ ] Tests use existing mock context/helpers
- [ ] Tests verify state machine transitions
- [ ] Tests verify correct API calls (`prompt`, `abort`, `status`, `messages`)
- [ ] Tests verify timing/delays respected
- [ ] Tests verify subagent session handling
- [ ] Tests verify user abort priority
- [ ] Tests verify retry escalation logic
- [ ] No modifications to plugin source code (WP-01 through WP-08 only)
- [ ] Tests pass in CI pipeline

## Test Coverage Targets
- Full lifecycle state transitions: 100%
- Retry logic: 100%
- Abort+continue escalation: 100%
- User abort priority: 100%
- Multiple failures same session: 100%
- Subagent session handling: 100%
- Error/edge cases: 80%+

## Estimated Effort
- **Test implementation**: ~6-8 hours
- **Test debugging/refinement**: ~2-3 hours
- **Total**: ~8-11 hours

## Risk Mitigation
- **Flaky tests**: Use `wait()` with generous margins, avoid race conditions
- **Mock complexity**: Extend existing mock context, don't rewrite
- **State machine complexity**: Test each transition explicitly
- **Async timing**: Use `wait()` helper, avoid arbitrary timeouts
- **Test isolation**: Reset mocks in `beforeEach`, no shared state