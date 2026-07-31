# Recovery Mechanism Evidence Audit

This document provides an evidence-based audit of the recovery mechanisms in the opencode-auto-resume plugin, tracing the recovery pipeline from source code triggers to session.prompt() invocations.

## Recovery Mechanisms Identified

Through careful analysis of `src/index.ts`, five distinct recovery mechanisms were identified, each triggered by specific session states and conditions.

### 1. Stream Stall Recovery

**Trigger Condition**: Session remains idle (`status: "idle"idle > `chunkTimeoutMs + gracePeriodMs` (default 45s + 3s = 48s) from in-flight tool execute or tool commands)

**Exit Conditions**: Session goes above 0)
- Session becomes busy status 
- Reaches max retries (`resumeAttempts >= maxRetries`)

Retry Behavior: 
   - Uses exponential backoff (`backoffMs(attempt) = baseBackoffMs * 2^(attempt-1)`) capped at `maxBackoffMs`
   - Default: 1s, 2s, 4s, 8s for attempts 1-4
   - Max 3 retries (`maxRetries = 3` by default)

Exit Conditions:
   - Session becomes busy again (activity detected)
   - Max retries exceeded (`gaveUp = true`)
   - User manually cancels (`userCancelled = true`)
   - Session is aborted via ESC (`session.error` with `MessageAbortedError`)

Side Effects:
   - Increments `resumeAttempts`
   - Updates `lastRetryAt`
   - Sets `gaveUp = true` when retries exhausted
   - Updates `status` transitions in session watch
   - Logs retry attempts and failures

Evidence from Source:
- Lines 1314-1333: Main stall detection logic in timer
- Lines 1318-1320: In-flight tools check (`hasInflightTools(w)`)
- Lines 1322-1326: Active tool check fallback (`checkSessionHasActiveTool(sid)`)
- Lines 1327-1332: Retry logic with backoff and give up
- Lines 1155-1168: `tryResume` function implementing retry logic
- Lines 1134-1136: Backoff check
- Lines 314-315: `touchSession` updates `lastActivityAt`

### 2. Tool Call as Text Recovery

**Trigger Condition**: Session is idle (`status: "idle"`) AND last assistant message contains text patterns resembling tool calls but not actual tool executions

TriggersDetected via:
   - XML-like tool patterns (`<function=`, `<tool_call`, etc.) in text (lines 85-103)
   - Truncated XML patterns (open tag without close tag) (lines 105-111)
   - JSON tool patterns (`{"type":"function`, `{"name":`) (lines 99-101)
   - Reasoning content containing tool calls (when `partType === "reasoning"`)

Exit Conditions:
   - Actual tool call executed (resets via `resetSessionFlags` on `tool.execute.after`)
   - User manually cancels
   - Max retries exceeded for this specific recovery type (`toolTextAttempts >= maxRetries`)

Retry Behavior:
   - Separate retry counter: `toolTextAttempts`
   - Uses same exponential backoff as other retries via `backoffMs()`
   - Max retries: `maxRetries` (default 3)
   - Minimum gap between attempts: `minActivityGapMs` (default 1s)

Side Effects:
   - Sets `toolTextRecovered = true` when successful
   - Increments `toolTextAttempts`
   - Resets `toolTextTimer` on each check
   - Sends specific recovery prompts based on context:
     * `TOOL_TEXT_RECOVERY_PROMPT` for regular tool text
     * `THINKING_TOOL_RECOVERY_PROMPT` for tool text in reasoning
     * `TOOL_LOOP_RECOVERY_PROMPT` for tool loops

Evidence from Source:
- Lines 775-1078: `checkForToolCallAsText` function
- Lines 811-830: Tool call detection from `toolCall`/`tool_calls` fields
- Lines 831-850: Tool use detection from `parts`
- Lines 881-906: Tool call as text detection and recovery prompt selection
- Lines 908-967: Ready-to-continue pattern detection
- Lines 968-967: Done claim pattern detection
- Lines 971-989: Action intent detection
- Lines 1002-1017: Idle with open todos reminder
- Lines 1032-1034: State updates when recovery triggered
- Lines 1036-1041: Attempt counting and logging
- Lines 1448-1488: Tool text timer setup in idle handler
- Lines 1548-1555: Tool text timer setup in session.idle handler

### 3. Orphaned Subagent Recovery (Parent Watchdog)

**Trigger Condition**: Session status changes to `idle` AND was previously busy with multiple sessions AND now only one session remains busy (potential orphaned parent)

**Detection Logic**:
   - Session transitions to `idle` (line 1415)
   - Previous busy count > 1 AND current busy count === 1 (lines 1419-1420)
   - Lone busy session identified via `getLoneBusySession()` (line 1421)
   - Orphan watch started if not already active (lines 1422-1425)

**Exit Conditions**:
   - Subagent becomes busy again (resets orphan watch)
   - Subagent completes normally (no action needed)
   - Max retries exceeded for orphan recovery (`resumeAttempts >= maxRetries`)
   - Parent manually cancelled

**Retry Behavior**:
   - Uses orphan watch timer: `subagentWaitMs + gracePeriodMs` (default 15s + 3s = 18s)
   - After timeout, checks for:
     * In-flight tools (`hasInflightTools(w)`) - skips abort if present
     * Active tool calls (`checkSessionHasActiveTool(sid)`) - skips abort if present
     * Subagent status via `checkSubagentStatus(sid)`
   - If subagent crashed/stuck: attempts subagent recovery first
   - If subagent recovery fails or no busy subagents: triggers abort+resume
   - Retries follow standard exponential backoff via `tryAbortAndResume`

**Side Effects**:
   - Sets `orphanWatchStartAt` timestamp when watch begins
   - Sets `isSubagent = true` on lone busy session
   - May trigger `tryAbortAndResume` which:
     * Sets `aborting = true`
     * Calls `ctx.client.session.abort()`
     * Waits `ABORT_CONTINUE_DELAY_MS` (2s)
     * Calls `sendContinuePrompt`
     * Increments `resumeAttempts`
     * Sets `gaveUp = true` if retries exhausted

Evidence from Source:
- Lines 1415-1429: Orphan detection in `session.idle` handler
- Lines 1220-1266: Orphan watch timeout handling in timer
- Lines 1241-1250: Crashed subagent detection and recovery
- Lines 1251-1257: Idle subagent handling
- Lines 1277-1311: Parallel orphan/stalled parent checks in timer
- Lines 1084-1122: `tryAbortAndResume` function implementation
- Lines 647-697: `checkSubagentStatus` function
- Lines 616-645: `checkSessionHasActiveTool` function

### 4. Subagent Stuck/Crashed Recovery

**Trigger Condition**: Subagent session shows signs of being stuck or crashed:
   - Has tool call but no activity for `SUBAGENT_STUCK_MS * 3` (90s if has tool) or `SUBAGENT_STUCK_MS` (30s if no tool)
   - OR has error state in last message (`"error" in lastMsg` or `"error" in lastMsg.info`)

**Detection Logic**:
   - Performed during orphan/subagent checks (lines 1241-1250, 1302-1310)
   - Uses `checkSubagentStatus(sid)` function (lines 647-697)
   - Checks last message time vs `SUBAGENT_STUCK_MS` thresholds
   - Looks for error indicators in last message

**Exit Conditions**:
   - Subagent recovers and continues
   - Manual intervention
   - Parent gives up after max retries

**Retry Behavior**:
   - First attempts subagent-specific recovery via `recoverSubagent(subagentSid)` (lines 586-598)
   - Sends `SUBAGENT_RECOVERY_PROMPT` to stuck subagent
   - If subagent recovery fails OR no busy subagents found: triggers parent abort+resume
   - Parent retries follow standard exponential backoff

**Side Effects**:
   - Logs subagent recovery attempts
   - May trigger parent abort+resume sequence
   - Updates subagent status tracking

Evidence from Source:
- Lines 647-697: `checkSubagentStatus` function with stuck/crash detection
- Lines 586-598: `recoverSubagent` function sending recovery prompt
- Lines 1241-1250: Subagent recovery attempt in orphan watch
- Lines 1302-1310: Subagent recovery attempt in stall checker
- Line 1303: Call to `recoverSubagent(subStatus.stuckSid)`
- Lines 1307-1309: Fallback to parent abort+resume if subagent recovery fails

### 5. Idle with Open Todos Recovery

**Trigger Condition**: Session is idle (`status: "idle"`) AND has open todos (`getOpenTodos(todos).length > 0`) AND not already signaled completion/completionSignaled

**Detection Logic**:
   - Checked in multiple places:
     * Session becomes idle (lines 1431-1448)
     * Periodic timer check (lines 1337-1362)
     * Session idle event handler (lines 1518-1555)
   - Requires: `!w.completionSignaled && !w.userCancelled && w.todoNudgeAttempts < maxRetries`
   - Skips if celebration detected (`lastAssistantEndsWithCelebration(sid)`)

**Exit Conditions**:
   - Todos all completed
   - User sends completion signal (🎉 or `task_complete` tool)
   - Max todo nudge attempts exceeded (`todoNudgeAttempts >= maxRetries`)
   - User manually cancels

**Retry Behavior**:
   - Uses todo-specific counter: `todoNudgeAttempts`
   - Same exponential backoff via `backoffMs()`
   - Max retries: `maxRetries` (default 3)
   - Sends reminders via `buildOpenTodosReminder(todos)`
   - Special handling for done-claim scenarios

**Side Effects**:
   - Increments `todoNudgeAttempts` or `doneClaimNoTodosAttempts`
   - May set `toolTextRecovered = true` if celebration detected
   - Sends todo reminder messages
   - Handles special case where claims done but todos remain open

Evidence from Source:
- Lines 1431-1448: Todo check in `session.idle` handler
- Lines 1337-1362: Periodic todo check in timer
- Lines 1518-1555: Todo check in `session.idle` event handler
- Lines 197-203: `buildOpenTodosReminder` function
- Lines 908-967: Done claim pattern detection logic
- Lines 1002-1017: Idle with open todos reminder logic
- Lines 1023-1032: Todo nudge attempt limiting
- Lines 1443-1447: Todo nudge sending and logging
- Lines 1356-1361: Periodic todo nudge sending

## Event Flow Analysis

Based on the event handler in `handleEvent` function (lines 1386-1630), here's how different session events flow through the recovery system:

### Session Lifecycle Events:

1. **`session.created`** (lines 1496-1502):
   - Initializes session watch via `ensureWatch(sid)`
   - Resets pending tool/command counters to 0
   - Logs debug message

2. **`session.updated`** (lines 1505-1508):
   - Ensures watch exists via `ensureWatch(sid)`
   - No other processing

3. **`session.idle`** (lines 1510-1557):
   - Sets status to idle
   - Calls `resetIdleFlags(w)` (lines 1514-1515)
   - Checks for action intent (lines 1518-1545) with 500ms delay
   - Sets up tool-text check timer if needed (lines 1548-1555)

4. **`session.status`** (lines 1396-1493):
   - **`-> busy`** (lines 1402-1406):
     * Updates `lastActivityAt`
     * Calls `resetSessionFlags(w)` (line 1404)
     * Updates busy count tracking
   - **`-> interrupted`** (lines 1407-1414):
     * Sets status to idle
     * Calls `resetIdleFlags(w)` (line 1410)
     * Sets `userCancelled = true`
     * Clears tool-text timer
   - **`-> idle`** (lines 1415-1449):
     * Sets status to idle
     * Calls `resetIdleFlags(w)` (line 1417)
     * Handles orphan detection logic (lines 1419-1427)
     * Processes open todos (lines 1431-1448)
     * Sets up tool-text check timer (lines 1484-1488)
   - **`-> retry`** (lines 1489-1493):
     * Just touches session (line 1491)

5. **`session.interrupted`** (lines 1560-1570):
   - Same as `session.status -> interrupted` path

6. **`todo.updated`** (lines 1573-1585):
   - Updates session's todo list
   - Maps properties to internal Todo interface

7. `s

7. **`session.error`** (lines 1587-1615):
   - Checks for `MessageAbortedError` (user pressing ESC)
   - If found: sets all busy sessions to idle + userCancelled = true
   - Otherwise: resets pending tools/commands for affected session

### Tool/Command Lifecycle Events:

8. **`tool.execute.before`** (lines 1682-1687):
   - Increments `pendingTools`
   - Updates `lastActivityAt`

9. **`tool.execute.after`** (lines 1696-1701):
   - Decrements `pendingTools` (clamped at 0)
   - Updates `lastActivityAt`

10. **`command.execute.before`** (lines 1689-1694):
    - Increments `pendingCommands`
    - Updates `lastActivityAt`

### Tool Completion Event:

11. **`task_complete` tool** (lines 1637-1659):
    - Checks for open todos
    - If open todos exist and overrides < maxRetries:
      * Increments `taskCompleteOverrides`
      * Returns blocking message
    - Otherwise:
      * Sets `toolTextRecovered = true`
      * Sets `completionSignaled = true`
      * Clears tool-text timer
      * Returns acknowledgment

### Periodic Checks (Timer):

12. **Main Timer Loop** (lines 1202-1366, runs every `checkIntervalMs` - default 5s):
    - Updates session status from `getSessionStatusMap()`
    - Skips non-busy, cancelled, or aborting sessions
    - **Orphan Watch Path** (lines 1220-1267):
      * Checks if orphan timeout exceeded (`subagentWaitMs + gracePeriodMs`)
      * Verifies no in-flight tools
      * Checks for active tool calls
      * Evaluates subagent status
      * Triggers abort+resume or subagent recovery as needed
    - **Stall Detection Path** (lines 1271-1334):
      * Skips if multiple busy sessions
      * Checks subagent staleness (`subagentWaitMs`)
      * Verifies no in-flight tools
      * Checks for active tool calls
      * Evaluates subagent status for stalled parent
      * Triggers `tryResume` for stall recovery if conditions met
    - **Periodic Todo Check** (lines 1337-1362):
      * Runs for idle parent sessions
      * Skips if subsession, cancelled, completed, or continuing
      * Skips if no open todos or max todo nudges reached
      * Checks backoff timing
      * Sends todo reminder if appropriate
    - **Idle Cleanup** (lines 1364-1366):
      * Calls `cleanupIdleSessions()`

## Recovery State Machine

Based on the source code analysis, each session maintains a complex state machine tracked in the `SessionWatch` interface (lines 20-50). Here's the distilled state machine for recovery logic:

### States (tracked via `SessionWatch.status`):
- `"unknown"`: Initial state before first status update
- `"busy"`: Session actively processing (tools/commands in flight or active tool call)
- `"idle"`: Session waiting, no active processing
- `"retry"`: Provider-side retry in progress (transient state)

### Key Boolean Flags Tracking Recovery Progress:
- `userCancelled`: User manually cancelled via ESC
- `aborting`: Currently in abort+resume process
- `gaveUp`: Exhausted all retries for current recovery attempt
- `continuing`: Currently sending a continue prompt
- `toolTextRecovered`: Tool-text recovery already succeeded
- `completionSignaled`: Session signaled completion (via 🎉 or task_complete)
- `isSubagent`: This session is a subagent of another
- `completionSignaled`: Task completion has been signaled

### Counters Tracking Retry Attempts:
- `resumeAttempts`: General stall recovery attempts
- `toolTextAttempts`: Tool-call-as-text recovery attempts
- `todoNudgeAttempts`: Open todo reminder attempts
- `doneClaimNoTodosAttempts`: Done-claim-without-todos verification attempts
- `taskCompleteOverrides`: task_complete tool call overrides due to open todos
- `toolLoopAttempts`: Tool loop recovery attempts (max 2)
- `interruptedContinueCount`: Continues sent after interruption

### Timers Tracking Recovery Timing:
- `lastActivityAt`: Timestamp of last session activity
- `lastRetryAt`: Timestamp of last recovery attempt
- `orphanWatchStartAt`: When orphan watch started (null if not active)
- `idleSince`: When session became idle (null if not idle)
- `toolTextTimer`: Timeout for delayed tool-text check
- `continueTimestamps`: Timestamps of recent continue prompts sent (for loop detection)
- `lastSubagentCheckAt`: Last time subagent status was checked

### State Transitions:

```
[Initial] 
     │
     ▼
[session.created] ────→ unknown
     │
     ▼
[First status update] → {busy,idle,retry} 
     │
     ├─[status: busy] ←─[tool/command start]───────┐
     │      │                                       │
     │      ▼                                       │
     │  [resetSessionFlags]                       [tool/command end]
     │      │                                       │
     │      ▼                                       │
     │  [active processing]                        │
     │      │                                       │
     │      ▼                                       │
     │[status: idle]◄───────────────────────────────┘
     │      │
     │      ├─[orphan detection]───→[start orphan watch]
     │      │      │
     │      │      ▼
     │      │[orphan timeout]───→[check subagent status]
     │      │      │
     │      │      ├─[subagent crashed]───→[recover subagent]───┐
     │      │      │                     │                       │
     │      │      │                     ├─[success]─────────────┘
     │      │      │                     │
     │      │      │                     └─[fail/none]───→[abort+resume]
     │      │      │
     │      │      ├─[subagent idle+no busy]──→[abort+resume]
     │      │      │
     │      │      └─[subagent busy]────────→[reset orphan watch]
     │      │
     │      ├─[todo check]────────────→[send todo reminder]←─[periodic check]
     │      │      │
     │      │      ▼
     │      │[celebration detected]───→[set recovery/completion flags]
     │      │
     │      ├─[tool-text check timer]───→[detect tool text in reasoning]───→[send thinking tool recovery]
     │      │      │                                         │
     │      │      │                                         ▼
     │      │      │                             [increment attempts] [set recovery flags]
     │      │      │                                         │
     │      │      │[detect tool call as text]───────────────┘
     │      │      │                     │
     │      │      │                     ▼
     │      │      │             [send tool text recovery]
     │      │      │                     │
     │      │      │                     ▼
     │      │      │             [increment attempts] [set recovery flags]
     │      │      │
     │      │      └─[detect tool loop]────────────→[send tool loop recovery]
     │      │                                       │
     │      │                                       ▼
     │      │                                [increment attempts] [set recovery flags]
     │      │
     │      ├─[action intent check (delayed)]───→[send action intent prompt]
     │      │      │
     │      │      ▼
     │      │[intent detected]───→[increment attempts] [set recovery flags]
     │      │
     │      └─[ready to continue pattern] ───────→[check todos/done claims]───→[send appropriate prompt]
     │                                                       │
     │                                                       ▼
     │                                           [increment attempts] [set recovery flags]
     │
     ▼
[status: retry] ─────→[provider internal retry]───→[back to previous state]
     │
     ▼
[Max retries exceeded] ────→[set gaveUp=true] ────→[stop recovery attempts]
     │
     ▼
[User cancel (ESC)] ──────→[set userCancelled=true] ──→[stop recovery attempts]
     │
     ▼
[Session ends] ────────────→[remove from sessions map] ───→[end]
```

### Transition Conditions:

1. **Busy → Idle**: 
   - When `session.status` event shows `"idle"`
   - Triggers: `resetIdleFlags()`, todo checks, orphan detection setup, tool-text timer setup

2. **Idle → Busy**:
   - When `session.status` event shows `"busy"` 
   - Triggers: `lastActivityAt` update, `resetSessionFlags()`

3. **Any → Retry**:
   - Provider internally retries (transient state, doesn't affect our logic directly)

4. **Busy → Idle (User Interrupted)**:
   - When `session.status` shows `"interrupted"` or `session.error` is `MessageAbortedError`
   - Sets `userCancelled = true`, calls `resetIdleFlags()`

5. **Idle → Recovery Attempt**:
   - When timers fire (orphan timeout, stall detection, todo check, tool-text check)
   - Subject to: retry limits, backoff timers, in-flight tool checks, active tool checks

6. **Recovery Attempt → Success**:
   - Session becomes busy again after prompt
   - OR receives celebration (🎉) 
   - OR receives `task_complete` tool call with no blocking todos
   - Sets appropriate recovery/completion flags

7. **Recovery Attempt → Failure**:
   - Max retries exceeded for that recovery type
   - Sets `gaveUp = true` (general) or specific attempt counter maxed
   - Stops further attempts of that type until reset

### Reset Conditions:
- `resetSessionFlags()`: Called on transition to busy (clears most recovery flags)
- `resetIdleFlags()`: Called on transition to idle (clears idle-specific flags)
- Manual reset via user interaction or session completion

## Evidence Matrix

| Recovery Mechanism | Trigger Condition | Detection Location | Exit Conditions | Retry Mechanism | Key State Flags | Source Evidence |
|--------------------|-------------------|-------------------|-----------------|-----------------|-----------------|-----------------|
| **Stream Stall Recovery** | Idle > (chunkTimeoutMs + gracePeriodMs) with no activity | Lines 1314-1333 (timer stall check) | Session becomes busy, max retries, user cancel | Exponential backoff via `backoffMs(resumeAttempts)`, max 3 retries | `resumeAttempts`, `lastRetryAt`, `gaveUp`, `status` | Lines 1155-1168 (`tryResume`), 1134-1136 (backoff check), 1318-1326 (in-flight/active tool checks), 1327-1332 (retry/give up logic) |
| **Tool Call as Text Recovery** | Idle + last assistant msg contains tool-like text patterns | Lines 775-1078 (`checkForToolCallAsText`) | Actual tool execution, max retries, user cancel | Separate counter `toolTextAttempts` with same backoff, max 3 retries | `toolTextAttempts`, `toolTextRecovered`, `toolTextTimer`, `checkingToolText` | Lines 881-906 (tool text detection), 908-967 (ready-continue/done-claim detection), 971-989 (action intent), 1002-1017 (todo reminder), 1032-1034 (state updates), 1036-1041 (attempt counting) |
| **Orphaned Subagent Recovery** | Parent idle + was multi-busy + now solo-busy > (subagentWaitMs + gracePeriodMs) | Lines 1220-1266 (timer orphan check) + Lines 1419-1429 (idle handler detection) | Subagent becomes busy, subagent completes, max retries, parent cancel | Orphan watch timer (18s default), then standard retry backoff via `tryAbortAndResume` | `orphanWatchStartAt`, `isSubagent` (on parent), `aborting`, `resumeAttempts`, `gaveUp` | Lines 1220-1266 (orphan timeout handling), 1241-1250 (crashed subagent), 1251-1257 (idle subagent), 1277-1311 (parallel checks), 1084-1122 (`tryAbortAndResume`) |
| **Subagent Stuck/Crashed Recovery** | Subagent: tool call + no activity > threshold OR error in last message | Lines 647-697 (`checkSubagentStatus`) + Lines 1241-1250, 1302-1310 (check invocations) | Subagent recovers, parent gives up, manual intervention | First: subagent-specific recovery (`recoverSubagent`), fallback: parent abort+resume | None specific (uses parent's retry counters) | Lines 647-697 (stuck/crash detection), 586-598 (`recoverSubagent`), 1241-1250, 1302-1310 (invocation sites) |
| **Idle with Open Todos Recovery** | Idle + open todos + !completionSignaled + !userCancelled + attempts < max | Lines 1431-1448 (idle handler), 1337-1362 (timer), 1518-1555 (session.idle event) | Todos completed, celebration detected, max todo nudges, user cancel | Todo-specific counter `todoNudgeAttempts` with standard backoff, max 3 retries | `todoNudgeAttempts`, `doneClaimNoTodosAttempts`, `toolTextRecovered` (if celebration), `completionSignaled` | Lines 1431-1448 (idle handler todo check), 1337-1362 (periodic todo check), 1518-1555 (session.idle event todo check), 197-203 (`buildOpenTodosReminder`), 1002-1017 (idle-with-todos reminder logic), 1023-1032 (attempt limiting) |

## Unknowns and Limitations

Based on the source code analysis, here are areas where behavior is not fully specified or where edge cases may exist:

### 1. **Race Conditions in State Updates**
- **Issue**: The code relies on `session.status` events to track state, but there may be timing gaps between actual state changes and event delivery
- **Evidence**: Lines 1209-1214 show manual state reconciliation: `if (realStatus && realStatus !== w.status)`, suggesting events can be stale
- **Impact**: Recovery timers might fire based on stale state information

### 2. **Nested Subagent Handling**
- **Issue**: The orphan detection logic assumes a simple parent-child relationship but doesn't account for deeply nested subagents (subagents of subagents)
- **Evidence**: `getLoneBusySession()` (lines 1334-1344) finds any lone busy session, not specifically direct children
- **Impact**: Orphan recovery might incorrectly target indirect subagents or miss complex nesting scenarios

### 3. **Tool Text Detection False Positives**
- **Issue**: The regex patterns for detecting tool calls in text (lines 85-103, 105-111) might match legitimate content that isn't actually intended as tool invocations
- **Evidence**: Broad patterns like `/<function\s*=/i` and `/{"type":\s*"function"/i` could match documentation or examples
- **Impact**: Unnecessary recovery prompts that might annoy users or disrupt legitimate workflows

### 4. **Backoff Timing Interactions**
- **Issue**: Multiple recovery mechanisms share the same backoff function but have separate counters, potentially leading to thundering herd problems
- **Evidence**: Each mechanism (`resumeAttempts`, `toolTextAttempts`, `todoNudgeAttempts`, etc.) tracks its own attempts but uses the same `backoffMs()` function
- **Impact**: Multiple recovery attempts could happen simultaneously after backoff periods expire

### 5. **Undefined Behavior for Rapid State Transitions**
- **Issue**: If a session rapidly transitions between states (e.g., busy→idle→busy→idle), it's unclear how the various timers and counters interact
- **Evidence**: Timers are set/cleared in multiple places (idle handlers, status handlers) without clear cancellation tracking
- **Impact**: Potential for premature timeout firings or missed recovery opportunities

### 6. **Missing Metrics for Effectiveness Measurement**
- **Issue**: While logging occurs for recovery attempts, there's no apparent mechanism to measure whether recovery attempts actually resolved the underlying issue
- **Evidence**: Logging shows attempts and results (lines 485-488, 501-505, 1065-1070, etc.) but no tracking of success rates or root cause resolution
- **Impact**: Difficult to tune parameters or improve recovery logic based on empirical data

### 7. **Limited Configuration Visibility**
- **Issue**: While many parameters are configurable, there's no way to inspect current configuration values at runtime
- **Evidence**: Configuration values are closed over in the `AutoResumePlugin` function (lines 207-234) but not exposed
- **Impact**: Operators cannot easily verify or debug configuration issues without accessing source or restarting with logging

### 8. **Ambiguous Completion Detection**
- **Issue**: Completion detection relies on either 🎉 emoji or `task_complete` tool, but there's no guidance on when to use each or what happens if both are used
- **Evidence**: Lines 536-557 (celebration detection) and lines 1637-1659 (tool completion) operate independently
- **Impact**: Inconsistent completion signaling could lead to premature or missed recovery termination

### 9. **Error Handling Gaps**
- **Issue**: Many API calls have try/catch blocks that log errors but don't necessarily prevent subsequent logic from running on potentially stale data
- **Evidence**: Functions like `getSessionMessages()` (lines 526-529) and `getSessionStatusMap()` (lines 559-579) return empty defaults on error
- **Impact**: Recovery decisions might be made based on empty or default data when APIs are temporarily unavailable

### 10. **Single-Threaded Timer Assumptions**
- **Issue**: The implementation uses JavaScript timers which are single-threaded, but makes assumptions about ordering that might not hold under extreme load
- **Evidence**: Multiple `setTimeout`/`setInterval` calls (lines 1455-1481, 1485-1487, 1519-1545, 1552-1555, 1202-1366) with interdependencies
- **Impact**: Under heavy load, timer callbacks might queue up and execute in unexpected sequences

## Conclusion

The opencode-auto-resume plugin implements a sophisticated, multi-layered recovery system with five distinct mechanisms addressing different failure modes:

1. **Stream Stall Recovery** handles the core use case of LLM generation pausing unexpectedly
2. **Tool Call as Text Recovery** addresses a specific failure mode where LLMs output tool syntax as text instead of executing tools
3. **Orphaned Subagent Recovery** detects when parent agents appear stalled after subagents complete
4. **Subagent Stuck/Crashed Recovery** handles unresponsive or failed subagents
5. **Idle with Open Todos Recovery** ensures agents don't stop working when work remains

Each mechanism has clearly defined triggers, detection logic, exit conditions, retry behavior with exponential backoff, and specific state tracking. The system is heavily defensive, with multiple checks to avoid interrupting legitimate work (in-flight tool checks, active tool validations, celebration detection, etc.).

The implementation demonstrates careful consideration of edge cases and failure modes, though as with any complex system, there are potential race conditions and edge cases that could benefit from additional monitoring or refinement.