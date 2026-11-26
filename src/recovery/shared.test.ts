/**
 * Test that ensures shared exports are NOT locally redeclared in either build.
 *
 * This test fails if anyone copies a value from shared.ts into src/index.ts or
 * src/v2/index.ts — the structural guard against the recurring duplication bug.
 */

import { readFileSync } from "node:fs"
import * as shared from "./shared"
import { describe, test, expect } from "bun:test"

// Read the source files next to this test
const v1Source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
const v2Source = readFileSync(new URL("../v2/index.ts", import.meta.url), "utf8")

// All exported value names from shared.ts (skip the Todo type — it's type-only)
const SHARED_VALUE_NAMES = [
	"DEFAULT_CHUNK_TIMEOUT_MS",
	"DEFAULT_CHECK_INTERVAL_MS",
	"DEFAULT_DISCOVERY_DELAY_MS",
	"DEFAULT_ACTIVE_USER_WINDOW_MS",
	"DEFAULT_GRACE_PERIOD_MS",
	"DEFAULT_MAX_RETRIES",
	"DEFAULT_MAX_BACKOFF_MS",
	"DEFAULT_BASE_BACKOFF_MS",
	"DEFAULT_SUBAGENT_WAIT_MS",
	"DEFAULT_LOOP_MAX_CONTINUES",
	"DEFAULT_LOOP_WINDOW_MS",
	"DEFAULT_TOOL_TEXT_CHECK_DELAY_MS",
	"DEFAULT_MAX_RECOVERY_RETRIES",
	"DEFAULT_MIN_ACTIVITY_GAP_MS",
	"DEFAULT_WARMUP_MS",
	"DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS",
	"DEFAULT_DEBUG",
	"MAX_IDLE_SESSIONS",
	"IDLE_CLEANUP_MS",
	"SESSION_DISCOVERY_INTERVAL_MS",
	"CTX_WRAPUP_TRIGGER",
	"UNKNOWN_TOOL_THRESHOLD",
	"TOOL_IDS_CACHE_MS",
	"OOC_ERROR_RE",
	"DEFAULT_STREAMING_FAILURE_ERROR_NAMES",
	"DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS",
	"TOOL_TEXT_PATTERNS",
	"TRUNCATED_XML_PATTERNS",
	"READY_TO_CONTINUE_PATTERNS",
	"OWN_PROMPT_SHAPES",
	"DONE_CLAIM_PATTERNS",
	"TOOL_TEXT_RECOVERY_PROMPT",
	"THINKING_TOOL_RECOVERY_PROMPT",
	"TOOL_LOOP_RECOVERY_PROMPT",
	"TASK_COMPLETE_ACK",
	"TASK_COMPLETE_REPEAT_WARNING",
	"TASK_COMPLETE_REPEAT_ERROR",
	"DONE_WITHOUT_WORK_PROMPT",
	"DONE_WITHOUT_DETAILS_PROMPT",
	"CONTINUE_PROMPT",
	"containsToolCallAsText",
	"getOpenTodos",
	"isOpenTodo",
	"suggestClosestTool",
	"levenshtein",
	"stripCodeBlocks",
	"containsDoneClaimPattern",
	"containsActionIntent",
	"containsWorkDescription",
	"buildOpenTodosReminder",
]

// Patterns that indicate a local declaration (not an import)
const LOCAL_DECLARATION_PATTERNS = [
	/const\s+(\w+)\s*=/,
	/const\s+(\w+)\s*:/,
	/function\s+(\w+)\s*\(/,
	/async\s+function\s+(\w+)\s*\(/,
	/let\s+(\w+)\s*=/,
	/var\s+(\w+)\s*=/,
]

function findLocalDeclarations(source: string, names: string[]): string[] {
	const violations: string[] = []
	for (const name of names) {
		for (const pattern of LOCAL_DECLARATION_PATTERNS) {
			const regex = new RegExp(pattern.source.replace("($\\w+)", `(${name})`), "gm")
			let match
			while ((match = regex.exec(source)) !== null) {
				const captured = match[1]
				if (captured === name) {
					violations.push(name)
					break
				}
			}
			if (violations.includes(name)) break
		}
	}
	return violations
}

describe("shared.ts exports", () => {
	describe("constants and functions are not locally redeclared", () => {
		test("v1 build (src/index.ts) does not locally declare any shared export", () => {
			const violations = findLocalDeclarations(v1Source, SHARED_VALUE_NAMES)
			expect(violations).toEqual([])
			if (violations.length > 0) {
				console.error(
					"Shared exports found as local declarations in src/index.ts:",
					violations.join(", "),
				)
			}
		})

		test("v2 build (src/v2/index.ts) does not locally declare any shared export", () => {
			const violations = findLocalDeclarations(v2Source, SHARED_VALUE_NAMES)
			expect(violations).toEqual([])
			if (violations.length > 0) {
				console.error(
					"Shared exports found as local declarations in src/v2/index.ts:",
					violations.join(", "),
				)
			}
		})
	})

	describe("exported values are sane", () => {
		test("all exported constants are defined (not undefined/NaN)", () => {
			for (const name of SHARED_VALUE_NAMES) {
				const value = (shared as any)[name]
				expect(value).toBeDefined()
				expect(value).not.toBeNaN()
			}
		})

		test("all exported arrays have length > 0", () => {
			const arrayExports = [
				"DEFAULT_STREAMING_FAILURE_ERROR_NAMES",
				"DEFAULT_STREAMING_FAILURE_MESSAGE_PATTERNS",
				"TOOL_TEXT_PATTERNS",
				"READY_TO_CONTINUE_PATTERNS",
				"OWN_PROMPT_SHAPES",
				"DONE_CLAIM_PATTERNS",
			]
			for (const name of arrayExports) {
				const value = (shared as any)[name]
				expect(Array.isArray(value)).toBe(true)
				expect(value.length).toBeGreaterThan(0)
			}
		})

		test("all exported RegExp lists have length > 0", () => {
			// TRUNCATED_XML_PATTERNS is an array of objects with RegExp fields
			const value = shared.TRUNCATED_XML_PATTERNS
			expect(Array.isArray(value)).toBe(true)
			expect(value.length).toBeGreaterThan(0)
			for (const item of value) {
				expect(item.open).toBeInstanceOf(RegExp)
				expect(item.close).toBeInstanceOf(RegExp)
			}
		})

		test("all exported functions are typeof === 'function'", () => {
			const functionExports = [
				"containsToolCallAsText",
				"getOpenTodos",
				"isOpenTodo",
				"suggestClosestTool",
				"levenshtein",
				"stripCodeBlocks",
				"containsDoneClaimPattern",
				"containsActionIntent",
				"containsWorkDescription",
				"buildOpenTodosReminder",
			]
			for (const name of functionExports) {
				const value = (shared as any)[name]
				expect(typeof value).toBe("function")
			}
		})
	})

	describe("high-value invariants", () => {
		test("OWN_PROMPT_SHAPES contains a shape matching 'You tried to use the tool \"'", () => {
			const sample = 'You tried to use the tool "bash"'
			const matches = shared.OWN_PROMPT_SHAPES.filter((re) => re.test(sample))
			expect(matches.length).toBeGreaterThan(0)
		})

		test("DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS === 200", () => {
			expect(shared.DEFAULT_SILENT_DEAD_STREAM_MIN_TOKENS).toBe(200)
		})

		test("buildOpenTodosReminder asks to verify and prune the list", () => {
			const text = shared.buildOpenTodosReminder([
				{ content: "A", status: "pending", priority: "high" },
			] as any)
			expect(text).toContain("verify that each task above is still valid")
			expect(text).toContain("remove any task that is already done, outdated, or no longer needed")
			expect(text).toContain("If the project keeps tasks in a tracking file, check it and update it to match the list")
		})

		test("OWN_PROMPT_SHAPES still matches the todo reminder first line", () => {
			const text = shared.buildOpenTodosReminder([
				{ content: "A", status: "pending", priority: "high" },
			] as any)
			const firstLine = text.split("\n")[0]
			const matches = shared.OWN_PROMPT_SHAPES.filter((re) => re.test(firstLine))
			expect(matches.length).toBeGreaterThan(0)
		})
	})
})
