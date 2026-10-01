import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_opts"

/** Scratch log path per replay, so parallel cases cannot read each other's lines. */
let counter = 0

const textPart = (t: string) => ({ type: "text", text: t })
/** Older than every activeUserWindowMs we pass, so guard (b) cannot mask a failure. */
const oldUserTurn = () => ({
	type: "user",
	id: "msg_u0",
	time: { created: Date.now() - 60 * 60_000 },
	content: [textPart("go ahead")],
})
const assistantTurn = (text: string) => ({
	type: "assistant",
	id: "msg_a1",
	time: { created: Date.now() - 60_000 },
	content: [textPart(text)],
})

/** Trips `ready-to-continue` but not `isUserHandoff` (no "?", no "should I"). */
const READY_TEXT = "Ready to continue with task"
/**
 * Ends in ":" so `containsActionIntent` is true. Must not trip the
 * ready-to-continue patterns and must not read as a user hand-off.
 */
const INTENT_TEXT = "I will run the migration now:"

function makeEventStream() {
	const queue: any[] = []
	const waiters: ((ev: any) => void)[] = []
	let closed = false
	const stream = {
		push(ev: any) {
			if (waiters.length) waiters.shift()!(ev)
			else queue.push(ev)
		},
		close() {
			closed = true
			while (waiters.length) waiters.shift()!(null)
		},
		subscribe: () => stream,
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((resolve) => {
						if (queue.length) return resolve({ value: queue.shift(), done: false })
						if (closed) return resolve({ value: undefined, done: true })
						waiters.push((ev) =>
							resolve(ev === null ? { value: undefined, done: true } : { value: ev, done: false }),
						)
					}),
				return: () => {
					closed = true
					return Promise.resolve({ value: undefined, done: true })
				},
			}
		},
	}
	return stream
}

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: SID, ...data } })

type Harness = {
	injected: Array<{ kind: string; text?: string }>
	interrupts: string[]
	logs: string[]
}

/**
 * Replay `events` and report what the plugin did.
 * `sendFails` makes every delivery attempt throw, which is how the
 * "a rejected send must not burn the retry budget" case is exercised.
 */
async function replay(
	events: any[],
	opts: Record<string, unknown> = {},
	harnessOpts: { sendFails?: boolean; text?: string } = {},
): Promise<Harness> {
	const injected: Harness["injected"] = []
	const interrupts: string[] = []
	const stream = makeEventStream()
	const text = harnessOpts.text ?? READY_TEXT

	// v2 removed v1's server log endpoint, so the plugin writes to a file. Point
	// it at a scratch path and read the lines back after teardown — this is also
	// what proves the file sink works, rather than assuming it does.
	const logFile = join(tmpdir(), `auto-resume-test-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const ctx: any = {
		event: stream,
		// The plugin reads its config from `ctx.options`; the second argument to
		// `setup()` is ignored. Passing options the other way makes every
		// negative assertion below pass for the wrong reason.
		// Before the spread, so it applies to every test here unless one asks for a
		// different value. The deferred pattern pass defaults to 3s, which is not what
		// these tests measure — the nudge they assert on would land after the wait.
		options: { toolTextCheckDelayMs: 0, ...opts, logFile },
		session: {
			context: async () => [oldUserTurn(), assistantTurn(text)],
			// Empty: no other session is active, so the `lastWasTaskTool` branch
			// (which needs `others.length > 0`) cannot mask a failure below.
			active: async () => ({}),
			interrupt: async (a: any) => {
				interrupts.push(a?.sessionID)
				return {}
			},
			synthetic: async (a: any) => {
				if (harnessOpts.sendFails) throw new Error("synthetic rejected")
				injected.push({ kind: "synthetic", text: a?.text })
				return {}
			},
			prompt: async (a: any) => {
				if (harnessOpts.sendFails) throw new Error("prompt rejected")
				injected.push({ kind: "prompt", text: a?.text })
				return {}
			},
		},
	}

	const cleanup = await (plugin as any).setup(ctx)
	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	await wait(600) // handleEvent is sync; its work is async
	;(cleanup as (() => void) | undefined)?.()
	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { injected, interrupts, logs }
}

/** A turn that streams `text` and then goes idle. */
function turnEvents(text = READY_TEXT) {
	return [
		ev("session.execution.started"),
		ev("session.text.delta", { messageID: "msg_a1", delta: text }),
		ev("session.text.ended", { messageID: "msg_a1" }),
		ev("session.idle"),
	]
}

/** A turn that starts, streams nothing, and never idles: a stall candidate. */
const busyStallEvents = [ev("session.execution.started")]

/** Timings small enough that the watchdog fires inside the harness wait. */
const FAST = { chunkTimeoutMs: 50, gracePeriodMs: 0, checkIntervalMs: 20, warmupMs: 0, baseBackoffMs: 1, maxBackoffMs: 2 }

// ============================================================================
// busyStallStrategy
// ============================================================================

describe("v2: busyStallStrategy", () => {
	test("CONTROL: default 'continue' -> a stalled busy session gets a continue", async () => {
		const { injected } = await replay(busyStallEvents, { ...FAST, loopMaxContinues: 99, injectIntervalMs: 0 })
		expect(injected.length).toBeGreaterThan(0)
	})

	test("'off' -> the stall is ignored and nothing is injected", async () => {
		const { injected, interrupts } = await replay(busyStallEvents, {
			...FAST,
			busyStallStrategy: "off",
			loopMaxContinues: 99,
			injectIntervalMs: 0,
		})
		expect(injected).toEqual([])
		expect(interrupts).toEqual([])
	})

	test("'abort' -> the step is interrupted before the continue is sent", async () => {
		const { interrupts } = await replay(busyStallEvents, {
			...FAST,
			busyStallStrategy: "abort",
			loopMaxContinues: 99,
			injectIntervalMs: 0,
		})
		expect(interrupts).toEqual([SID])
	})

	test("'continue' (explicit) does not interrupt", async () => {
		const { interrupts } = await replay(busyStallEvents, {
			...FAST,
			busyStallStrategy: "continue",
			loopMaxContinues: 99,
			injectIntervalMs: 0,
		})
		expect(interrupts).toEqual([])
	})
})

// ============================================================================
// warmupMs
// ============================================================================

describe("v2: warmupMs", () => {
	test("CONTROL: warmup 0 -> the stall is acted on", async () => {
		const { injected } = await replay(busyStallEvents, { ...FAST, loopMaxContinues: 99, injectIntervalMs: 0 })
		expect(injected.length).toBeGreaterThan(0)
	})

	test("a session still inside its warmup window is not treated as stalled", async () => {
		const { injected } = await replay(busyStallEvents, {
			...FAST,
			warmupMs: 10 * 60_000,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
		})
		expect(injected).toEqual([])
	})
})

// ============================================================================
// maxRecoveryRetries alias
// ============================================================================

describe("v2: maxRecoveryRetries is v1's name for maxRetries", () => {
	test("CONTROL: maxRetries 3 -> recovery fires", async () => {
		const { injected } = await replay(busyStallEvents, { ...FAST, maxRetries: 3, loopMaxContinues: 99, injectIntervalMs: 0 })
		expect(injected.length).toBeGreaterThan(0)
	})

	test("maxRetries 0 -> the session gives up instead of recovering", async () => {
		const { injected } = await replay(busyStallEvents, { ...FAST, maxRetries: 0, loopMaxContinues: 99, injectIntervalMs: 0 })
		expect(injected).toEqual([])
	})

	// If the alias were ignored, maxRetries would fall back to 3 and this would inject.
	test("maxRecoveryRetries 0 is honoured as the same knob", async () => {
		const { injected } = await replay(busyStallEvents, {
			...FAST,
			maxRecoveryRetries: 0,
			loopMaxContinues: 99,
			injectIntervalMs: 0,
		})
		expect(injected).toEqual([])
	})
})

// ============================================================================
// resumeOnActionIntent
// ============================================================================

describe("v2: resumeOnActionIntent", () => {
	test("CONTROL: default true -> an action-intent turn is nudged", async () => {
		const { injected } = await replay(turnEvents(INTENT_TEXT), { injectIntervalMs: 0 })
		expect(injected.length).toBeGreaterThan(0)
	})

	test("false -> an action-intent turn is left alone", async () => {
		const { injected } = await replay(turnEvents(INTENT_TEXT), {
			resumeOnActionIntent: false,
			injectIntervalMs: 0,
		})
		expect(injected).toEqual([])
	})
})

// ============================================================================
// Unrecognised / accepted-but-inert option reporting
// ============================================================================

describe("v2: option reporting at startup", () => {
	test("an unknown option key produces exactly one warning naming it", async () => {
		const { logs } = await replay([], { chunkTimeoutMs: 5000, definitelyNotAnOption: true })
		const warnings = logs.filter((l) => l.includes("unrecognised"))
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("definitelyNotAnOption")
	})

	test("known v1 options do not warn, even the ones v2 does not act on", async () => {
		const { logs } = await replay([], {
			chunkTimeoutMs: 5000,
			maxRecoveryRetries: 2,
			subagentWaitMs: 15_000,
			discoveryDelayMs: 5_000,
			contextSaturationThreshold: 0.85,
			silentDeadStreamMinTokens: 200,
			subagentNativeCompactionEnabled: false,
			toolTextCheckDelayMs: 3_000,
			thinkingToolRecoveryPrompt: "x",
			doneWithoutWorkPrompt: "y",
		})
		expect(logs.filter((l) => l.includes("unrecognised"))).toEqual([])
	})

	test("the startup line names no inert options, because none are inert", async () => {
		// Every v1 option this build understands is now applied, so the inert list has
		// nothing to put in it — including for the three options that were inert when
		// this branch started. A config carrying them must not be told they are being
		// ignored: that note is the only way a user finds out.
		const { logs } = await replay([], {
			chunkTimeoutMs: 5000,
			subagentWaitMs: 15_000,
			toolTextCheckDelayMs: 3000,
			discoveryDelayMs: 5_000,
		})
		const ready = logs.filter((l) => l.includes("ready (opencode v2)"))
		expect(ready).toHaveLength(1)
		expect(ready[0]).not.toContain("accepted-but-inert=")
		expect(ready[0]).not.toContain("subagentWaitMs")
		expect(ready[0]).not.toContain("toolTextCheckDelayMs")
		expect(ready[0]).not.toContain("discoveryDelayMs")
	})

	test("CONTROL: nothing is listed as feature-gated in the source", async () => {
		// The structural counterpart to the assertion above, and the one that actually
		// holds the line: adding an option to RECOGNISED_OPTIONS without implementing it
		// is exactly how this build went from "several options inert" to "none", and it
		// is the failure the list exists to make visible. With the list empty there is
		// no behavioural test left for it — no production path reaches it — so it is
		// asserted on the source instead.
		const block = SOURCE.match(/const FEATURE_GATED_OPTIONS = \[([^\]]*)\]/)
		expect(block).not.toBeNull()
		const gated = [...(block![1].match(/"([a-zA-Z][a-zA-Z0-9]*)"/g) ?? [])].map((x) => x.replace(/"/g, ""))
		expect(gated).toEqual([])
	})

	test("the inert reporting is kept, so the next gap has somewhere to be listed", async () => {
		// Deliberately not deleted when the last entry left the list. The reporting is
		// the only signal a user gets that an option is being ignored, and the next
		// unported feature needs it more than this build does.
		expect(SOURCE).toContain("FEATURE_GATED_OPTIONS")
		expect(SOURCE).toContain("accepted-but-inert=")
		expect(SOURCE).toContain("gatedInUse")
	})

	test("the startup line carries no accepted-but-inert list when none are set", async () => {
		const { logs } = await replay([], { chunkTimeoutMs: 5000 })
		const ready = logs.filter((l) => l.includes("ready (opencode v2)"))
		expect(ready).toHaveLength(1)
		expect(ready[0]).not.toContain("accepted-but-inert=")
	})
})

// ============================================================================
// e1b8374: a rejected send must not burn the retry budget
// ============================================================================

describe("v2: a nudge that was never delivered does not consume a retry", () => {
	// Two idles inside one turn: no `execution.started` between them, so
	// markBusy does not reset the per-turn budget and the second attempt is
	// genuinely attempt #2 if the failed send was counted.
	const twoIdles = [
		ev("session.execution.started"),
		ev("session.text.delta", { messageID: "msg_a1", delta: READY_TEXT }),
		ev("session.text.ended", { messageID: "msg_a1" }),
		ev("session.idle"),
		ev("session.idle"),
	]

	test("CONTROL: both sends succeed -> each nudge is 1/3, because markBusy resets the per-turn budget", async () => {
		const { logs } = await replay(twoIdles, { maxRetries: 3, loopMaxContinues: 99, injectIntervalMs: 0 })
		const nudges = logs.filter((l) => l.includes("ready-to-continue detected"))
		expect(nudges.length).toBeGreaterThanOrEqual(2)
		// This is what makes the test below meaningful: on the success path the
		// counter is reset by markBusy, so the number the user sees does not
		// discriminate. On the failure path it does.
		for (const n of nudges) expect(n).toContain("(1/3)")
	})

	test("both sends are rejected -> the budget is untouched, so it is still 1/3", async () => {
		const { logs, injected } = await replay(
			twoIdles,
			{ maxRetries: 3, loopMaxContinues: 99, injectIntervalMs: 0 },
			{ sendFails: true },
		)
		expect(injected).toEqual([])
		const nudges = logs.filter((l) => l.includes("ready-to-continue detected"))
		expect(nudges.length).toBeGreaterThanOrEqual(2)
		// Nothing was delivered, so nothing was spent. The pre-e1b8374 ordering
		// incremented before the send and reported 1/3 then 2/3 here.
		for (const n of nudges) expect(n).toContain("(1/3)")
		expect(nudges.some((l) => l.includes("(2/3)"))).toBe(false)
	})

	test("the budget write is inside the success branch, not before the send", () => {
		// Guards the exact reordering e1b8374 makes, so a well-meaning "tidy up"
		// that moves the increment back above injectOnce fails here.
		expect(SOURCE).toMatch(/const attemptNum = w\[budgetKey\] \+ 1[\s\S]{0,400}w\[budgetKey\] = attemptNum/)
		const body = SOURCE.match(/async function targetedRecovery[\s\S]*?\n\t\t\}/)?.[0] ?? ""
		const incr = body.indexOf("w[budgetKey]")
		const send = body.indexOf("injectOnce(")
		expect(incr).toBeGreaterThan(-1)
		expect(send).toBeGreaterThan(-1)
		expect(incr).toBeLessThan(send)
		expect(body.slice(send)).toContain("w[budgetKey] = attemptNum")
	})
})

// ============================================================================
// CONTRACT — fail deterministically if someone reverts a ported option.
// ============================================================================

describe("v2: contract assertions on source", () => {
	test("every v1 option name is in the recognised set", () => {
		const block = SOURCE.match(/const RECOGNISED_OPTIONS = new Set<string>\(\[([\s\S]*?)\]\)/)
		expect(block).not.toBeNull()
		const recognised = new Set([...(block![1].match(/"([a-zA-Z][a-zA-Z0-9]*)"/g) ?? [])].map((s) => s.replace(/"/g, "")))
		// Sampled across every category: prompts, timing, pattern lists, the
		// v1-only alias, and the two that were inert until this branch ported them.
		for (const key of [
			"continuePrompt",
			"actionIntentPrompt",
			"toolTextRecoveryPrompt",
			"doneWithoutDetailsPrompt",
			"doneWithoutWorkPrompt",
			"thinkingToolRecoveryPrompt",
			"chunkTimeoutMs",
			"warmupMs",
			"minActivityGapMs",
			"toolTextCheckDelayMs",
			"subagentWaitMs",
			"discoveryDelayMs",
			"maxRecoveryRetries",
			"busyStallStrategy",
			"resumeOnActionIntent",
			"doneClaimPatterns",
			"readyToContinuePatterns",
			"streamingFailureErrorNames",
			"streamingFailureMessagePatterns",
			"contextSaturationThreshold",
			"subagentNativeCompactionEnabled",
			"silentDeadStreamMinTokens",
			"injectIntervalMs",
		]) {
			expect(recognised.has(key)).toBe(true)
		}
	})

	test("the declared options type and the recognised set cannot drift apart", () => {
		const declared = new Set(
			[...(SOURCE.match(/export interface AutoResumeOptions \{([\s\S]*?)\n\}/)?.[1] ?? "").matchAll(
				/^\t([a-zA-Z][a-zA-Z0-9]*)\?:/gm,
			)].map((m) => m[1]),
		)
		const block = SOURCE.match(/const RECOGNISED_OPTIONS = new Set<string>\(\[([\s\S]*?)\]\)/)
		const recognised = new Set([...(block![1].match(/"([a-zA-Z][a-zA-Z0-9]*)"/g) ?? [])].map((s) => s.replace(/"/g, "")))
		expect([...declared].sort()).toEqual([...recognised].sort())
	})

	test("the v2 active-user window matches v1 (5 min), not the 15 min the port shipped with", () => {
		expect(SOURCE).toMatch(/DEFAULT_ACTIVE_USER_WINDOW_MS = 5 \* 60_000/)
	})
})
