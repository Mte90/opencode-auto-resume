import { describe, test, expect, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configMentionsTaskComplete } from "./index"

/**
 * The config is the decisive signal for the task_complete fallback.
 *
 * The load order IS the config order, so auto-resume can set up BEFORE the
 * task-complete plugin - and then the live tool list cannot see the tool that
 * comes later. The config file answers it (the pattern infra-memory uses for
 * its todo fallback).
 */
describe("v2: the task-complete config check", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-resume-tc-config-"))
	// afterAll, not the describe body: the body runs at COLLECTION time, and
	// the tests need the directory to still be there.
	afterAll(() => rmSync(dir, { recursive: true, force: true }))
	const write = (name: string, body: string) => {
		const path = join(dir, name)
		writeFileSync(path, body, "utf8")
		return path
	}

	test("a configured task-complete plugin is detected", async () => {
		const path = write(
			"opencode.jsonc",
			[
				"{",
				'  "plugins": [',
				'    "file:///home/famewolf/.config/opencode/plugins/task-complete",',
				'    { "package": "file:///home/famewolf/.config/opencode/plugins/auto-resume" }',
				"  ]",
				"}",
			].join("\n"),
		)
		expect(await configMentionsTaskComplete(path)).toBe(true)
	})

	test("a config without it is not detected", async () => {
		const path = write(
			"plain.jsonc",
			['{ "plugins": [ "opencode-interactive-notifier" ] }'].join("\n"),
		)
		expect(await configMentionsTaskComplete(path)).toBe(false)
	})

	test("an unreadable config answers false - the fallback is provided", async () => {
		// The safe direction: a missing config must not silence the fallback.
		expect(await configMentionsTaskComplete(join(dir, "does-not-exist.jsonc"))).toBe(false)
	})
})
