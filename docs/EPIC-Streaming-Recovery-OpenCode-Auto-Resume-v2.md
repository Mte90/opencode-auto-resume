# EPIC v2: Streaming Failure Recovery Extension for OpenCode Auto Resume

> **Status:** Evidence-based Revision (v2)
>
> **Based on:** Architecture Audit, Recovery Evidence Audit and
> Streaming Failure Trace

## Executive Summary

This revision replaces earlier assumptions with findings verified
against the repository source code.

### Key Findings

-   The plugin already contains an advanced recovery framework.
-   "Streaming response failed" is **not** explicitly handled anywhere
    in the source code.
-   Generic `session.error` events do **not** initiate recovery.
-   The deferred watchdog detects failed recovery attempts but only logs
    a warning.
-   The `noReply` hypothesis has been disproven.

## Verified Root Cause Candidates

### RC-1 (High)

Generic `session.error` handling performs logging and cleanup but never
starts recovery.

### RC-2 (High)

The watchdog reports that the session never becomes busy again, but
performs no escalation or retry.

### RC-3 (High)

The return value of `session.prompt()` is ignored, so successful prompt
submission cannot be distinguished from a successful assistant
execution.

## Project Goal

Extend the existing recovery framework with dedicated streaming-failure
handling while preserving all current recovery mechanisms.

## Scope

### In Scope

-   Streaming failure classification
-   Recovery policy engine
-   Recovery watchdog enhancement
-   Recovery state machine extension
-   Observability
-   Metrics
-   Automated testing
-   Documentation

### Out of Scope

-   Rewriting the existing recovery architecture
-   Breaking API changes
-   Unrelated behaviour changes

## Revised Work Packages

  WP      Description
  ------- ----------------------------------
  WP-01   Streaming Failure Classification
  WP-02   Recovery Policy Design
  WP-03   Watchdog Enhancement
  WP-04   Recovery State Machine Extension
  WP-05   Observability & Diagnostics
  WP-06   session.prompt Validation
  WP-07   Recovery Metrics
  WP-08   Unit Tests
  WP-09   Integration Tests
  WP-10   Fault Injection Tests
  WP-11   Documentation
  WP-12   Upstream Pull Request

## Acceptance Criteria

-   Streaming failures are classified separately from generic errors.
-   Recovery attempts are observable end-to-end.
-   The watchdog can escalate instead of only logging.
-   Existing recovery mechanisms remain fully compatible.
-   No regressions in current recovery behaviour.

## Risks

  Risk                   Mitigation
  ---------------------- --------------------------------------
  False recovery         Explicit error classification
  Retry storms           Exponential backoff and retry limits
  Behaviour regression   Full regression suite
  SDK evolution          Adapter abstraction

## Success Metrics

-   Recovery success rate \>95%
-   End-to-end observability
-   Full automated test coverage
-   No regression in existing recovery mechanisms

## Conclusion

The investigation fundamentally changed the original assumptions.

The repository already contains a sophisticated recovery framework.

The implementation should therefore extend the existing architecture
with explicit streaming-failure handling, improved recovery validation,
richer diagnostics and stronger watchdog behaviour rather than replacing
the current design.
