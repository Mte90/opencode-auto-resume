import { describe, test, expect, afterEach } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { defaultLogFile } from "./index"

/**
 * v2: the default log path follows the platform, it is not hardcoded.
 *
 * The default used to be `~/.local/state/opencode-v2/auto-resume.log` — the
 * state directory of ONE box's tree layout. The plugin ships upstream (PR #37
 * to Mte90/opencode-auto-resume), so that path was wrong for every other
 * user: it ignored `XDG_STATE_HOME` and pointed into a directory unrelated
 * to their opencode install.
 *
 * opencode core resolves its own state files the same way
 * (`packages/client/src/effect/service.ts`): `XDG_STATE_HOME` when it is set
 * to an absolute path, else `~/.local/state`, then `opencode/<file>`. The
 * plugin now does exactly that.
 */
describe("v2: the default log path", () => {
	const original = process.env["XDG_STATE_HOME"]
	afterEach(() => {
		if (original === undefined) delete process.env["XDG_STATE_HOME"]
		else process.env["XDG_STATE_HOME"] = original
	})

	test("uses XDG_STATE_HOME when it is an absolute path", () => {
		process.env["XDG_STATE_HOME"] = "/tmp/xdg-state"
		expect(defaultLogFile()).toBe(join("/tmp/xdg-state", "opencode", "auto-resume.log"))
	})

	test("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
		delete process.env["XDG_STATE_HOME"]
		expect(defaultLogFile()).toBe(join(homedir(), ".local", "state", "opencode", "auto-resume.log"))
	})

	test("ignores an empty or relative XDG_STATE_HOME (XDG spec)", () => {
		process.env["XDG_STATE_HOME"] = "   "
		expect(defaultLogFile()).toBe(join(homedir(), ".local", "state", "opencode", "auto-resume.log"))
		process.env["XDG_STATE_HOME"] = "relative/state"
		expect(defaultLogFile()).toBe(join(homedir(), ".local", "state", "opencode", "auto-resume.log"))
	})

	test("never lands in a tree-specific directory", () => {
		delete process.env["XDG_STATE_HOME"]
		expect(defaultLogFile()).not.toContain("opencode-v2")
	})
})
