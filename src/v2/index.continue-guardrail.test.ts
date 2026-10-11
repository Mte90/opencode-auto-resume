import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Every synthetic continue this plugin sends must carry the "only continue work
 * already in progress / nothing new / nothing destructive" guardrail unless an
 * operator explicitly opted out.
 *
 * Why (2026-10-11): every liveness signal in the plugin proved fallible. One
 * that fired on a subagent dead for 2.5 hours aborted and re-continued the
 * parent 8 times over 3 hours, twice on top of a live user message. A bare
 * "continue" gives the model nothing to stop at the edge of the work it was
 * given — with four sites still sending it, the two nudges actually observed
 * (abort escalation, empty-idle) were the least protected paths in the plugin.
 *
 * The stall path already carried the guardrail (recover()'s rich prompt). This
 * closes the other four.
 */
const SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const GUARD = "Do not start anything new"
const GUARD_DESTRUCTIVE = "destructive or irreversible actions without explicit user approval"

/** The four sites that previously defaulted to the bare string. */
const sites = [
	{ name: "abort+resume escalation", re: /injectOnce\(sid, opts\.continuePrompt \?\? (SAFE_CONTINUE_PROMPT|SAFE_EMPTY_IDLE_PROMPT|CONTINUE_PROMPT)/ },
	{ name: "empty-idle nudge", re: /notifyAndPrompt\(sid, opts\.continuePrompt \?\? (SAFE_CONTINUE_PROMPT|SAFE_EMPTY_IDLE_PROMPT|CONTINUE_PROMPT)/ },
	{ name: "ready-to-continue", re: /targetedRecovery\(sid, "ready-to-continue", opts\.continuePrompt \?\? (SAFE_CONTINUE_PROMPT|SAFE_EMPTY_IDLE_PROMPT|CONTINUE_PROMPT)/ },
	{ name: "action-intent", re: /targetedRecovery\(sid, "action-intent", opts\.actionIntentPrompt \?\? opts\.continuePrompt \?\? (SAFE_CONTINUE_PROMPT|SAFE_EMPTY_IDLE_PROMPT|CONTINUE_PROMPT)/ },
]

describe("v2: every default synthetic continue carries the safety guardrail", () => {
	test("no injection site defaults to the bare CONTINUE_PROMPT", () => {
		for (const s of sites) {
			const m = SOURCE.match(s.re)
			expect(m, `site not found: ${s.name}`).not.toBeNull()
			expect(m![1], `${s.name} still defaults to the bare string`).not.toBe("CONTINUE_PROMPT")
		}
	})

	test("the guardrail text is the same wording the stall path already used", () => {
		expect(SOURCE).toContain(GUARD)
		expect(SOURCE).toContain(GUARD_DESTRUCTIVE)
		// It must be the SAME sentence the rich stall prompt carries, so every
		// continue this plugin emits reads consistently.
		const rich = SOURCE.match(/return \(`continue — stalled[\s\S]*?\$\{suffix\}`\)/)?.[0] ?? ""
		expect(rich).toContain(GUARD)
		expect(rich).toContain(GUARD_DESTRUCTIVE)
	})

	test("an explicit richContinuePrompt:false still yields the bare string", () => {
		// The opt-out must survive: an operator who sets richContinuePrompt:false
		// asked for bare continues.
		expect(SOURCE).toMatch(/if \(!richContinuePrompt\) return CONTINUE_PROMPT/)
	})

	test("a configured continuePrompt still wins verbatim", () => {
		// All four sites read opts.continuePrompt first — an operator's own text
		// must never be rewritten.
		expect(SOURCE).toMatch(/opts\.continuePrompt \?\? SAFE_CONTINUE_PROMPT/)
		expect(SOURCE).toMatch(/opts\.continuePrompt \?\? SAFE_EMPTY_IDLE_PROMPT/)
	})

	test("the empty-idle wording does not claim there is work in progress", () => {
		// That nudge fires precisely because nothing was happening, so
		// "continue work already in progress" would be incoherent. It gets the
		// same guardrail phrased for the case.
		const m = SOURCE.match(/const SAFE_EMPTY_IDLE_PROMPT =[\s\S]*?\n\n/)?.[0] ?? ""
		expect(m).toContain("Otherwise ask the user what to do next")
		expect(m).toContain(GUARD_DESTRUCTIVE)
	})
})