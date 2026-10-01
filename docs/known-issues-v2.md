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
| `subagentWaitMs` | The v1 orphan-watch timer that this delays has no v2 counterpart; the v2 port decides parent-vs-stalled from its own event-derived busy set. |
| `toolTextCheckDelayMs` | The delayed raw-tool-call-as-text re-check is v1's polling shape. v2 evaluates the text once, on idle, from the authoritative message history. |

`doneWithoutDetailsPrompt` and `doneWithoutWorkPrompt` **are** both applied on
v2, and they are the two halves of v1's done-claim handling: the first asks for a
work report when there is no list to check, the second when the list still has
items open.

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

v1 cross-checks both against tracked todo state before latching. v2 now does too —
see "The todo list" below.

## The todo list

v1 tracked a session's todos from a `todo.updated` event, falling back to a server
API. v2 has neither: the `todo` table is created in the v2 database (migration
`20260127222353_familiar_lady_ursula.ts`) but no route reaches it and nothing
emits an event for it, so there is no way to observe the list changing.

What v2 does have is the storage domain, and the installed todo tool already
writes the list there under a stable per-session key —
`ctx.storage.set("todos/<sessionID>", { todos, updatedAt })`. auto-resume reads
that key instead of owning a list of its own.

The consequence worth stating: auto-resume is a **consumer**, not a second owner.
It works with whichever todo tool is installed rather than requiring its own, and
there is no copy to drift. It only ever calls `get`. With no `ctx.storage` at all,
or with a record it cannot parse, it falls back to "no list" — which means the
older behaviour (latch on the emoji, ask for details on a bare done-claim), never
a nudge on the strength of a list it failed to read.

Three places consume it:

- **The 🎉 cross-check.** The emoji alone is not trustworthy: a model that
  finishes early celebrates early, and latching on that turns a false positive
  into permanent silence. With items still open, the celebration is a false
  positive and the reminder names what is unfinished. This branch deliberately
  does **not** latch, so the next turn is free to judge again.
- **`doneWithoutWorkPrompt`.** A done-claim with open todos. Distinct from
  `doneWithoutDetailsPrompt`, and on a separate budget — two different problems,
  so spending one must not silence the other.
- **`todoCheckAttempts`.** The last v1 use of the list that is not here: a turn
  that says "ready to continue" while every todo is already closed gets two
  chances before a plain `continue`.

One fix came with the list. The done-claim budgets no longer reset on every busy
cycle — only on a genuinely new inbound user message. v1 moved both out of the
busy reset for #26: a model that re-announces completion each turn was otherwise
handed a fresh budget each time it announced, so the nudge never stopped. v2
still had that, and now does not. The open-todos nudge is the opposite case and
does reset per cycle, because an open list is new information each turn.

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

## Silent dead stream

A turn can end having produced nothing the user can see: reasoning only, or a
finish reason the provider did not describe. OpenCode records the message as
completed and the session goes idle, so no stall timer expires, no streaming
failure fires, and the stall watchdog — which only looks at *busy* sessions —
never sees it. v1's rule is unchanged on v2: walk back to the newest assistant
message that **has** a finish reason; if it carried no text and generated at least
`silentDeadStreamMinTokens` output tokens, the stream died mid-response.

The walk skips messages with no finish reason on purpose. An intermediate
tool-call step has none, and stopping at it would report a dead stream for every
session that used a tool.

Two things are worth recording about the v2 API:

- The judge is the message, not the event stream, so this needs
  `session.context()` — every message since the last compaction. The idle
  inspection now fetches it **once** and shares it across four checks (dead
  stream, text fallback, pending tool call, active user), where v1 fetched once
  for the same reason and this port initially fetched three times.
- Before injecting, the plugin asks the server whether the session is running
  again (`session.active()`), not only its own event-derived flag. A provider
  quietly retrying looks identical from the event stream, and the recovery event
  may not have arrived by the time the turn ends.

## A tool call written into the reasoning block

When a model writes raw tool-call markup inside its thinking instead of calling
the tool, nothing executes and nothing raises. No part is tagged as a tool call,
so no session-side code runs it; the turn completes normally, the prose may read
fine, and the work silently does not happen.

v1 caught this on the same pass as the text variant and answered with a different
prompt, because the fix is different — the model is not forgetting the tool
mechanism, it is writing in the wrong channel. v2 separates the two reads instead
of filtering them into one joined string, since `AssistantContent` tags reasoning
and text distinctly:

- reasoning parts are judged first, because a message can carry both and the
  reasoning one is the one that silently does nothing;
- both variants share the `toolTextAttempts` budget, because they are one
  phenomenon with two symptoms — two budgets would let the plugin spend twice the
  retries on a model that keeps doing it;
- both use the same code-block stripping, so a fenced example of the format or an
  inline path in backticks is not mistaken for a real call.
