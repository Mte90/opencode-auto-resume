# Installing opencode-auto-resume on OpenCode v2

This guide installs the **v2 port** of the plugin. It targets the stable v2
plugin API (`@opencode/plugin` 2.0.5, shipped with `opencode` v2.0.5).

> Coming from OpenCode v1? Read [`migration.md`](./migration.md) first — the v1
> plugin file does **not** run on v2 and must be replaced by the v2 port.

## Requirements

- **opencode v2.0.5 or newer** (`opencode --version`).
- **No runtime dependencies.** `src/v2/index.ts` imports only `node:fs`,
  `node:os` and `node:path`, and defines its own `{ id, setup }` helper rather
  than importing one, so the built file is self-contained. `@opencode/plugin` is
  not needed to *run* the plugin — only to typecheck the source against the
  official types (see [Development](#development)).
- **Host access beyond the plugin context.** Reading the todo list needs the
  local server's address, and that is not exposed as an environment variable under
  OpenChamber. The plugin reads `/proc/self/cmdline` for the `--port` flag (Linux)
  and may issue a loopback `GET` to `127.0.0.1`; where `/proc` is unavailable it
  falls back to `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_PORT` /
  `OPENCODE_PORT` / `PORT`. If `OPENCODE_SERVER_PASSWORD` (or `OPENCODE_PASSWORD`)
  is set, it is sent as HTTP Basic on that request. All of it is best-effort: a
  host that refuses any of it degrades to "cannot read todos", never a crash.
- The plugin source: [`src/v2/index.ts`](../../src/v2/index.ts) from this repo, or
  the built `dist/v2/index.js`.

## Install

There is nothing to install first. Copy the file, and opencode loads it.

### Step 1 — add the plugin

#### Option A — drop-in file (no config)

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

#### Option B — `opencode.json(c)` entry

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
        "chunkTimeoutMs": 180000,
        "maxRetries": 3
      }
    }
  ]
}
```

Both `.opencode/plugin/` (v1 directory name) and `.opencode/plugins/` are
discovered; use `.opencode/plugins/` for v2 files.

### Step 2 — restart opencode

Restart opencode after copying the file. A hot plugin reload is **not**
reliable on every version, so restart when in doubt — a missing banner is the
symptom to check for.

## Options

Every option is optional and is read from `ctx.options` in `setup`. The port
reads **all** of v1's options, and applies all of them — there are none left in an
"accepted but not applied" state. The full table with every default is in the
[README](../../README.md#configurable-options); the ones worth knowing about on
v2 specifically:

| Option | Default | Description |
|---|---|---|
| `chunkTimeoutMs` | `180000` | Silence on a **busy** session before recovery is considered. Matches v1 since `49957b2`. |
| `toolTextCheckDelayMs` | `3000` | Settle delay before a finished turn's closing text is judged against the done/tool patterns. Dead streams are still caught on the idle event, because a stream that died before delivering any text has nothing for those patterns to read. `0` judges on the idle event. |
| `logFile` | `~/.local/state/opencode-v2/auto-resume.log` | Where this build logs. **v2 removed v1's server log endpoint**, so without this the plugin has no log at all; `AUTO_RESUME_LOG_FILE` in the environment overrides it. Size-capped at 2 MB. |
| `injectIntervalMs` | `15000` | Minimum gap between recovery injections for one session. No v1 equivalent. |
| `subagentNativeCompactionEnabled` | `false` | Opt-in native `session.compact()` for a saturated subagent, instead of leaving it alone. |
| `debug` | `false` | Verbose `[auto-resume:debug]` logging, appended to `logFile`. |

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

Start opencode; the plugin logs its banner at load, into `logFile`:

```
[auto-resume] ready (opencode v2). timeout=180000ms interval=5000ms retries=3 loop=3/600s warmup=15000ms stall=continue
```

To see an intervention in action, let a session go quiet past
`chunkTimeoutMs`; the plugin injects a visible **synthetic** message in the
session timeline (`auto-resume: …`) and resumes the turn. Every recovery is
appended to `logFile` with an `[auto-resume]` prefix — the opencode log no longer
has a plugin sink to write to, which is why `logFile` exists.

## Disable / uninstall

- **Disable by id** without touching other plugins: add `"-auto-resume.v2"` to
  the `plugins` array.
- **Temporarily off**: delete/move the file out of the `plugins/` directory.
- **Uninstall**: remove the file and any `plugins` entry you added.

## Troubleshooting

| Symptom | Check |
|---|---|
| No `[auto-resume] ready …` banner | File is in a `plugins/` dir opencode scans, or listed in `plugins`; restart opencode. |
| Logs say `failed to load plugin` with no reason | The file is not a valid ES module, or a syntax error. Run `bunx tsc --noEmit` on it (see [Development](#development)). |
| Nothing happens on a stall | Increase verbosity with `"debug": true`; confirm `chunkTimeoutMs` isn't larger than your real stall. |
| Recovers but you don't see a notice | Your model/provider may reject `session.synthetic()`; the plugin falls back to `session.prompt()` (no TUI banner). |
| Never recovers a parent waiting on a subagent | Intentional: parent sessions blocked on a running subagent are left alone. |
| Never recovers while a permission dialog is open | Intentional: recovery is held until the permission is answered. |

## Development

The source has no imports from `@opencode/plugin` — the `{ id, setup }` helper
is defined locally — so the package is only needed to check the file against the
official types:

```sh
bun add -d @opencode/plugin@2.0.5 typescript
bunx tsc --noEmit --strict --target ESNext --module ESNext \
  --moduleResolution bundler --skipLibCheck src/v2/index.ts

# the distributable is a single self-contained file
bun build src/v2/index.ts --outfile dist/v2/index.js --target bun
```

See [`migration.md`](./migration.md) for the full v1→v2 mapping and the
stable-vs-beta validation notes.
