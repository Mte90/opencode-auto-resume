# opencode-auto-resume — OpenCode v2 port: what changed

> Drop this into the PR description (or keep as docs/v2-migration.md upstream).
> Target: https://github.com/Mte90/opencode-auto-resume
> Runtime: **opencode v2.0.5 (stable)**. The port has no runtime dependency —
> `src/v2/index.ts` imports only `node:fs`, `node:os` and `node:path`, and
> defines its own `{ id, setup }` helper. `@opencode/plugin@2.0.5` is used to
> typecheck the source, not to run it.
> Originally ported against opencode2 v0.0.0-beta-18050 / @opencode-ai/plugin
> 0.0.0-next-17403; re-validated against the stable release (see §7).

## Summary

Ports the plugin from the v1 hooks API (`Plugin` factory returning a hooks
object) to the v2 promise-plugin API (`Plugin.define({ id, setup })` +
`ctx.event.subscribe()`). All detection/recovery features are preserved.
Strict-mode typechecked against the real `@opencode/plugin@2.0.5` types, and
covered by 233 tests across 20 files driven through the real event stream — one
file per feature area (figures rechecked 2026-10-05 after the todo-branch fix
ports; repo-wide total in the suite footer below counts v1+v2).

## 1. Config key renamed: `plugin` → `plugins`

```jsonc
// v1 (removed)
{ "plugin": ["some-package", ["./local.ts", { "opt": 1 }]] }

// v2
{
  "plugins": [
    "some-package",
    { "package": "./local.ts", "options": { "opt": 1 } }
  ]
}
```

The tuple form `[path, options]` is gone — use the object form with
`package` + `options`. Local paths must start with `./` or `../` and resolve
relative to the config file. Disable directives (`"-plugin-id"`, `"*"`)
still work and are matched against the plugin's exported `id`.

## 2. Module shape: hooks-object → `{ id, setup }`

```ts
// v1: export a factory that returns a Hooks object
export const MyPlugin: Plugin = async ({ client, $, directory }) => ({
  event: async ({ event }) => { /* ... */ },
  "tool.execute.before": async (input, output) => { /* ... */ },
})

// v2: default-export Plugin.define with a unique id and a setup fn.
// setup registers long-lived behavior and MAY return a cleanup function,
// which OpenCode awaits on disable/reload/shutdown.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "acme.thing",            // unique — used by disable directives
  setup: async (ctx) => {
    /* register timers/subscriptions here */
    return () => { /* cleanup */ }
  },
})
```

Legacy single-function modules are still loaded through a compatibility
shim, but new code should target v2 directly.

## 3. Context capabilities replace most hooks

The v2 context is essentially a typed server client plus registration APIs:

| v2 capability | Replaces (v1) |
|---|---|
| `ctx.event.subscribe()` → **AsyncIterable** of events | `event` hook |
| `ctx.session.prompt/interrupt/create/get/command/synthetic/generate` + `context/wait/switchAgent/switchModel/rename/update/move` + `ctx.session.hook(...)` | direct SDK calls / chat message hooks |
| `ctx.tool.transform` / `ctx.tool.hook` | `tool` map, `tool.execute.before/after` |
| `ctx.agent.transform` | agent config mutation |
| `ctx.options` | second `options` argument of the v1 factory |
| `ctx.app` | `{ name, version, channel }` only — **no `app.log()`** |

Notes:
- **Subscribe, don't block**: start the event pump in the background inside
  `setup`; do not `await` an infinite loop there.
- **Flattened SDK calls**: nested `{ path, query, body }` envelopes are gone.
  Example: `session.prompt({ path: { id }, body: { parts } })` became
  `session.prompt({ sessionID, text })`.
- **History access**: beta exposed no message-history API, so plugins that
  needed assistant text had to accumulate it from streaming events
  (`session.text.delta`, `session.reasoning.delta`). **Stable adds
  `ctx.session.context({ sessionID })` → `SessionMessageInfo[]`**; the port
  keeps the deltas for liveness and uses `context()` as the authoritative
  final text at idle time.
- **Logging**: write to the console with a prefix instead of `app.log()`;
  opencode captures stdout/stderr into its logs.

## 4. Event payload shapes changed

v1 events were `{ type, properties }`; v2 events are flat
`{ type, created, data }`. Useful v2 session events for watchdog-style
plugins: `session.execution.started/succeeded/failed/interrupted`,
`session.step.started/streamed/ended/failed`, `session.text.started/delta/ended`,
`session.reasoning.started/delta/ended`,
`session.tool.input.started/delta/ended`,
`session.tool.called/progress/success/failed`, `session.shell.started/ended`,
`session.retry.scheduled`, `session.compaction.*`, `session.status`,
`session.idle`, `session.deleted`, `permission.asked/replied`.

Two shape details the port relies on:

- `session.execution.interrupted` carries `data.reason`
  (`"user" | "shutdown" | "superseded" | "inactivity"`) — only `"user"` should
  suppress recovery.
- `session.idle` is a separate ephemeral event (`data.sessionID`);
  `session.status` carries `data.status.type` (`"idle" | "retry" | "busy"`).

## 5. Concrete changes in this port

- v1 hooks → v2 `Plugin.define({ id: "auto-resume.v2", setup })` +
  background `ctx.event.subscribe()` pump; cleanup returned from `setup`
  clears the watchdog interval.
- `client.session.prompt({path, body})` → `ctx.session.prompt({ sessionID,
  text })` (flat input; the beta-era nested-shape fallback was removed once
  stable confirmed the flat contract).
- `session.messages()` forensics → live accumulation of assistant text from
  `session.text.delta` / `session.reasoning.delta`, with
  `ctx.session.context({ sessionID })` as the authoritative idle-time read.
- Recovery notifications use `ctx.session.synthetic({ sessionID, text,
  description, resume })` so the intervention is visible in the TUI, falling
  back to `session.prompt({ sessionID, text })`.
- **The todo list is read from the session message log, not from storage.** v2
  emits no `todo.updated` event and exposes no todo route — and, decisively,
  **`ctx.storage` is namespaced per plugin**, so it cannot read another plugin's
  todo list at all. `ctx.storage.get("todos/<id>")` resolves to
  `storage/plugin/auto-resume.v2/todos/<id>.json`; a todo plugin writing that key
  lands under its own plugin id. Verified live: the route is
  `/api/plugin/storage/<PLUGIN-ID>/<key>` and the on-disk tree is
  `storage/plugin/<PLUGIN-ID>/<key>.json`. A storage-first reader therefore
  concludes "no todos" regardless of who writes, and fires false done-claim
  nudges.

  Every `todowrite` call is persisted as a tool part whose input carries the whole
  list, so the newest **completed** call is the current list. It is read via
  `ctx.client.session.message.list`, falling back to a loopback
  `GET /api/session/{id}/message?limit=200` (that endpoint answers
  `{ data, cursor }`, never a bare array; 200 is its ceiling; results are ordered
  newest first, so a last-match-wins parser would select the OLDEST list). One
  measured detail worth keeping: the tool parts carry no `state.time`, so ranking
  must fall back to the enclosing message's `time.created` — under newest-first
  ordering that fallback is load-bearing, not cosmetic.

  `ctx.storage` remains only as a last-resort fallback. Do not "fix" the namespace
  mismatch by having auto-resume write the key: a reader cannot surface another
  plugin's data, and a second writer would race the first.
- **New host access beyond the plugin context.** `readFileSync` on
  `/proc/self/cmdline` to discover the local server's `--port`, plus a loopback
  HTTP GET. Env vars alone are not enough: under OpenChamber the server is spawned
  as `opencode serve --hostname 127.0.0.1 --port <n>` and exports no port variable,
  so an env-only candidate list comes back empty and the HTTP source is never
  attempted at all. Every one of these is best-effort — a host that refuses them
  degrades to "cannot read todos", never a crash — and where `/proc` is
  unavailable the plugin falls back to env-var discovery.
- `ctx.client.app.log(...)` → prefixed console logging.
- Status polling demoted: session state comes primarily from lifecycle
  events; a low-frequency interval cross-checks active sessions for silence
  only.
- New guards made possible/necessary by v2 semantics:
  - `permission.asked` / `permission.replied` hold off recovery while a
    permission dialog is open.
  - Subagent-aware waiting: a parent silent right after dispatching a task
    tool with other sessions running is left alone.
  - Failure-triggered recoveries arm a flag so the failure's own idle
    transition doesn't cancel the scheduled retry prompt, while a healthy
    completion still cancels stale ones.
  - `ctx.event.subscribe({ signal })` + `AbortController` so the event stream
    is torn down on unload instead of staying suspended in `for await`.
  - User-interrupt detection uses `session.execution.interrupted`'s `reason`
    (stable) instead of assuming every non-plugin interrupt was the user.

## Feature parity retained

Stall watchdog · failure recovery with exponential backoff → interrupt+resume
escalation · tool-call-as-text detection · "ready to continue"/action-intent
nudges · done-claim verification · hallucination-loop guard (N continues in
window → abort+resume) · tool-loop pattern detection · user-interrupt
respected.

## Options

The port reads **all 31 of v1's options** and applies **all 31**. Names and
defaults are unchanged, and the full table is in the
[README](../../README.md#configurable-options). Two defaults moved after both
builds picked them up from upstream: `chunkTimeoutMs` to 180000 (`49957b2`) and
`activeUserWindowMs` to 300000 (`e1b8374`).

Two options are **v2-only**, with no v1 equivalent, because v2 removed the
capability they configure:

- `logFile` — v2 has no server log endpoint, so the plugin writes its own
  (2 MB cap, `AUTO_RESUME_LOG_FILE` overrides).
- `injectIntervalMs` — a floor on how often one session may be nudged.

For the record, this list is checked against the source in both directions: a test
fails if an option joins the recognised set without being implemented, and the
doc check fails if the table names one that is not gated.

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/auto-resume-v2.ts",
      "options": { "chunkTimeoutMs": 180000, "maxRetries": 3 }
    }
  ]
}
```

Disable by id without touching other plugins: add `"-auto-resume.v2"`.

## Testing

- `tsc --strict --noEmit` clean against **`@opencode/plugin@2.0.5`** (stable).
- Runtime suite (bun, 20 files / 233 tests, rechecked 2026-10-05) against the stable API:
  definition shape · `subscribe({ signal })` · abort-on-cleanup · stall watchdog
  → `synthetic` with visible `description` + `resume` · idle forensics via the
  `session.context()` fallback · healthy idle turn is a no-op · permission-hold
  blocks recovery · `interrupted` `reason="user"` disables recovery ·
  `reason="inactivity"` does **not** · execution-failure recovery ·
  `synthetic`→`prompt` fallback · `session.deleted` drops state —
  Each later feature area has its own file: unknown tool suggestions,
  silent dead streams, premature stop, context saturation, the todo list, explicit
  `task_complete`, reasoning-tool recovery, orphan parent recovery, the settle
  delay, session discovery, the options surface, and the hand-off and stand-down
  guards — plus cross-instance duplicate suppression, the inject mutex and
  singleton registry, the quota ladder, parent-wait on live subagents, and the
  visible channel with rich stall text.

  Two tests in the settle-delay file were **vacuous** on the first pass — they
  passed whether or not the code under test ran. Every test in the v2 port is now
  mutation-checked: removing the delay, the arming, the history re-read, either
  guard re-run, the cancel latch, the new-turn cancel or the cleanup each turns
  the file red. A negative test that never fails is indistinguishable from a
  detector that never runs.

## 7. Re-validated against stable v2 (2.0.5)

The port was originally written against the beta (`@opencode-ai/plugin`
`0.0.0-next-17403`). Re-checked against the stable release:

- **Package renamed**: the API types are now **`@opencode/plugin`** (stable
  `2.0.5`), published from the opencode repo; the beta `@opencode-ai/plugin` is
  not the stable API. The port typechecks against those types but does not import
  them — it declares `{ id, setup }` locally, so a **local-file install needs no
  `bun add` at all** and the built artefact is a single self-contained file.
  Config/discovery is unchanged (`plugins` key, object form, and plugins under
  `.opencode/plugin/` **or** `.opencode/plugins/` are auto-loaded).
- **Every event the plugin matches still exists** in 2.0.5, with the same names
  (`session.execution.succeeded` is still `succeeded`, not `completed`). New,
  unused-by-us events: `session.status`, `session.text.started`,
  `session.step.streamed`, `session.tool.input.*`, `session.compaction.*`,
  `session.message.content.updated`.
- **`session.execution.interrupted` gained `data.reason`**; the port now treats
  only `"user"` as a user-cancel.
- **`session.reverted` is gone** in v2 (reverts surface as
  `session.revert.cleared` / `session.revert.committed`); the legacy matcher is
  kept defensively and `session.deleted` handles cleanup.
- **New session methods** on the plugin context: `context()` (message history),
  `wait()`, `switchAgent()`, `switchModel()`, `rename()`. The port adopts
  `context()` for idle-time forensics; `wait()` is intentionally unused (the
  event-driven watchdog is retained).
- **`ctx.session.synthetic()` still accepts `description` and `resume`** in its
  input (both optional), so the visible-notification + resume path is unchanged.
  `ctx.session.interrupt()` input is `{ sessionID, resume? }`.
- **Docs recommend `ctx.event.subscribe({ signal })`** and aborting the stream
  during cleanup; the port now does this with an `AbortController`.
- **Local-file installs need nothing installed.** opencode loads a local `.ts`
  plugin with a normal ESM import, so *a plugin that imports the API package*
  would have to have it resolvable and would need a restart. This port does not
  import it, which removes that constraint — copy the file and restart. A
  *published* plugin that later does import it should declare
  `@opencode/plugin` in its `dependencies` (replacing `@opencode-ai/plugin`).
