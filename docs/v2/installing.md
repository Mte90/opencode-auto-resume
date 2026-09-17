# Installing opencode-auto-resume on OpenCode v2

This guide installs the **v2 port** of the plugin. It targets the stable v2
plugin API (`@opencode/plugin` 2.0.5, shipped with `opencode` v2.0.5).

> Coming from OpenCode v1? Read [`migration.md`](./migration.md) first — the v1
> plugin file does **not** run on v2 and must be replaced by the v2 port.

## Requirements

- **opencode v2.0.5 or newer** (`opencode --version`).
- Node.js/Bun is only needed if you run the test/typecheck tooling; the plugin
  itself is loaded by opencode.
- The plugin source: [`src/v2/index.ts`](../../src/v2/index.ts) from this repo.

## Install

### Option A — drop-in file (no config)

OpenCode auto-loads every plugin found in these directories:

- Global: `~/.config/opencode/plugins/`
- Per project: `<project>/.opencode/plugins/`

Copy the v2 port there:

```sh
mkdir -p ~/.config/opencode/plugins
cp src/v2/index.ts ~/.config/opencode/plugins/auto-resume-v2.ts
```

That's it — no `opencode.json` change is required. Restart opencode (or reload
plugins) and the plugin is active.

### Option B — `opencode.json(c)` entry

Use this when you want to load the file from another location, pass options, or
pin a published package. Add an entry to the `plugins` array:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // 1. plain path (relative to the config file) or absolute path
    "./plugins/auto-resume-v2.ts",

    // 2. with options
    {
      "package": "./plugins/auto-resume-v2.ts",
      "options": {
        "chunkTimeoutMs": 45000,
        "maxRetries": 3
      }
    }
  ]
}
```

Both `.opencode/plugin/` (v1 directory name) and `.opencode/plugins/` are
discovered; use `.opencode/plugins/` for v2 files.

## Options

All options are optional and are read from `ctx.options` in `setup`.

| Option | Default | Description |
|---|---|---|
| `chunkTimeoutMs` | `45000` | Silence on a **busy** session before recovery is considered. |
| `gracePeriodMs` | `3000` | Extra grace added to the timeout before acting. |
| `checkIntervalMs` | `5000` | Watchdog polling interval. |
| `maxRetries` | `3` | Resume attempts per stall before escalating. |
| `baseBackoffMs` | `1000` | Base delay for exponential backoff between attempts. |
| `maxBackoffMs` | `8000` | Ceiling for the backoff delay. |
| `loopMaxContinues` | `3` | Continues allowed inside `loopWindowMs` before forcing interrupt + resume. |
| `loopWindowMs` | `600000` | Window (ms) for the hallucination-loop guard (default 10 min). |
| `maxRecoveryRetries` | `2` | Cap for targeted recovery prompts (tool-as-text / intent nudges). |
| `continuePrompt` | `"continue"` | Prompt used for a plain resume / ready-to-continue nudge. |
| `toolTextRecoveryPrompt` | _(built-in)_ | Prompt used when a tool call is printed as text instead of executed. |
| `doneWithoutWorkPrompt` | _(built-in)_ | Prompt used to verify a suspicious terse "done" claim. |
| `actionIntentPrompt` | _(falls back to `continuePrompt`)_ | Prompt used when the model ends with an unexecuted intent. |
| `debug` | `false` | Verbose `[auto-resume:debug]` logging. |

Example:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/auto-resume-v2.ts",
      "options": { "chunkTimeoutMs": 60000, "debug": true }
    }
  ]
}
```

## Verify it loaded

Start opencode; the plugin logs its banner at load:

```
[auto-resume] ready (opencode v2). timeout=45000ms interval=5000ms retries=3 loop=3/600s
```

To see an intervention in action, let a session go quiet past
`chunkTimeoutMs`; the plugin injects a visible **synthetic** message in the
session timeline (`auto-resume: …`) and resumes the turn. Every recovery is
also appended to the opencode log with an `[auto-resume]` prefix.

## Disable / uninstall

- **Disable by id** without touching other plugins: add `"-auto-resume.v2"` to
  the `plugins` array.
- **Temporarily off**: delete/move the file out of the `plugins/` directory.
- **Uninstall**: remove the file and any `plugins` entry you added.

## Troubleshooting

| Symptom | Check |
|---|---|
| No `[auto-resume] ready …` banner | File is in a `plugins/` dir opencode scans, or listed in `plugins`; restart opencode. |
| Nothing happens on a stall | Increase verbosity with `"debug": true`; confirm `chunkTimeoutMs` isn't larger than your real stall. |
| Recovers but you don't see a notice | Your model/provider may reject `session.synthetic()`; the plugin falls back to `session.prompt()` (no TUI banner). |
| Never recovers a parent waiting on a subagent | Intentional: parent sessions blocked on a running subagent are left alone. |
| Never recovers while a permission dialog is open | Intentional: recovery is held until the permission is answered. |

## Development

```sh
# typecheck the v2 port against the stable types
bun add -d @opencode/plugin@2.0.5 typescript
bunx tsc --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution bundler --skipLibCheck src/v2/index.ts
```

See [`migration.md`](./migration.md) for the full v1→v2 mapping and the
stable-vs-beta validation notes.
