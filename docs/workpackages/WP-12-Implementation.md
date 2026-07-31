# WP-12 Implementation Plan: Upstream Pull Request

## Overview
This work package covers the final step of submitting all implemented changes (WP-01 through WP-11) as a unified pull request to the upstream repository at https://github.com/Mte90/opencode-auto-resume.

## Scope
- Review all changes from WP-01 through WP-11 for quality and consistency
- Ensure all tests pass (unit, integration, fault injection)
- Verify CI checks pass
- Prepare comprehensive PR description
- Submit PR to upstream repository
- Address any review feedback

## Dependencies
- **WP-01 through WP-11**: All prior work packages must be complete and tested
- **Repository access**: Write access to https://github.com/Mte90/opencode-auto-resume

## Prerequisites Verification

### Pre-Submission Checklist
- [ ] All WP-01 through WP-11 changes are committed and pushed
- [ ] All unit tests pass (`npm test` or equivalent)
- [ ] All integration tests pass
- [ ] All fault injection tests pass
- [ ] Linting passes (`npm run lint` or equivalent)
- [ ] Type checking passes (`npm run typecheck` or equivalent)
- [ ] Documentation builds without errors
- [ ] CHANGELOG updated with all changes
- [ ] Version bumped if applicable (check VERSION or package.json)
- [ ] CHANGELOG.md updated with all WP-01 through WP-11 changes

## Implementation Steps

### Step 1: Pre-PR Quality Review
- [ ] Run full test suite: `npm test` (or project equivalent)
- [ ] Run linting: `npm run lint`
- [ ] Run type checking: `npm run typecheck` / `tsc --noEmit`
- [ ] Build project: `npm run build`
- [ ] Verify documentation builds: `npm run docs:build` (if applicable)
- [ ] Run any CI simulation: `act` or local CI simulation

### Step 2: Change Consolidation Review
Review all changes from WP-01 through WP-11:

| WP | Scope | Key Files |
|----|-------|-----------|
| WP-01 | Classification & State | `src/classifier/`, `src/state/`, `src/types/` |
| WP-02 | State Persistence | `src/state/persistence.ts`, `src/state/*.ts` |
| WP-03 | Handler Integration | `src/handler/`, `src/index.ts` |
| WP-04 | Timer Infrastructure | `src/timer/`, `src/timer/*.ts` |
| WP-05 | Watchdog | `src/watchdog/`, `src/watchdog/*.ts` |
| WP-06 | Return Handler | `src/handler/return.ts`, `src/handler/` |
| WP-07 | Observability | `src/observability/`, `src/logger.ts`, `metrics/` |
| WP-08 | Unit Tests | `tests/unit/`, `tests/unit/*.test.ts` |
| WP-09 | Integration Tests | `tests/integration/`, `tests/integration/*.test.ts` |
| WP-10 | Fault Injection Tests | `tests/fault/`, `tests/fault/*.test.ts` |
| WP-11 | Documentation | `docs/`, `README.md`, `CHANGELOG.md`, `docs/*.md` |

Verify:
- [ ] All TypeScript compiles without errors
- [ ] No console.log/console.error left in production code
- [ ] No TODO/FIXME comments left unresolved
- [ ] All new exports are properly exported from entry points
- [ ] No unused imports or dead code
- [ ] Consistent code style across all files

### Step 3: Create Unified Branch
```bash
# Ensure on latest main
git checkout main
git pull origin main

# Create unified PR branch
git checkout -b wp-12-upstream-pr

# Merge all WP branches (if they were separate branches)
# Or verify all commits are on this branch
git log --oneline -20  # verify all WP commits present
```

### Step 4: Final Verification
Run full test suite one more time:
```bash
# Run all tests
npm test

# Run lint
npm run lint

# Type check
npm run typecheck

# Build
npm run build
```

### Step 5: Prepare PR Description
Create comprehensive PR description following the template below.

### Step 6: Submit PR
```bash
# Push branch
git push origin wp-12-upstream-pr

# Create PR via GitHub CLI or web UI
gh pr create \
  --title "feat: opencode auto-resume implementation (WP-01 through WP-12)" \
  --body-file PR_DESCRIPTION.md \
  --base main \
  --head wp-12-upstream-pr
```

### Step 7: Address Review Feedback
- [ ] Monitor PR for CI results
- [ ] Address any CI failures
- [ ] Respond to reviewer comments
- [ ] Push fixes as needed
- [ ] Wait for approvals
- [ ] Merge when approved

## PR Description Template

Create `PR_DESCRIPTION.md` with the following content:

---

## Summary
This PR implements the complete **opencode-auto-resume** feature, enabling automatic resumption of opencode sessions when they are interrupted by rate limits, context limits, or other transient failures.

## Work Packages Included
| WP | Title | Description |
|----|-------|-------------|
| WP-01 | Classification & State | Session classification (rate_limit, context_limit, tool_error, network_error, unknown) and persistent state machine |
| WP-02 | State Persistence | JSON file-based state persistence with atomic writes and corruption recovery |
| WP-03 | Handler Integration | Main handler integrating classifier, state machine, and timer |
| WP-04 | Timer Infrastructure | Exponential backoff timer with jitter, max retries, jitter factor |
| WP-05 | Watchdog | Watchdog timer for stall detection with heartbeat mechanism |
| WP-06 | Return Handler | Session restoration, context replay, auto-confirmation handling |
| WP-07 | Observability | Structured logging (pino), Prometheus metrics, health checks |
| WP-08 | Unit Tests | ≥80% coverage for classifier, state machine, timer, watchdog, return handler |
| WP-09 | Integration Tests | End-to-end tests for rate_limit, context_limit, tool_error, network_error, unknown |
| WP-10 | Fault Injection Tests | Chaos tests for clock skew, disk full, network partition, corrupted state, concurrent sessions |
| WP-11 | Documentation | Architecture docs, API reference, operations guide, troubleshooting, ADRs |

## Architecture Summary
```
┌─────────────────────────────────────────────────────────────┐
│                    opencode-auto-resume                      │
├─────────────────────────────────────────────────────────────┤
│  Handler (entry point)                                       │
│    ├── Classifier → Session Classification                   │
│    ├── StateMachine → Persistent State Management            │
│    │   └── Persistence → Atomic JSON File Storage            │
│    ├── Timer → Exponential Backoff + Jitter                  │
│    ├── Watchdog → Stall Detection + Heartbeat                │
│    └── ReturnHandler → Session Restoration                   │
├─────────────────────────────────────────────────────────────┤
│  Observability: Logging (pino) + Metrics (Prometheus) + Health│
└─────────────────────────────────────────────────────────────┘
```

## Key Features
- **Automatic Classification**: Detects rate limits, context limits, tool errors, network errors
- **Persistent State**: Survives process restarts with atomic JSON persistence
- **Exponential Backoff**: Configurable base delay, max delay, jitter, max retries
- **Watchdog Protection**: Detects stalled sessions with configurable timeout
- **Session Restoration**: Full context replay with turn limiting and auto-confirmation
- **Observability**: Structured JSON logs, Prometheus metrics, health endpoints
- **Fault Tolerance**: Handles clock skew, disk full, network partitions, corrupted state
- **Comprehensive Testing**: Unit (≥80%), integration (5 scenarios), fault injection (5 scenarios)

## Configuration
All configuration via environment variables or config file:
```env
AUTO_RESUME_ENABLED=true
AUTO_RESUME_MAX_RETRIES=5
AUTO_RESUME_BASE_DELAY_MS=5000
AUTO_RESUME_MAX_DELAY_MS=300000
AUTO_RESUME_JITTER_FACTOR=0.3
AUTO_RESUME_WATCHDOG_TIMEOUT_MS=60000
AUTO_RESUME_STATE_DIR=.opencode/state
AUTO_RESUME_LOG_LEVEL=info
AUTO_RESUME_METRICS_ENABLED=true
```

## Testing
- **Unit Tests**: 80%+ coverage across all core modules
- **Integration Tests**: 5 end-to-end scenarios (rate_limit, context_limit, tool_error, network_error, unknown)
- **Fault Injection**: 5 chaos scenarios (clock_skew, disk_full, network_partition, corrupted_state, concurrent_sessions)
- **All tests pass in CI**

## Documentation
- `docs/architecture.md` - System architecture and data flow
- `docs/api.md` - API reference for all public interfaces
- `docs/operations.md` - Deployment, configuration, monitoring
- `docs/troubleshooting.md` - Common issues and resolutions
- `docs/adr/*.md` - Architecture Decision Records
- `README.md` - Updated with quick start and configuration
- `CHANGELOG.md` - Complete changelog for this release

## Breaking Changes
None. This is a new feature added as an optional module.

## Migration Guide
N/A - New feature, no migration needed.

## Testing Instructions
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:fault

# Run with coverage
npm run test:coverage
```

## Checklist
- [x] All tests pass
- [x] Linting passes
- [x] Type checking passes
- [x] Build succeeds
- [x] Documentation updated
- [x] CHANGELOG updated
- [x] Version bumped (if applicable)
- [x] No console.log/debug statements in production code
- [x] No TODO/FIXME comments
- [x] All new code covered by tests
- [x] ADRs documented for key decisions

---

## Acceptance Criteria
- [ ] PR submitted to https://github.com/Mte90/opencode-auto-resume
- [ ] PR passes all CI checks (lint, typecheck, test, build)
- [ ] PR description is complete and clear
- [ ] All WP-01 through WP-11 changes included
- [ ] PR approved by maintainers
- [ ] PR merged to main branch

## Risk Mitigation
| Risk | Mitigation |
|------|------------|
| CI failures | Pre-validate locally with full test suite |
| Review delays | Provide comprehensive PR description and testing instructions |
| Merge conflicts | Rebase on latest main before submitting |
| Breaking changes | Verify no breaking changes; this is additive only |

## Rollback Plan
If issues discovered post-merge:
1. Revert PR via GitHub revert button
2. Or create hotfix branch and cherry-pick revert commit
3. Document issue in follow-up issue

## Timeline
- **Preparation**: 30 minutes (review, test, prepare PR description)
- **Submission**: 5 minutes (push branch, create PR)
- **Review**: Variable (depends on maintainer availability)
- **Merge**: After approval

## Files to Verify in PR
Ensure all these file groups are included:
- [ ] `src/classifier/*`
- [ ] `src/state/*`
- [ ] `src/handler/*`
- [ ] `src/timer/*`
- [ ] `src/watchdog/*`
- [ ] `src/observability/*` / `src/logger.ts` / `src/metrics.ts`
- [ ] `src/types/*`
- [ ] `tests/unit/*`
- [ ] `tests/integration/*`
- [ ] `tests/fault/*`
- [ ] `docs/architecture.md`
- [ ] `docs/api.md`
- [ ] `docs/operations.md`
- [ ] `docs/troubleshooting.md`
- [ ] `docs/adr/*`
- [ ] `README.md`
- [ ] `CHANGELOG.md`
- [ ] `package.json` (version bump if applicable)
- [ ] Any config files (`.env.example`, etc.)

## Post-Merge Tasks
- [ ] Verify release workflow triggers (if applicable)
- [ ] Verify npm publish (if applicable)
- [ ] Update any downstream documentation
- [ ] Close related issues
- [ ] Archive WP branch

## Notes
- This PR combines all work from WP-01 through WP-11
- Previous intermediate PRs (PR-1 through PR-7 per EPIC Section 19) are consolidated
- Ensure no intermediate/merge commits clutter history - prefer clean linear history
- Consider squashing or rebasing for clean history if maintainers prefer

## References
- EPIC v3 Specification: Section 19 (PR Strategy)
- Repository: https://github.com/Mte90/opencode-auto-resume
- Architecture: `docs/architecture.md`
- ADRs: `docs/adr/`