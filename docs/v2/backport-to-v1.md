# v2 → v1 auto-resume backport research

Branch: `auto-resume/v2-todo-message-log` (HEAD a2d3897; v2 changes in 8073ba1 + a2d3897)
Subject: `src/index.ts` (v1 plugin, `@opencode-ai/plugin` v1 hooks style, ~3000+ lines)
Reference: `src/v2/index.ts` (v2 plugin)

## v1 mechanism today

### Continue channel (confirmed visible)

- `sendContinuePrompt(sid, text, w)` at **src/index.ts:837** is the single choke point for every continue. It calls `ctx.client.session.prompt({path:{id}, body:{parts:[{type:'text',text}],agent,model}})` at **914-921** (retry path **933-936**). This is a **visible user message** — confirmed per user directive.
- Agent/model are inferred from the last user message at **869-907** (via `getSessionMessages`, **1067-1080**).
- Guards inside `sendContinuePrompt`: `w.continuing && !watchdogRetryGuard` skip (**838-841**), `userCancelled || completionSignaled` (**842**), `gaveUp` latch (**848-851**), `oocLocked` latch (**852-856**).
- `recordContinue(sid)` at **927** (success) and **938** (retry success); `w.lastRetryAt` set at **928/939**; `finally` block resets `continuing`/`todoCheckAttempts`/clears toolTextTimer at **945-950**.
- Deferred watchdog `setTimeout` at **954-1025**: retry backoff → `sendContinuePrompt(sid, continuePrompt, w)` at **976** → escalate `tryAbortAndResume` → `gaveUp` latch at **1004**.

### Continue prompt content today (BARE)

- `continuePrompt` option at **530-531**: `const continuePrompt: string = (options?.continuePrompt as string) ?? "continue"` — **bare text today**.
- `actionIntentPrompt` at **532-533** defaults to `continuePrompt`.
- Other fixed prompts: `toolTextRecoveryPrompt` (**534**), `thinkingToolRecoveryPrompt` (**536**), `doneWithoutWorkPrompt` (**538**), `doneWithoutDetailsPrompt` (**540**), `TOOL_LOOP_RECOVERY_PROMPT` (**130**), `SUBAGENT_RECOVERY_PROMPT` (**1240**).
- `buildOpenTodosReminder(todos)` at **482-491** builds a richer "You have N unfinished tasks..." text (already used by idle-open-todos paths).

### All `sendContinuePrompt` call sites (all send bare `continuePrompt` or a fixed prompt)

| Line | Context | Prompt sent |
|---|---|---|
| 976 | deferred watchdog retry (WP-05) | `continuePrompt` (bare) |
| 1138 | unknown-tool suggestion | custom `prompt` (tool name) |
| 1903 | tool-text recovery best-candidate | `bestCandidate.prompt` |
| 1963 | abort+continue | `continuePrompt` (bare) |
| 2016 | `tryResume` generic send | `prompt ?? continuePrompt` |
| 2244 | pending-recovery (WP-04) | `continuePrompt` (bare) |
| 2650 | action-intent (idle) | `actionIntentPrompt` |
| 2732 | action-intent (busy) | `actionIntentPrompt` |
| 2953 | task_complete blocked | `blockMsg` (fixed) |
| 3061 | tool-loop recovery | `TOOL_LOOP_RECOVERY_PROMPT` (fixed) |

### `tryResume` (the main stall path)

- Signature at **1984**: `tryResume(sid, w, reason, prompt?)`.
- Backoff check at **1991-1992** (`backoffMs(w.resumeAttempts, ...)` at **447-453**).
- Hallucination-loop check at **1994-2009** (inflight tools → skip; else `tryAbortAndResume`).
- `w.resumeAttempts++` at **2011**; log at **2013**.
- Send at **2016**: `sendContinuePrompt(sid, prompt ?? continuePrompt, w)` — **bare unless caller passes explicit prompt**.
- Callers of `tryResume`:
  - **2203**: stream-stall (`"Stream stall"`, no explicit prompt → bare)
  - **2302**: periodic idle-open-todos (explicit `reminder` from `buildOpenTodosReminder`)
  - **2486-2492**: streaming-failure on idle (explicit `continuePrompt`)
  - **2533-2538**: silent-dead-stream (explicit `continuePrompt`)
  - **2607-2612**: idle-open-todos celebration false-positive (explicit `reminder`)
  - **2613-2616**: idle-open-todos normal (explicit `reminder`)

### Loop guards (existing)

- `recordContinue(sid)` at **573-577** (pushes timestamp into `w.continueTimestamps`).
- `isHallucinationLoop(sid)` at **583-588**: `continueTimestamps.length >= loopMaxContinues` (default **3**, option at **508-509**) within `loopWindowMs` (default **600s**, option at **510-511**) → true.
- `backoffMs` at **447-453**: exponential, capped.
- `w.gaveUp` latch: set at **1004** (watchdog exhausted), cleared at **1435**/`resetSessionFlags` and **1463**/`resetBusyFlags` (on new user message).
- `w.oocLocked` at **2876-2880** (OOC error → permanent halt).
- `minActivityGapMs` check at **1882-1886** (skip if session was active < gap ago).
- `todoNudgeAttempts` budget at **1863-1865** and **2602-2616**.
- `maxRetries` (option at **500-501**) and `maxRecoveryRetries` (option at **514-515**).
- No env-var reads in v1 today (all options via 2nd factory arg at **493**).
- `debug` option at **522-523**.

### Assistant text availability

- v1 has **no rolling `lastAssistantText`** accumulation (v2 uses `textParts` map maintained in `appendText` at src/v2/index.ts:1669-1677).
- v1 can get assistant text via `getSessionMessages(sid)` at **1067-1080** (SDK `session.messages`). The pattern is shown in `lastAssistantEndsWithCelebration` at **1155-1178** (iterate last assistant msg, concatenate text parts).
- Todo state: `w.todos`, `buildOpenTodosReminder` at **482-491**, `fetchSessionTodos` at **1206-1236**.

### Startup log

- Lines **2982-2985**: `if (!initialised) { initialised = true; log("info", \`opencode-auto-resume ready. timeout=${chunkTimeoutMs}ms, orphan=${subagentWaitMs}ms, loop=${loopMaxContinues}x/${loopWindowMs/1000}s\`) }` — no channel/rich/dup info today.

---

## V2 changes under review (reference: src/v2/index.ts)

1. **`visibleContinue`** + `AUTO_RESUME_VISIBLE_CONTINUE` env (v2 opts **1115-1117**; option doc **282-288**): stall continue via `ctx.session.prompt` (visible) instead of synthetic, fallback to synthetic on throw. **NOT needed for v1** (v1 already visible).
2. **`richContinuePrompt`** default `true` (v2 **1118**; doc **293-296**): `buildStallContinueText` at v2 **1799-1821** — custom `continuePrompt` wins verbatim; else `continue — stalled (${reason}; attempt ${attempt}/${maxRetries}).\n${todoSuffix}` where `todoSuffix` lists up to 5 open todos `• [status] content` or "No open todos recorded." / "Todo list unavailable."; `slice(0,2000)`. Called from `recover()` at v2 **1882**.
3. **Exact-duplicate anti-repeat**: v2 watch fields `lastProdText`/`prodAssistantSnapshot` (**159-162**) + rolling `lastAssistantText` (**172**, maintained **1669-1677**); `injectOnce` gate at v2 **1603-1609**: `checkDuplicate && !selfAbort && lastProdText!=="" && text===lastProdText && pendingTools<=0 && lastAssistantText===prodAssistantSnapshot` → soft skip (dbg only). On success updates at v2 **1616-1617**. `recover()` passes `checkDuplicate=true`.
4. **Startup log line** at v2 **3786-3791**: includes `visibleContinue=${visibleContinue}` (+ accepted-but-inert list).

V2 option-reading style: `const opts = (ctx.options ?? {}) as AutoResumeOptions` at v2 **1100** (v1 uses 2nd factory arg — parity = `options` arg).

---

## Per-item verdicts (ranked by value)

### Item 2: `richContinuePrompt` — **YES, backport** (highest value)

**Why:** v1 sends bare `"continue"` from many stall sites. A rich prompt (reason + attempt + open todos) dramatically improves model compliance on stall recovery, matching v2 behavior.

**Insertion point (v1):**
- New function `buildStallContinueText(sid, reason, attempt)` — insert near `buildOpenTodosReminder` at **~492** (after line 491). Reuses `fetchSessionTodos` (**1206-1236**) for todo suffix. Logic mirrors v2 **1799-1821**.
- New option at **~531** (after `continuePrompt`): `const richContinuePrompt: boolean = (options?.richContinuePrompt as boolean) ?? true`.
- **Call sites to change** (stall path only, scope per user direction):
  - `tryResume` at **2016**: `sendContinuePrompt(sid, prompt ?? await buildStallContinueText(sid, reason, w.resumeAttempts), w)` — but only when `prompt` is undefined (caller didn't pass explicit). Note: `tryResume` is async so `await` is fine.
  - Line **1963** (abort+continue): `sendContinuePrompt(sid, await buildStallContinueText(sid, "abort+resume", w.resumeAttempts), w)`
  - Line **2244** (pending-recovery): `sendContinuePrompt(sid, await buildStallContinueText(sid, w.pendingRecoveryReason ?? "recovery", w.recoveryAttempts), w)`
  - Line **976** (watchdog retry): `sendContinuePrompt(sid, await buildStallContinueText(sid, "recovery", w.recoveryAttempts), w)`
  - Lines **2486-2492** (streaming-failure) and **2533-2538** (silent-dead-stream): these pass `continuePrompt` explicitly to `tryResume`; change to pass `undefined` so `tryResume` builds the rich text.
  - **Do NOT change**: 1138 (unknown-tool, custom prompt), 1903 (tool-text recovery, bestCandidate), 2650/2732 (actionIntent), 2953 (task_complete block), 3061 (TOOL_LOOP_RECOVERY_PROMPT) — these have their own per-kind prompts/budgets.
- **Conflicts:** None with existing guards. `tryResume` is already async. The `prompt` param at **1984** is optional; callers passing explicit prompts (idle-todos at 2302/2607/2611) are unaffected. `minActivityGapMs` check at **1882-1886** is in the tool-text path, not `tryResume`.

**Test file:** `src/index.continue.test.ts` (548 lines, best fit — already tests continue prompt sending). Add tests: rich prompt includes reason+attempt+todo suffix; custom `continuePrompt` wins verbatim; `richContinuePrompt: false` reverts to bare.

---

### Item 3: Exact-duplicate anti-repeat — **YES, backport** (medium value, prevents redundant messages)

**Why:** Prevents sending the same continue text when the model made zero progress (no new assistant text, no tools in flight). Soft skip only; loop window counter stays the backstop.

**Insertion point (v1):**
- New `SessionWatch` fields at end of interface (line 68, after `checkedToolPartIDs` at line 67): `lastProdText: string`, `prodAssistantSnapshot: string`, `lastAssistantText: string`.
- New function `snapshotAssistantText(sid)` — mirrors `lastAssistantEndsWithCelebration` pattern at **1155-1178**: `getSessionMessages(sid)`, find last assistant msg, concatenate text parts, return trimmed string. Insert near **~1180**.
- Gate inside `sendContinuePrompt` at **~855** (after `oocLocked` check, before `w.continuing = true`):
  ```
  if (w.lastProdText !== "" && text === w.lastProdText && w.pendingTools <= 0) {
      const snap = await snapshotAssistantText(sid)
      if (snap === w.prodAssistantSnapshot) {
          dbg(`${short(sid)} duplicate continue suppressed`)
          return
      }
  }
  ```
- On successful send (after **927** `recordContinue`): update `w.lastProdText = text; w.prodAssistantSnapshot = await snapshotAssistantText(sid)`.
- **Cost note:** `snapshotAssistantText` calls `getSessionMessages` (SDK round-trip). `sendContinuePrompt` already calls `getSessionMessages` at **869** for agent/model inference — **reuse that fetch**: extract the last assistant text from the same `msgs` array (pattern at **1155-1178**) instead of a second call.
- **Conflicts:** None. `w.pendingTools` already exists on `SessionWatch` (**line 56**). The gate is a soft skip (no state change beyond dbg), so it cannot interfere with `gaveUp`/`oocLocked`/backoff logic. The `w.continuing` guard at **838** is checked before the dup gate.

**Test file:** `src/index.watchdog.test.ts` (549 lines, tests the stall/retry path). Add: duplicate continue suppressed when no progress; NOT suppressed when assistant text grew; NOT suppressed when tools in flight.

---

### Item 4: Startup log line — **YES, trivial** (low effort, nice-to-have)

**Why:** Reports resolved channel + rich/dup settings, matching v2 diagnostic parity.

**Insertion point (v1):** Line **2984** — append to the existing `log("info", ...)` string:
- ` visible=${true}` (v1 always visible; informational)
- ` rich=${richContinuePrompt}`
- ` dupGuard=${true}` (always on once backported)

No new option needed — just report the resolved values.

**Test file:** `src/index.plugin.test.ts` (655 lines, "Plugin Lifecycle" section at line 28). Add: startup log contains `rich=true` / `rich=false` depending on option.

---

### New item: `silentContinue` opt-out — **PARTIAL / DEFER** (parity stub only)

**User direction:** v1 continues are already visible; v1 stays visible-by-default with an opt-out to silence.

**Problem:** v1 has **only one channel** — `client.session.prompt` = visible. There is no hidden/synthetic channel in v1 (v2 has `ctx.session.hook("message", ...)` for silent). A true "silent continue" in v1 would require either (a) a no-op + log-only (defeats the purpose) or (b) a new hidden mechanism that doesn't exist in the v1 plugin API.

**Recommendation:** Accept the option name for config parity (`silentContinue?: boolean`, default `false`), but **implement as a no-op with a warn log** if set to `true`: `log("warn", "silentContinue=true requested but v1 has no hidden channel; continues remain visible")`. This documents intent, prevents config-porting confusion, and is honest about the limitation. **Assumption:** user accepts this limitation; if true silence is needed, it requires a v1 API extension beyond this backport.

**Insertion point:** Option at **~531** (alongside `richContinuePrompt`); warn-log at **~2984** (startup) or in `sendContinuePrompt` at **~840** (once, via `initialised`-style flag).

**Test file:** `src/index.plugin.test.ts` — assert warn log emitted when `silentContinue: true`.

---

## Suggested option names + defaults (v1 parity)

| Option | Default | v2 equivalent | Notes |
|---|---|---|---|
| `richContinuePrompt` | `true` | v2 `richContinuePrompt` (1118) | Stall-path rich text; custom `continuePrompt` wins verbatim |
| `silentContinue` | `false` | v2 `visibleContinue` (inverted) | No-op + warn in v1 (no hidden channel); parity stub |
| `continuePrompt` | `"continue"` | v2 `continuePrompt` | Existing, unchanged; wins verbatim over rich text |

No env-var reads in v1 (all via `options` 2nd factory arg at line 493). V1 has no `AUTO_RESUME_*` env today. If env parity is desired, add `process.env.AUTO_RESUME_RICH_CONTINUE_PROMPT` fallback — but this deviates from v1's current style (zero env reads); **recommend options-only for v1**.

---

## Test plan

All tests use `bun:test` (existing pattern in `src/index.*.test.ts`).

### Item 2 (rich prompt) → extend `src/index.continue.test.ts`
1. **Rich text includes reason + attempt + todo suffix:** trigger a stall (`tryResume`), assert `promptCalls[0].body` contains `"stalled"` + `"attempt 1/3"` + open todo content.
2. **Custom `continuePrompt` wins verbatim:** set `options.continuePrompt = "keep going"`, assert prompt body === `"keep going"` (not rich).
3. **`richContinuePrompt: false` reverts to bare:** set `options.richContinuePrompt = false`, assert prompt body === `"continue"`.
4. **Todo suffix capped at 5 + "…and N more":** 7 open todos → suffix has 5 bullets + `• …and 2 more`.
5. **No open todos → "No open todos recorded."**
6. **Todo fetch fails → "Todo list unavailable."** (mock `fetchSessionTodos` to throw).
7. **Rich text sliced to 2000 chars.**

### Item 3 (anti-dup) → extend `src/index.watchdog.test.ts`
1. **Duplicate suppressed:** send continue, no assistant-text growth, no tools → second identical continue skipped (no new `promptCalls`).
2. **NOT suppressed when text grew:** assistant text changed since last prod → second continue sent.
3. **NOT suppressed when tools in flight:** `w.pendingTools > 0` → second continue sent.
4. **First send always goes through:** `lastProdText === ""` → no gate.
5. **Gate does not affect `gaveUp`/`oocLocked`/backoff:** those checks still fire independently.

### Item 4 (startup log) → extend `src/index.plugin.test.ts`
1. **Default:** startup log contains `rich=true`, `dupGuard=true`.
2. **`richContinuePrompt: false`:** startup log contains `rich=false`.
3. **`silentContinue: true`:** startup log contains `silentContinue=true` + warn.

### New: `silentContinue` → extend `src/index.plugin.test.ts`
1. **`silentContinue: true`:** warn log "no hidden channel" emitted once at startup.
2. **`silentContinue: false` (default):** no warn.

### Regression
- Run existing `src/index.continue.test.ts`, `src/index.watchdog.test.ts`, `src/index.plugin.test.ts` suites unchanged.
- Run `src/index.pending-recovery.test.ts`, `src/index.silent-dead-stream.test.ts`, `src/index.streaming-failure.test.ts` (stall-path callers affected by item 2).

---

## Summary

| Item | Verdict | Effort | Value |
|---|---|---|---|
| 1. `visibleContinue` | **NO** (v1 already visible) | — | — |
| 2. `richContinuePrompt` | **YES** | Medium (~80 lines) | High |
| 3. Anti-dup gate | **YES** | Medium (~50 lines) | Medium |
| 4. Startup log | **YES** | Trivial (~5 lines) | Low |
| New: `silentContinue` | **PARTIAL** (no-op stub) | Trivial (~10 lines) | Low (parity) |

Total estimated effort: ~150 lines of v1 changes + ~150 lines of tests.
