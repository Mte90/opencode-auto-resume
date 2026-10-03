# Known issues — v2 port

Status of the v1 → v2 port as of the current branch. This file is the
authoritative list; the code refers back to it by name from the startup path, so
a config key that this build ignores is never silent.

## Options that are accepted but not applied

**None.** Every option this build recognises is now applied, and the startup line
no longer carries an `accepted-but-inert=…` note.

The machinery is kept rather than deleted. It is the only signal a user gets that
an option is being ignored, and the next unported feature needs it more than this
build does. `docs/known-issues-v2.md` and the README inert list are checked
against `FEATURE_GATED_OPTIONS` in the source, and a test asserts the list is
empty — so adding an option to the recognised set without implementing it cannot
pass quietly.

Two gaps closed on this branch, in order: `subagentWaitMs` and
`discoveryDelayMs` (orphan-parent recovery and session discovery), then
`toolTextCheckDelayMs` (below).

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

What v2 does have is the **session message log**: every `todowrite` call is
persisted as a tool part whose input carries the whole list, so the newest
completed call *is* the current list. auto-resume reads that, instead of owning a
list of its own.

`ctx.storage` looks like the obvious store and is not one. It is namespaced per
plugin: a key resolves to `storage/plugin/<PLUGIN-ID>/<key>.json`, and the route is
`/api/plugin/storage/<PLUGIN-ID>/<key>`. A todo plugin writing
`todos/<sessionID>` therefore lands in its own directory, so this plugin reading
the same key is reading a key nothing wrote — regardless of who writes what. A
storage-first reader concludes "no todos" while the list sits in the message log,
and fires false done-claim nudges at a session that still has work listed.

The consequence worth stating: auto-resume is a **consumer**, not a second owner.
It works with whichever todo tool is installed rather than requiring its own.
Confirmed against `opencode-todo-fork`; other todo plugins are unconfirmed.
There is no copy to drift. It calls `get` on storage only after the message log has
come up empty. With no `ctx.storage` at all, or with a record it cannot parse, it
falls back to "no list" — which means the older behaviour (latch on the emoji, ask
for details on a bare done-claim), never a nudge on the strength of a list it failed
to read.

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

## The settle delay before a turn is judged

v1 never judges a finished turn on the `session.idle` event. It arms a timer for
`toolTextCheckDelayMs` and runs the done/tool checks from there, and the option
is the delay. That is not incidental: `session.idle` can arrive while the
assistant's closing text is still being written into the message history, so a
check that reads too early sees a half-finished turn — missing the pattern it
should have caught, or judging a turn that was not over.

The v2 port judged on the idle event for most of its life, on the strength of the
live delta buffer: the plugin sees text as it streams, so it usually has the final
turn before `session.idle` arrives, which is more reliable than waiting. It does
not remove the race. The buffer is empty when the plugin loads mid-turn, and the
fallback in that case is precisely the history that may not have flushed.

So the work is split in two, and the option tunes the half that needs it:

| Pass | When | What it decides |
|---|---|---|
| structural | on `session.idle` | dead stream, user hand-off, user recently active |
| pattern | `+` `toolTextCheckDelayMs` | celebration, tool-call-as-text, ready-to-continue, action intent, done-claim |

The structural pass is immediate on purpose. A stream that died before delivering
any text is exactly the case where every pattern check has nothing to look at, so
waiting would only delay a recovery that is already certain.

The pattern pass re-reads the history rather than reusing the first read, which
is the whole point: text that landed after the idle event is what it judges. It
also **re-runs the structural guards** instead of trusting the first pass's
verdict, because the wait is long enough for the user to have replied — and a
synthetic nudge sent over a real reply is the "Step interrupted" bug those guards
exist to prevent.

Three lifecycle details, all covered by tests:

- A **new turn cancels** a pending pass. `markBusy` clears the timer, and the
  timer itself re-checks that the session is still idle: a queued callback can
  outlive the turn that armed it.
- A **second idle replaces** the first rather than stacking a second judgement on
  the same text. Two passes on one turn would spend two attempts of one budget on
  one piece of text, and the second would be a nudge about a nudge.
- **Stopping the plugin drops** any pending pass. Otherwise a reload leaves a
  timer pointing at a session this build is no longer watching, and it fires
  minutes later against a history nobody is reading.

### One difference worth naming

v1's `checkForToolCallAsText` bundles every text-based detector behind this one
timer. v2's detectors were separate before the option was honoured, so the delay
applies to the pattern pass as a whole rather than to the tool-call-as-text check
specifically. Nothing is lost by it — every detector that reads the closing text
gets the settle window, which is what the delay was for.

## Orphan parent recovery

v1 detects the busy-count drop from more than one session to exactly one and
treats the survivor as a parent whose subagent died. That is the right
*signal* and the wrong *conclusion* on a busy box, and v2 can do better because
v2 records the parent link.

**The port asks whether the survivor actually has children before arming.** One
`session.list({ parentID })` call at arm time turns a guess into a fact. v1 has no
way to ask — it treats *any other busy session* as a subagent of the one in hand
— so on a box with two conversations open it aborts one of them when the other
finishes. The `parentID` filter is requested *and* the returned rows are checked
against it client-side, because the only consequence of the filter being quietly
ignored would be aborting real sessions.

**A child is judged on what it last did, not on whether the server still lists
it.** v1's `checkSubagentStatus` scans the global status map for a *busy*
session and reports "idle" when it finds none. That reading cannot work here:
this function is only ever reached *after* a child went idle, so a child being
absent from the active set is the premise rather than the finding. Read that way,
every crashed subagent looks healthy, the child is never woken, and the parent is
aborted on the first tick. So the three cases are:

- **recent** — whatever the server thinks, the child said something inside the
  window, so believe it. If it is also active, keep waiting.
- **silent past the threshold, tool call outstanding** — a long build, not a
  dead model. The window is tripled, and the parent is left alone. Killing the
  parent there loses the work.
- **silent past the threshold, or an errored message** — it stopped without
  reporting. Worth one attempt to wake it.

**Waking the child is tried once per episode.** v1's structure assumes the subagent
goes busy again after the prompt; a dead one never does, so an unbudgeted
retry sends the same nudge on every watchdog tick. The sequence is: nudge once,
wait a further `subagentWaitMs`, and abort the parent only if the child is still
dead. v1 sends the prompt through the client route; v2 uses the plugin-scoped
`synthetic` endpoint, which takes an explicit `sessionID` and so needs no
cross-session route the plugin API does not expose.

**In-flight tools are tracked from the tool lifecycle events** — `tool.called`
increments, `tool.success` and `tool.failed` decrement — rather than from a
`tool.execute.before` hook, because v2 emits all three and the hooks would be a
second source of truth for the same fact. Both terminal events matter: a *failed*
tool is finished work, and holding the slot on failure would make the watch defer
on every session that has ever seen an error. A session that goes idle has its
slots cleared, since a slot still held there belongs to a tool that will never
report.

### What still bounds the risk

`subagentWaitMs` is the guard. Between a child finishing and the parent being
aborted, the parent is given this long to consume the child's result — the
default is 15s. v1's logic aborts as soon as no subagent is active, and so does
this; the option is what makes that survivable, and its name is the warning. Set
it small and the watch becomes a blunt instrument. Lower it only if you have
watched a parent wait minutes on a dead child.

Two further guards, both checked before anything is interrupted: a parent with a
tool in flight is never aborted, and neither is one whose newest message is
waiting on the user.

A give-up path bounds the whole thing: after `maxRetries` episodes the watch
disarms and logs it, rather than retrying a parent that has already survived
several aborts.


## Unknown tool names

v1 asks `ctx.client.tool.ids()` for the registered tool names. v2 has no such
route, so the port uses `ctx.tool.list()`, which returns the same set of
definitions. Only the effective names are needed — nothing else in the record is
read — and the effective name is the namespaced form when a tool sits in a
namespace, which is exactly the string a model would have to call. That is what
the suggestion quotes back.

The tool parts come from the message history, not from events, and that is not a
workaround: the thing being looked for is a part that already **errored**, and by
the time the error lands the `session.tool.called` event for that part is long
gone. This code only runs on idle anyway.

Two shape differences from v1, both of which would have made the check inert
rather than wrong — worth naming because an inert detector is the failure mode
that does not announce itself:

- v1 reads the tool name from `part.tool`. v2 has no such field; the name is in
  `part.name`. A port that kept v1's read would compare against `""`, never
  match, and silently never fire.
- v1 keys the "already examined" set on `part.id ?? part.callID`. v2's tool part
  carries `id` (the call id) and `name`, and no `callID`.

v2 tool-state statuses are `streaming`, `running`, `completed`, `error`, so the
`state.status === "error"` test v1 uses is correct on v2 unchanged. (The
`"pending"` status v1 also tests, elsewhere, does not exist in v2 — see the
TOOL_STATE_* note in the source.)

Two behaviours are inherited from v1 rather than fixed here, and the second is
worth a decision:

- **A re-armed turn re-names the oldest typo.** The per-request reset clears the
  "already examined" set, so the walk restarts from the top of the history and
  the oldest name still above threshold wins — a turn that introduced a *new*
  invented name is told about the *previous* one. Suppressing a name once it has
  been suggested is a behaviour change rather than a port, so it is documented
  instead of made.
- **No registry, no check.** With no tool list every name looks invented, so the
  check is skipped rather than accusing the model of tools that plainly exist.
  Same for an empty registry and for a registry that throws, which is logged and
  ignored: a check that guesses is worse than a check that abstains.

One ordering fix the port needed. The per-request re-arm is derived from the
message history, so it cannot be applied before the history is read — but the
"already suggested" guard used to run before that read, and the check runs
alongside `inspectOnIdle`, whose ordering is not defined. On a re-armed turn the
guard could therefore see the previous turn's latch still standing and skip the
check that was supposed to re-arm it. The guard now runs after the read.


## Explicit completion via `task_complete`

v1 registers a `task_complete` tool and v2 has no built-in equivalent — nothing in
the v2 source mentions the name — so the plugin provides it through
`ctx.tool.transform`, the v2 tool registry. This is a feature rather than a
compatibility shim: it is the strongest completion signal available, stronger than
a trailing 🎉, because the model chose to call it.

The ack escalation is the part that matters, and it is v1’s unchanged. The ack
tool-result is fed straight back into the model’s turn, and a stuck model answers
it by calling the tool again rather than ending with text — v1 logged **27
consecutive acked calls with zero new user input**. So:

- first call acks, and the ack carries an explicit stop instruction;
- second consecutive call warns, and says further calls will be rejected;
- third and beyond throw, which surfaces as a tool error and forces the turn to end.

The counter is reset by a genuinely new inbound user message and by any other tool
call, so the escalation measures a stuck loop rather than several legitimate rounds
of work. Resetting it on tool calls rather than only on user messages is the v2
addition: a model that finishes, reports, does more work and reports again is
doing its job, not looping.

Two guards worth naming:

- **The todo gate is skipped for subagents.** A child was never asked to do the
  parent’s open items, so gating its report on them would block it on work outside
  its scope. Same reasoning as v1.
- **A blocked call also fires a visible nudge** naming the blocking todos, because
  the tool result can collapse to an invisible one-liner in the transcript. Skipped
  when the user holds the ball, since injecting then starts a step their real reply
  interrupts. The block itself is bounded by `maxRetries`: an unbounded block is its
  own kind of loop, and a model that keeps saying "done" may know something the todo
  list does not.

Registration failure — no `ctx.tool`, or a registry that throws — is logged and
swallowed. It must not take down the session recovery that the rest of the plugin
exists for, so the watchdog starts either way.

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
