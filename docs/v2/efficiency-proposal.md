# Auto-resume v2 — efficiency proposal for opencode v2 API limitations

**Status:** proposal (review)
**Source:** `src/v2/index.ts` (6622 lines), `docs/known-issues-v2.md`
**Goal:** keep auto-resume's purpose (stall detection + recovery, subagent/permission awareness, context saturation, todo/task_complete, tool-as-text/done-claim nudges) while cutting the cost and fragility of the v2 API workarounds.

---

## 1. What the v2 port is actually paying for

The v2 API removed or narrowed several surfaces v1 relied on. The port works around each, and each workaround has a recurring cost:

| Limitation | Current workaround | Recurring cost |
|---|---|---|
| No `ctx.app.log` | `appendFileSync` per log line + 2MB rotation | blocking I/O on every log; rotation race; no structure |
| `ctx.session` omits `list`/`active`/`compact` | `callSessionApi` tries domain then client, with try/catch each | 2x call attempts + swallowed errors per lookup |
| `ctx.client` optional, different arg shape, `{data}` envelopes | manual unwrap + fallback in every call site | inconsistent unwrapping; per-call branching |
| `ctx.storage` namespaced per plugin → can't read other plugin's todos | parse 200-message history + loopback HTTP | 200-message fetch per cache miss (3s TTL); `/proc` parse per fetch |
| No todo event | derive todos from `todowrite` tool parts in history | expensive; re-runs on every idle |
| No permission event (assumed) | loopback `session/active` HTTP | HTTP per idle |
| No `config` domain | `ctx.plugin.list()` + cache | one-time, fine |
| Model ref not in watch record on mid-session load | `ctx.session.context()` to find newest assistant model | expensive context() on saturation path |
| Subagent parent link | `ctx.client.session.get` per session, cached | one HTTP-ish call per session |
| Watchdog | 5s global interval + per-session timers; singleton registry for reloads | timer sprawl; complex adopt-state |

The inefficiency is not in any single call but in **repeated, uncached, fallback-heavy access** to the same expensive endpoints (`session.context()`, message history, loopback HTTP) on the hot path (every idle inspection, every watchdog tick).

---

## 2. Principle: resolve capabilities once, then use events

Two rules make most of the cost disappear:

1. **Capability resolution happens once at setup.** Probe which route (domain / client / loopback) actually works for each method, cache the chosen function, and stop branching on every call.
2. **State is maintained from the event stream, not re-queried.** The watchdog already receives `session.idle`, `tool.called`, `session.usage.updated`, `session.created`. Extend that to also capture parentID, model ref, and todowrite results, so the hot path reads in-memory state instead of re-fetching.

---

## 3. Proposed changes

### 3.1 Normalized API client (one-time probe)

Replace `callSessionApi` and the scattered `(ctx.client as any)?.session?.X` calls with a single `api` object built in setup:

```ts
const api = await buildApi(ctx) // probes once: { sessionGet, sessionList, sessionContext, sessionActive, sessionCompact, sessionCommand, sessionPrompt, sessionInterrupt, sessionSynthetic, messageList }
```

- For each method, try domain → client → (loopback only if no in-process route) and **record which succeeded**. Subsequent calls go straight to the winner.
- Centralize `{data}` envelope unwrapping in `api.*`.
- Cache `serverBaseUrls()` result once (it parses `/proc/self/cmdline`); refresh only on a failed fetch.
- Benefit: removes per-call dual try/catch, removes envelope traps scattered across call sites, makes missing routes a setup-time log line instead of a per-idle silent failure.

### 3.2 Cache `session.context()` with TTL + invalidation

`session.context()` is the most expensive call and is invoked from: idle inspection (shared across 4 checks — already good), saturation (model ref), todo derivation (fallback), subagent/orphan paths.

- Add `contextCache: Map<sid, { at, msgs, lastEventAt }>` with a short TTL (e.g. 2s) and **invalidate on any event for that sid**.
- `getContext(sid)` returns cached if fresh and not invalidated; otherwise fetches and stores.
- Benefit: collapses repeated fetches within a turn (idle → pattern pass → saturation) into one, and the pattern pass's re-read becomes a cheap cache hit unless an event arrived (which is exactly when a re-read is wanted).

### 3.3 Event-driven todos (stop parsing 200 messages per idle)

Current: `readTodos` → `todosFromMessageSources` fetches up to 200 messages, cached 3s.

Proposed:
- The `session.tool.called`/`session.tool.success` events do not carry the tool input, so the list still comes from message history. But the events *do* carry the tool name and call id. Use them to set a `todosDirty` flag (and record the pending call id) only when a todowrite tool is involved.
- On idle: if cache is fresh and not dirty, return cached without any fetch. If dirty or cold, fetch history (first page 50, escalate to 200 only if no todowrite part), then mark clean.
- Invalidate the cache on `markBusy` (turn boundary) instead of the 3s TTL — todos can only change while the model works. The 3s TTL was a proxy for "maybe changed"; the turn boundary is the real signal.
- Benefit: removes the 200-message fetch from the common idle path (most idles have no todowrite); keeps correctness on cold start and after a todowrite.

### 3.4 Event-driven subagent detection

Current: `isSubAgentSession` calls `ctx.client.session.get` on first check, cached on watch record.

Proposed:
- If the host emits a session lifecycle event carrying `parentID` (probe the stream first — the current build does not handle one), record `subagentParents.set(sid, parentID)` from it. If no such event exists, keep the `session.get` fallback but cache its result globally (not per-watch) so it is fetched once per session per process.
- `isSubAgentSession` reads the global map; falls back to `api.sessionGet(sid)` only on cache miss (plugin loaded mid-session).
- Benefit: removes repeated get calls; parent link available immediately when the event exists.

### 3.5 Event-driven model ref

Current: saturation path calls `context()` to find the newest assistant model when `w.modelRef` unset.

Proposed:
- On `message.updated` (assistant), set `w.modelRef` from `message.model` if present. Also track on `session.usage.updated`.
- Saturation path reads `w.modelRef` only; if absent, skip (no context() fetch).
- Benefit: removes the context() fetch from the saturation path.

### 3.6 Log file: buffered async writes

- Replace `appendFileSync` per line with a small in-memory buffer flushed by a 250ms timer and on process exit / plugin dispose.
- Keep the 2MB rotation check on flush.
- Optionally write through `ctx.storage` for structured state (quota already there); keep the file for human-readable tail.
- Benefit: removes blocking I/O from the event hot path; rotation check happens once per flush instead of per line.

### 3.7 Permission gating via event state (if available)

Current: loopback `session/active` HTTP to detect a running provider retry.

Proposed:
- Probe whether the host emits permission/active events (`permission.requested`, `session.busy`/`session.idle` already tracked). If yes, maintain `permissionPending` set from events; drop the HTTP check.
- If not, keep the loopback check but cache base URLs (3.1) and add a 5s TTL so repeated idles in the same window don't re-fetch.
- Benefit: removes per-idle HTTP on hosts that expose the event; bounded cost otherwise.

### 3.8 Consolidate timers and reload handling

- One global scheduler (the existing 5s watchdog) drives all deferred passes; per-session `setTimeout`s are replaced by scheduled callbacks keyed by `(sid, kind)` in a map, so a second idle replaces rather than stacks (already intended; centralize).
- Use a single `AbortController` per setup instance; all timers and the event pump attach to its signal. On dispose/reload, abort → all timers cleared deterministically. Removes orphaned-timer risk and the singleton-registry `shareWatchState` gating for tests (tests can inject a scope).
- Keep `shareWatchState` for cross-setup state sharing but gate it behind an explicit opt-in; default off in production? Actually production needs sharing across reloads. Keep default behavior, simplify mechanism: store state on a module-level `Map` keyed by `registryScope`, dispose previous instance's timers via AbortController before adopting.

### 3.9 Reduce message-history fetch size and pagination

- `todosFromMessageSources` and orphan/child checks fetch `/api/session/:id/message?limit=200`. First try `limit=50`; only escalate to 200 if the needed part isn't in the first page. Most recent todowrite/child activity is near the tail.
- For child status, use `session.list({ parentID })` (already does) via the normalized api; no change needed beyond 3.1.

### 3.10 Quota state: storage only

- Already migrated to `ctx.storage` (`resume-quota/<sid>`). Remove any remaining log-marker fallback to avoid a second, lossy channel. If storage absent, degrade to in-memory only (session restart loses the ladder, acceptable).

---

## 4. What stays the same (purpose preserved)

- Stall watchdog with chunk timeout + grace (180s) — unchanged.
- Recovery ladder (inject → abort+resume → give-up) — unchanged.
- Subagent guard (`isSubAgentSession`) — faster detection, same semantics.
- Permission gate — same gate, cheaper signal.
- Context saturation routing (subagent compact / parent magic-context wrapup) — same, minus the context() fetch on the model-ref path.
- task_complete tool + ack escalation — same; registration still best-effort.
- Tool-as-text / done-claim / intent / ready-to-continue nudges — same detectors, cheaper context reads.
- Silent dead stream detection — same judge, shared cached context.
- Orphan parent recovery — same logic, cheaper child checks.

---

## 5. Expected impact

- Hot path (`session.idle` inspection): from 1–3 `session.context()` fetches + a 200-message HTTP fetch + `/proc` parse + per-line fs appends, to mostly in-memory reads + at most one cached context fetch. Roughly an order of magnitude fewer expensive calls per idle.
- Stall watchdog tick: no HTTP, no fs per tick (timers + in-memory).
- Cold-start / reload: capability probe once; state adoption via AbortController instead of scattered cleanup.
- Correctness: fewer silent failures (envelope traps centralized), todos tracked from events so "no todos" conclusions become rarer, context() cache invalidation on events keeps staleness bounded.

---

## 6. Risks and open questions

1. **Event coverage is the bet.** 3.3/3.4/3.5/3.7 assume the host emits `tool.success`, `session.created` with `parentID`, `message.updated` with model, and (ideally) permission events. If an event is absent, each item must fall back to the current behavior — the proposal keeps fallbacks, it does not delete them. Verify against the live event stream before removing a fallback.
2. **Cache TTL tuning.** 2s context cache and turn-boundary todo cache assume events invalidate promptly. If an event is delayed, a stale read could miss a just-landed todowrite; mitigated by invalidating on `markBusy`/`markIdle` boundaries and by the history fallback when dirty.
3. **Loopback removal.** `serverBaseUrls()`/`serverHeaders()` stay as the last-resort route for `session.active` and message history when no in-process route exists. They should not be deleted, only de-prioritized and cached.
4. **Test impact.** Many tests assert on fallback ordering and 3s todo TTL. Changing TTLs and adding event-driven updates will require test updates; the proposal should land behind the existing test suite, not replace it.
5. **Scope.** This is a refactor of access patterns, not a feature change. It should be done incrementally: 3.1 (api client) first, then 3.2 (context cache), then 3.3 (todos), then the rest — each independently verifiable.

---

## 7. Suggested implementation order

1. `buildApi(ctx)` + cached `serverBaseUrls` (3.1) — lowest risk, biggest cleanup.
2. Context cache with event invalidation (3.2) + model ref from events (3.5).
3. Todo event tracking + turn-boundary cache (3.3) + smaller first page (3.9).
4. Subagent parent map from events (3.4).
5. Buffered async log (3.6).
6. Permission/active event or cached HTTP (3.7).
7. Timer consolidation + AbortController dispose (3.8).
8. Quota storage-only (3.10).

Each step keeps the existing tests green; regressions localize to one access pattern.
