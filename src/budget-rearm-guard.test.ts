/**
 * Budget re-arm guard test.
 *
 * Ensures every budget/latch field in SessionWatch has at least one re-arm site
 * (assignment of the form `w.<field> = 0` or `w.<field> = false`).
 *
 * The ensureWatch initializer (`<field>: 0`) does NOT count — only runtime
 * assignments count. This guards against the bug pattern where a budget is
 * incremented but never re-armed, silently dead for the rest of the session.
 *
 * Two real bugs fixed this week:
 * - v1: `taskCompleteOverrides` never reset → open-todo gate dead after 3 blocks
 * - v2: `contextWrapupAttempts` never reset → context-saturation intervention fired once per session
 */

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "bun:test"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Budget/latch field pattern: ends with Attempts|Overrides|Signals|Recovered|Tried|Count
const BUDGET_FIELD_RE = /(Attempts|Overrides|Signals|Recovered|Tried|Count)$/

/** Extract SessionWatch interface block from source. */
function extractSessionWatchInterface(source: string): string | null {
	const interfaceStart = source.match(/interface\s+SessionWatch\s*\{/)
	if (!interfaceStart) return null

	const start = interfaceStart.index!
	let braceCount = 1
	let pos = start + interfaceStart[0].length

	while (pos < source.length && braceCount > 0) {
		if (source[pos] === "{") braceCount++
		else if (source[pos] === "}") braceCount--
		pos++
	}

	if (braceCount !== 0) return null

	return source.slice(start, pos)
}

/** Extract field names from SessionWatch interface block. */
function extractFields(interfaceBlock: string): string[] {
	const fields: string[] = []
	const lines = interfaceBlock.split("\n")

	for (const line of lines) {
		const match = line.match(/^\s+(\w+):\s*/)
		if (match) {
			fields.push(match[1])
		}
	}

	return fields
}

/** Count re-arm sites for a field in source. */
function countRearmSites(source: string, fieldName: string): number {
	// Match `w.<fieldName> = 0` or `w.<fieldName> = false`
	const rearmRe = new RegExp(`w\\.${fieldName}\\s*=\\s*(0|false)`, "g")
	const matches = source.match(rearmRe)
	return matches ? matches.length : 0
}

/** Test a single build file. */
function testBuild(buildPath: string, buildName: string) {
	const source = readFileSync(buildPath, "utf8")
	const interfaceBlock = extractSessionWatchInterface(source)

	if (!interfaceBlock) {
		throw new Error(`${buildName}: Could not extract SessionWatch interface`)
	}

	const allFields = extractFields(interfaceBlock)
	const budgetFields = allFields.filter((f) => BUDGET_FIELD_RE.test(f))

	if (budgetFields.length === 0) {
		throw new Error(`${buildName}: No budget/latch fields found in SessionWatch`)
	}

	const failures: string[] = []

	for (const field of budgetFields) {
		const rearmCount = countRearmSites(source, field)
		if (rearmCount === 0) {
			failures.push(field)
		}
	}

	if (failures.length > 0) {
		throw new Error(
			`${buildName}: Missing re-arm sites for fields: ${failures.join(", ")}`,
		)
	}

	return { fieldCount: budgetFields.length, failures: 0 }
}

describe("Budget re-arm guard", () => {
	test("v1 (src/index.ts): all budget fields have re-arm sites", () => {
		const v1Path = join(__dirname, "index.ts")
		const result = testBuild(v1Path, "v1")
		console.log(`v1: checked ${result.fieldCount} budget fields, all have re-arm sites`)
	})

	test("v2 (src/v2/index.ts): all budget fields have re-arm sites", () => {
		const v2Path = join(__dirname, "v2", "index.ts")
		const result = testBuild(v2Path, "v2")
		console.log(`v2: checked ${result.fieldCount} budget fields, all have re-arm sites`)
	})
})
