# Known issues — v2 port

Status of the v1 → v2 port as of the current branch. This file is the
authoritative list; the code refers back to it by name from the startup path, so
a config key that this build ignores is never silent.

## Options that are accepted but not applied

These keys are read without error, and are listed in the plugin's startup line as
`accepted-but-inert=…`. They stay in `AutoResumeOptions` so an existing v1
config keeps loading unchanged.

| Option | Why it is inert on v2 |
| --- | --- |
| `silentDeadStreamMinTokens` | The heuristic it tunes compares generated token count against a floor. That count is a single assistant message's output, not the session's cumulative usage, and v2 exposes no per-message stream for it. |
| `subagentWaitMs` | The v1 orphan-watch timer that this delays has no v2 counterpart; the v2 port decides parent-vs-stalled from its own event-derived busy set. |
| `toolTextCheckDelayMs` | The delayed raw-tool-call-as-text re-check is v1's polling shape. v2 evaluates the text once, on idle, from the authoritative message history. |
| `thinkingToolRecoveryPrompt` | The thinking-contains-a-tool-call detector is part of the v1 idle-nudge pass and is not ported. |
| `doneWithoutWorkPrompt` | Both v1 use sites for this prompt are gated on tracked todo state. v2 has no todo state, so the prompt has no trigger. |

`doneWithoutDetailsPrompt` **is** applied on v2, and is the replacement for
`doneWithoutWorkPrompt`: it fires on a terse done-claim regardless of todos.

## Unrecognised options warn once

Any key in the plugin's config that is not in the recognised set produces a
single `warn` line at startup:

```
[auto-resume] ignoring unrecognised option(s): foo, bar — this v2 build does not read them.
```

This is a v2 addition. v1 silently ignored unknown keys, which is how a typo or
a dropped port went unnoticed.

## Counter semantics changed from v1

`targetedRecovery` now counts an attempt only after the prompt is actually
delivered. v1 incremented first and lost the budget when a send was rejected;
the fix is mte090's `e1b8374`, applied to the v2 code path. The stall path
(`recover`) keeps v1's ordering — it escalates on a stall, not on a send.

## Renamed and aliased

- `maxRetries` is the v2 name. `maxRecoveryRetries` is v1's name for the same
  knob and is still accepted as a fallback, so a v1 config ports unchanged.
- `activeUserWindowMs` defaults to `300000` (5 min) in the v2 build, matching
  upstream `e1b8374`. The v2 port shipped with `900000`, which stood down for
  three times longer than intended after any user message. The v1 file on this
  branch still reads `900000` because it predates `e1b8374`; the PR does not
  touch v1, and master already carries the fix.

  Lowering the default was not enough on its own: the v2 implementation asked
  "is the newest message a user message?" rather than v1's "was any inbound user
  message inside the window?". At idle time the newest message is the assistant
  turn that just finished, so the window never applied and the nudge fired
  straight over a user who was mid-conversation. The check now walks back for
  the most recent user message, which is what the option describes.

## v2-only options

- `injectIntervalMs` — minimum gap between recovery injections for one session.
  No v1 equivalent.
- `logFile` — where this build writes its log. See "Logging" below.

## Logging: there is no server log sink in v2

v1 logged through `ctx.client.app.log({ body: { service, level, message } })`,
which landed in the opencode log file. v2 removed that endpoint: `ctx.app` is
`{ name, version, channel }` (`packages/plugin/src/app.ts`), there is no `app`
group under `packages/protocol/src/groups/`, and a hosted plugin's
`console.log` is not captured by the OpenChamber process.

A build that only writes to the console is therefore **silent** — a running
watchdog and a dead one look identical, and there is no way to tell from
outside whether a stall was seen, skipped, or recovered. This v2 build appends
to a file instead:

```
~/.local/state/opencode-v2/auto-resume.log     # default
```

Override with the `logFile` option or the `AUTO_RESUME_LOG_FILE` environment
variable; the option wins. The file is truncated once it passes 2 MB, and every
write is best-effort — an unwritable log directory never breaks the watchdog.

Each line is `ISO-8601 LEVEL [auto-resume] message`. The startup line lists the
effective timings, so a build that loaded at all is provable from the file:

```
2026-10-01T18:02:28.412Z INFO  [auto-resume] ready (opencode v2). timeout=180000ms interval=5000ms ...
```

## Session discovery

v1 swept `session.list()` on an interval and trusted a `status` field per row.
v2 has something better: `session.active()` is the server's own record of what
is running, so "busy" is read rather than guessed. The sweep runs once at
`discoveryDelayMs` (default 5s) and then every 60s, and it:

- seeds a watch for any session that exists, so cleanup and revert handling know
  about sessions that predate the plugin load, and
- marks any session the server reports as running as busy, so a turn that was
  already mid-flight when the plugin attached starts its stall clock now rather
  than never.

Both calls are read defensively — off the plugin `session` domain first, then
off the raw client — because v2 hands plugins a narrowed `Pick` that omits both.
A host that supplies neither degrades to the event-derived busy set rather than
failing.

## Premature stop — the case the stall watchdog cannot see

A session can end its turn cleanly while the work is not done: no stall, no
error, no streaming failure, just a short "Task done." and then idle. The stall
watchdog only looks at *busy* sessions, so this is invisible to it by
construction. Two detectors run on the idle path instead, both ported from v1:

- **A done-claim with no work report in it.** v2 used to gate the details prompt
  on a 400-character threshold, which cannot tell "Task done." from a real
  two-line summary — it both over-nudged terse reports and let short real ones
  pass. It now uses v1's `containsWorkDescription`: a backticked or bare path
  with a dotted extension, or a report header (`Changed`, `Verification`,
  `Tests run`, `Results`, `Commands run`). Asking again after a genuine report
  loops forever, which is issue #26.
- **A trailing 🎉.** That is the model's own "I finished" signal, so the plugin
  latches completion and stops nudging rather than talking over a deliberate
  stop. The latch is per-turn: a new turn re-opens the question, and a later
  idle with no new text does not re-derive it forever.

v1 cross-checks both against tracked todo state before latching. v2 has no todo
state yet, so the emoji latches on its own — see `doneWithoutWorkPrompt` in the
inert table above for what that costs.

## Context saturation

A session can fill its context window without ever looking stalled — it just keeps
working until it chokes. On idle, when used/usable crosses
`contextSaturationThreshold` (default 0.85), routing depends on session kind,
exactly as in v1:

- **Subagent** — opt-in only. With `subagentNativeCompactionEnabled: true` the
  plugin requests native compaction. v1 called `session.summarize()`; v2 spells it
  `session.compact`.
- **Parent** — only when magic-context is installed, because its setup disables
  native compaction and compacting here would double-compress. The plugin sends
  the `ctx-wrapup` command through `session.command`, not as prompt text, since
  prompt text is not expanded into a command.

Both are one-shot per turn, and both are fail-safe: a missing limit, a missing
token count, a user cancellation, or a signalled completion means no intervention
at all.

Three v2 API shapes are worth recording, because each replaced something v1 had:

| Need | v1 | v2 |
|---|---|---|
| Tokens in the window | accumulated from `message.updated` | `session.usage.updated`, summing `input + output + reasoning + cache.read + cache.write` — the same five fields v1 added up, matching `TokenUsage.total` |
| The model's window | walk the raw provider list for `limit` | `ctx.model.get(providerID, modelID)` → `Model.Info.limit` |
| Is magic-context installed? | `config.get().plugin` | `ctx.plugin.list()` → `Plugin.Info[]`; v2 removed the `config` domain |

The usable window is `limit.context - Math.min(20_000, limit.output)` — v1's
arithmetic, kept identical so the same threshold means the same thing on both
builds.
