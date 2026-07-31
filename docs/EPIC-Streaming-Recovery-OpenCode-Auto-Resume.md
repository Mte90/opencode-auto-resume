# EPIC: Robust Streaming Failure Recovery for OpenCode Auto Resume

**Status:** Proposal\
**Target Repository:** https://github.com/Mte90/opencode-auto-resume

------------------------------------------------------------------------

# Executive Summary

## Problem

The plugin already detects that a session becomes idle after a failed
streaming operation, but there is strong evidence that the recovery
request does **not** consistently trigger a new assistant execution.

Observed sequence:

    LLM Stream
        ↓
    Streaming response failed
        ↓
    session.error
        ↓
    session.idle
        ↓
    Plugin sends recovery
        ↓
    No new session.busy

The recovery mechanism appears to execute, yet no second inference run
begins.

------------------------------------------------------------------------

# Evidence

## Runtime observations

-   `Streaming response failed`
-   `session.error`
-   `session.idle`
-   Recovery log emitted
-   Session remains idle
-   No new stream

This indicates that detection works significantly better than execution.

------------------------------------------------------------------------

# Working Hypotheses

## H1 --- Recovery request does not create a new assistant run

Highest probability.

Potential causes:

-   `noReply=true`
-   request accepted but ignored
-   wrong API call
-   request sent before session is recoverable

------------------------------------------------------------------------

## H2 --- Session state race condition

Possible flow:

    session.error
    ↓
    plugin immediately prompts
    ↓
    session not ready
    ↓
    request ignored
    ↓
    later session.idle

A deferred recovery after `session.idle` is expected to be more
reliable.

------------------------------------------------------------------------

## H3 --- Prompt deduplication

If identical prompts are filtered, a recovery prompt may silently be
ignored.

------------------------------------------------------------------------

# Architecture Recommendation

    session.error
          │
          ▼
    Streaming failure?
          │
          ▼
    pendingRecovery[sessionId]
          │
          ▼
    wait for session.idle
          │
          ▼
    recoverSession()
          │
          ▼
    session.prompt()
          │
          ▼
    expect session.busy
          │
          ▼
    stream resumes

------------------------------------------------------------------------

# Required Instrumentation

Log:

-   session id
-   reason
-   noReply
-   prompt body
-   response
-   API errors
-   busy transition
-   second stream start

------------------------------------------------------------------------

# Acceptance Criteria

## Functional

-   Recovery starts after streaming failures.
-   New `session.busy` appears.
-   New stream starts.
-   Existing recovery scenarios continue working.

## Non-functional

-   No duplicate recoveries.
-   No infinite retry loop.
-   Retry state cleaned correctly.
-   Structured logging.

------------------------------------------------------------------------

# Suggested Work Packages

  ID      Work Package
  ------- ------------------------------------
  WP-01   Analyse current recovery flow
  WP-02   Add structured debug logging
  WP-03   Introduce pending recovery state
  WP-04   Implement session.error detection
  WP-05   Delay execution until session.idle
  WP-06   Validate session.prompt request
  WP-07   Review noReply handling
  WP-08   Add retry safeguards
  WP-09   Unit tests
  WP-10   Integration tests
  WP-11   Documentation
  WP-12   Prepare upstream PR

------------------------------------------------------------------------

# Risks

  Risk                 Mitigation
  -------------------- -------------------------------------
  False positives      Trigger only for streaming failures
  Duplicate recovery   Session-based state machine
  Endless retries      Retry limit
  API changes          Version abstraction

------------------------------------------------------------------------

# Success Metrics

-   Recovery success rate \>95%
-   No regression in existing resume behavior
-   Complete automated test coverage
-   Structured diagnostics available

------------------------------------------------------------------------

# Conclusion

The available evidence indicates that **failure detection is already
functioning**. The primary engineering effort should focus on ensuring
that a recovery request reliably creates a new assistant execution after
the session reaches an idle state.

The recommended implementation is a small state machine that separates
**error detection** from **recovery execution**, adds instrumentation,
validates request semantics, and introduces comprehensive automated
tests.
