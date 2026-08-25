# opencode-auto-resume — OpenCode v2 port: what changed

> Saved from ~/.config/opencode/plugins/README.md on 2026-08-25.
> Drop this into the PR description (or keep as docs/v2-migration.md upstream).
> Target: https://github.com/Mte90/opencode-auto-resume
> Runtime tested against: opencode2 v0.0.0-beta-18050, @opencode-ai/plugin 0.0.0-next-17403

## Summary

Ports the plugin from the v1 hooks API (`Plugin` factory returning a hooks
object) to the v2 promise-plugin API (`Plugin.define({ id, setup })` +
`ctx.event.subscribe()`). All detection/recovery features are preserved.
Strict-mode typechecked against the real installed `@opencode-ai/plugin`
types; validated by a mocked-context runtime suite covering every recovery
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
import { Plugin } from "@opencode-ai/plugin"

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
| `ctx.session.prompt/interrupt/create/get/command/synthetic/generate` + `ctx.session.hook("context")` | direct SDK calls / chat message hooks |
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
- **No history access**: the v2 plugin context does not expose
  `message.list()`. Plugins that need assistant text must accumulate it from
  streaming events (`session.text.delta`, `session.reasoning.delta`).
- **Logging**: write to the console with a prefix instead of `app.log()`;
  opencode captures stdout/stderr into its logs.

## 4. Event payload shapes changed

v1 events were `{ type, properties }`; v2 events are flat
`{ type, created, data }`. Useful v2 session events for watchdog-style
plugins: `session.execution.started/succeeded/failed/interrupted`,
`session.step.started/ended/failed`, `session.text.delta`,
`session.reasoning.delta`, `session.tool.called/progress/success/failed`,
`session.retry.scheduled`, `session.idle`, `permission.asked/replied`.

## 5. Concrete changes in this port

- v1 hooks → v2 `Plugin.define({ id: "auto-resume.v2", setup })` +
  background `ctx.event.subscribe()` pump; cleanup returned from `setup`
  clears the watchdog interval.
- `client.session.prompt({path, body})` → `ctx.session.prompt({ sessionID,
  text })` (a nested-shape fallback is kept while the beta API settles).
- `session.messages()` forensics → live accumulation of assistant text from
  `session.text.delta` / `session.reasoning.delta` events (message history
  is not reachable from the v2 plugin context).
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
plus `maxRecoveryRetries`, `continuePrompt`, `debug`.

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

- `tsc --strict --noEmit` clean against `@opencode-ai/plugin@0.0.0-next-17403`.
- Mocked-context runtime suite (bun): export shape · stall watchdog → prompt ·
  ready-to-continue nudge · tool-call-as-text recovery · loop guard → interrupt ·
  permission-hold blocks recovery · execution-failure recovery · stale recovery
  does not disturb healthy idle sessions · user interrupt honored · cleanup
  quiesces timers — **12/12 passing**.
