# opencode-auto-resume — OpenCode v2 port: what changed

> Drop this into the PR description (or keep as docs/v2-migration.md upstream).
> Target: https://github.com/Mte90/opencode-auto-resume
> Runtime: **opencode v2.0.5 (stable)** with **@opencode/plugin 2.0.5**.
> Originally ported against opencode2 v0.0.0-beta-18050 / @opencode-ai/plugin
> 0.0.0-next-17403; re-validated against the stable release (see §7).

## Summary

Ports the plugin from the v1 hooks API (`Plugin` factory returning a hooks
object) to the v2 promise-plugin API (`Plugin.define({ id, setup })` +
`ctx.event.subscribe()`). All detection/recovery features are preserved.
Strict-mode typechecked against the real `@opencode/plugin@2.0.5` types;
validated by a mocked-context runtime suite covering every recovery
path (12/12 checks).

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

Unchanged names/defaults from v1: `chunkTimeoutMs` (45000), `gracePeriodMs`
(3000), `checkIntervalMs` (5000), `maxRetries` (3), `baseBackoffMs` (1000),
`maxBackoffMs` (8000), `loopMaxContinues` (3), `loopWindowMs` (600000),
`maxRecoveryRetries` (2), `debug` (false), plus the prompt overrides
`continuePrompt`, `toolTextRecoveryPrompt`, `doneWithoutWorkPrompt`,
`actionIntentPrompt`.

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/auto-resume-v2.ts",
      "options": { "chunkTimeoutMs": 45000, "maxRetries": 3 }
    }
  ]
}
```

Disable by id without touching other plugins: add `"-auto-resume.v2"`.

## Testing

- `tsc --strict --noEmit` clean against **`@opencode/plugin@2.0.5`** (stable).
- Mocked-context runtime suite (bun, 12 tests) against the stable package:
  definition shape · `subscribe({ signal })` · abort-on-cleanup · stall watchdog
  → `synthetic` with visible `description` + `resume` · idle forensics via the
  `session.context()` fallback · healthy idle turn is a no-op · permission-hold
  blocks recovery · `interrupted` `reason="user"` disables recovery ·
  `reason="inactivity"` does **not** · execution-failure recovery ·
  `synthetic`→`prompt` fallback · `session.deleted` drops state —
  **12/12 passing**.

## 7. Re-validated against stable v2 (2.0.5)

The port was originally written against the beta (`@opencode-ai/plugin`
`0.0.0-next-17403`). Re-checked against the stable release:

- **Package renamed**: the dependency is now **`@opencode/plugin`** (stable
  `2.0.5`), published from the opencode repo. The beta `@opencode-ai/plugin`
  package is not the stable API. Imports must use `@opencode/plugin`.
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
