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
| `contextSaturationThreshold` | v2 has no token or context-limit read on the plugin context, so there is nothing to compare the threshold against. |
| `subagentNativeCompactionEnabled` | Same: without a context-limit read, saturation cannot be detected, so there is nothing to gate a compaction on. |
| `silentDeadStreamMinTokens` | Same. The heuristic it tunes compares generated token count against a floor. |
| `subagentWaitMs` | The v1 orphan-watch timer that this delays has no v2 counterpart; the v2 port decides parent-vs-stalled from its own event-derived busy set. |
| `discoveryDelayMs` | v2 has no discovery sweep. The port starts watching from the events it receives rather than by enumerating existing sessions on a delay. |
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
- `activeUserWindowMs` defaults to `300000` (5 min) on both v1 and v2, matching
  upstream `e1b8374`. The v2 port shipped with `900000`, which stood down for
  three times longer than v1 after any user message.

## v2-only options

- `injectIntervalMs` — minimum gap between recovery injections for one session.
  No v1 equivalent.
