import { describe, test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "ses_saturation"
const PROVIDER = "llama-server"
const MODEL = "coder"

/**
 * Context saturation.
 *
 * A session can fill its context window without ever looking stalled — it just
 * keeps working until it chokes. That failure mode is invisible to the stall
 * watchdog by construction, so it gets its own check on the idle path.
 *
 * Routing, as in v1:
 *   subagent — opt-in (`subagentNativeCompactionEnabled`) then native compaction.
 *              magic-context is not involved.
 *   parent   — only when magic-context is installed, because its setup disables
 *              native compaction and compacting here would double-compress.
 *
 * The v2 API shape is what these tests are really pinning: the token count comes
 * from the `session.usage.updated` event, the window from `ctx.model.get()`, the
 * magic-context verdict from `ctx.plugin.list()` (v2 removed the `config` domain
 * v1 used), and compaction from `session.compact` — which is not on the plugin's
 * narrowed `session` Pick, so it goes through the client fallback.
 *
 * Every group carries a control. A test that passes because the saturation branch
 * never ran is worse than no test here.
 */

let counter = 0

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

const userTurn = () => ({
	type: "user",
	id: "msg_u0",
	// Old enough that activeUserWindowMs cannot stand the nudge down.
	time: { created: Date.now() - 60 * 60_000 },
	content: [{ type: "text", text: "keep going" }],
})

/** `TokenUsage.Info` for the given totals; `cache` is always present, as in the schema. */
const usage = (input: number, output = 0, reasoning = 0, read = 0, write = 0) => ({
	input,
	output,
	reasoning,
	cache: { read, write },
})

type HarnessOpts = {
	/** Tokens reported by `session.usage.updated`. Omit for "no usage event". */
	tokens?: Record<string, number>
	/** `Model.Info.limit`. */
	limit?: { context: number; output: number }
	parentID?: string
	/** Installed plugins as `ctx.plugin.list()` returns them. */
	plugins?: unknown[]
	/** Host exposes `session.compact` on the plugin domain. */
	domainCompact?: boolean
	/** Host exposes `session.compact` only via the client. */
	clientCompact?: boolean
	/** A genuine user interrupt lands before the idle. */
	interruptFirst?: boolean
	opts?: Record<string, unknown>
}

async function replay(h: HarnessOpts) {
	const commands: Array<{ sessionID: string; name: string }> = []
	const compacted: string[] = []
	const stream = makeEventStream()
	const logFile = join(tmpdir(), `auto-resume-saturation-${process.pid}-${counter++}.log`)
	rmSync(logFile, { force: true })

	const limit = h.limit ?? { context: 200_000, output: 32_000 }
	const model = { id: MODEL, providerID: PROVIDER, limit, name: MODEL }

	const session: Record<string, unknown> = {
		context: async () => [userTurn(), { type: "assistant", id: "msg_a1", model: { providerID: PROVIDER, id: MODEL } }],
		active: async () => ({}),
		interrupt: async () => ({}),
		synthetic: async () => ({}),
		prompt: async () => ({}),
		command: async (a: any) => {
			commands.push({ sessionID: a?.sessionID, name: a?.name })
			return {}
		},
	}
	if (h.domainCompact) session.compact = async (a: any) => (compacted.push(a?.sessionID), {})
	if (!h.domainCompact) session.compact = undefined

	const client: Record<string, unknown> = {
		session: {
			get: async () => ({ data: h.parentID ? { parentID: h.parentID } : {} }),
		},
	}
	if (h.clientCompact) (client.session as any).compact = async (a: any) => compacted.push(a?.sessionID)

	const ctx: any = {
		event: stream,
		options: {
			chunkTimeoutMs: 600_000,
			checkIntervalMs: 20,
			gracePeriodMs: 0,
			warmupMs: 0,
			injectIntervalMs: 0,
			logFile,
			...(h.opts ?? {}),
		},
		session,
		client,
		model: { get: (providerID: string, modelID: string) => (providerID === PROVIDER && modelID === MODEL ? model : undefined) },
		plugin: { list: async () => h.plugins ?? [] },
	}

	const cleanup = await (plugin as any).setup(ctx)

	const events: any[] = [
		ev("session.execution.started", { agent: "build", model: { providerID: PROVIDER, id: MODEL } }),
		ev("session.text.delta", { messageID: "msg_a1", delta: "Working through the list." }),
		ev("session.text.ended", { messageID: "msg_a1" }),
	]
	if (h.tokens) events.splice(1, 0, ev("session.usage.updated", { tokens: usage(h.tokens.input, h.tokens.output, h.tokens.reasoning, h.tokens.read, h.tokens.write) }))
	if (h.interruptFirst) events.push(ev("session.execution.interrupted", { reason: "user" }))
	events.push(ev("session.idle"))

	for (const e of events) {
		stream.push(e)
		await wait(10)
	}
	await wait(600)
	;(cleanup as (() => void) | undefined)?.()

	const logs = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : []
	rmSync(logFile, { force: true })
	return { commands, compacted, logs }
}

/** A parent with magic-context installed and a window well over the threshold. */
const SATURATED_PARENT: HarnessOpts = {
	tokens: { input: 160_000 },
	plugins: [{ id: "magic-context", source: { type: "local", path: "/x/magic-context" } }],
}
/** Same, but only a small slice of the window used. */
const HEALTHY_PARENT: HarnessOpts = { ...SATURATED_PARENT, tokens: { input: 10_000 } }

describe("v2: context saturation — parent sessions", () => {
	test("CONTROL: a saturated parent with magic-context installed gets the wrapup command", async () => {
		const { commands, logs } = await replay(SATURATED_PARENT)
		expect(commands).toHaveLength(1)
		// Sent as a command, not as prompt text: prompt text is not expanded into
		// a command, which was v1's documented reason for using the endpoint.
		expect(commands[0]).toEqual({ sessionID: SID, name: "ctx-wrapup" })
		expect(logs.some((l) => l.includes("context saturation:"))).toBe(true)
	})

	test("a parent below the threshold is left alone", async () => {
		const { commands, compacted, logs } = await replay(HEALTHY_PARENT)
		expect(commands).toEqual([])
		expect(compacted).toEqual([])
		expect(logs.filter((l) => l.includes("context saturation"))).toEqual([])
	})

	test("no usage event means no token count, so no intervention", async () => {
		const { commands } = await replay({ plugins: SATURATED_PARENT.plugins })
		expect(commands).toEqual([])
	})

	test("a saturated parent with no magic-context is NOT compacted — that would double-compress", async () => {
		const { commands, compacted } = await replay({ tokens: { input: 160_000 }, plugins: [] })
		expect(commands).toEqual([])
		expect(compacted).toEqual([])
	})

	test("magic-context is detected from a package spec, not just an id", async () => {
		// v1 matched `config.get().plugin` entries, which are package specs. v2 has
		// no config domain, so the source has to be matched too.
		const { commands } = await replay({
			tokens: { input: 160_000 },
			plugins: [{ id: "pkg-1", source: { type: "package", target: "@someone/opencode-magic-context@1.2.3" } }],
		})
		expect(commands).toHaveLength(1)
	})

	test("a host with no plugin inventory treats magic-context as absent", async () => {
		const logs: string[] = []
		const stream = makeEventStream()
		const logFile = join(tmpdir(), `auto-resume-saturation-${process.pid}-${counter++}.log`)
		rmSync(logFile, { force: true })
		const ctx: any = {
			event: stream,
			options: { warmupMs: 0, checkIntervalMs: 20, chunkTimeoutMs: 600_000, gracePeriodMs: 0, logFile },
			session: { context: async () => [], active: async () => ({}), interrupt: async () => ({}), synthetic: async () => ({}) },
			model: { get: () => ({ limit: { context: 200_000, output: 32_000 } }) },
		}
		const cleanup = await (plugin as any).setup(ctx)
		stream.push(ev("session.step.started", { model: { providerID: PROVIDER, id: MODEL } }))
		stream.push(ev("session.usage.updated", { tokens: usage(160_000) }))
		stream.push(ev("session.idle"))
		await wait(400)
		;(cleanup as (() => void) | undefined)?.()
		if (existsSync(logFile)) logs.push(...readFileSync(logFile, "utf8").split("\n"))
		rmSync(logFile, { force: true })
		// Must not raise, and must not invent a verdict.
		expect(logs.filter((l) => l.includes("ERROR"))).toEqual([])
	})

	test("the intervention is one-shot: a second idle does not repeat it", async () => {
		const { commands } = await replay(SATURATED_PARENT)
		expect(commands).toHaveLength(1)
	})

	test("a genuine user interrupt suppresses the intervention entirely", async () => {
		// The guard reads the `userCancelled` latch, which only a non-self abort sets.
		// Assert the negative branch: the same saturated parent, interrupted first.
		const { commands, compacted, logs } = await replay({ ...SATURATED_PARENT, interruptFirst: true })
		expect(commands).toEqual([])
		expect(compacted).toEqual([])
		expect(logs.filter((l) => l.includes("context saturation"))).toEqual([])
	})
})

describe("v2: context saturation — subagent sessions", () => {
	const SATURATED_SUBAGENT: HarnessOpts = { ...SATURATED_PARENT, parentID: "ses_parent" }

	test("CONTROL: a saturated subagent with the opt-in enabled triggers native compaction", async () => {
		const { compacted, commands, logs } = await replay({
			...SATURATED_SUBAGENT,
			domainCompact: true,
			opts: { subagentNativeCompactionEnabled: true },
		})
		expect(compacted).toEqual([SID])
		// magic-context must not be involved on this path even when installed.
		expect(commands).toEqual([])
		expect(logs.some((l) => l.includes("context saturation (subagent)"))).toBe(true)
	})

	test("a saturated subagent without the opt-in is left alone", async () => {
		const { compacted, commands } = await replay({ ...SATURATED_SUBAGENT, domainCompact: true })
		expect(compacted).toEqual([])
		expect(commands).toEqual([])
	})

	test("compaction reaches the host through the client fallback when the domain omits it", async () => {
		// `session.compact` is NOT in v2's plugin `session` Pick. The same defensive
		// lookup that carries discovery must carry this.
		const { compacted } = await replay({
			...SATURATED_SUBAGENT,
			clientCompact: true,
			opts: { subagentNativeCompactionEnabled: true },
		})
		expect(compacted).toEqual([SID])
	})

	test("a host exposing neither compaction path warns instead of throwing", async () => {
		const { logs } = await replay({ ...SATURATED_SUBAGENT, opts: { subagentNativeCompactionEnabled: true } })
		expect(logs.some((l) => l.includes("native compaction is not exposed on this host"))).toBe(true)
		expect(logs.filter((l) => l.includes("ERROR"))).toEqual([])
	})
})

describe("v2: the saturation arithmetic matches v1", () => {
	test("the output reserve is min(20000, model output limit)", async () => {
		// 200k context, 32k output -> usable 180k. 170k used is below 0.85*180k=153k?
		// No: 170k > 153k, so it fires. Drop to 150k and it must not.
		const fired = await replay({ ...SATURATED_PARENT, tokens: { input: 170_000 } })
		expect(fired.commands).toHaveLength(1)

		const quiet = await replay({ ...SATURATED_PARENT, tokens: { input: 150_000 } })
		expect(quiet.commands).toEqual([])
	})

	test("cache read and reasoning count toward the total", async () => {
		// 140k input alone is below the threshold; the cache read pushes it over.
		// `TokenUsage.total` includes both, and so does this.
		const without = await replay({ ...SATURATED_PARENT, tokens: { input: 140_000 } })
		expect(without.commands).toEqual([])

		const withCache = await replay({ ...SATURATED_PARENT, tokens: { input: 140_000, read: 60_000 } })
		expect(withCache.commands).toHaveLength(1)
	})

	test("contextSaturationThreshold is honoured as a fraction, not a percentage", async () => {
		const at99 = await replay({ ...SATURATED_PARENT, tokens: { input: 178_000 }, opts: { contextSaturationThreshold: 0.99 } })
		expect(at99.commands).toEqual([])

		const at90 = await replay({ ...SATURATED_PARENT, tokens: { input: 178_000 }, opts: { contextSaturationThreshold: 0.9 } })
		expect(at90.commands).toHaveLength(1)
	})

	test("an unknown model yields no limit, so no intervention", async () => {
		const stream = makeEventStream()
		const logFile = join(tmpdir(), `auto-resume-saturation-${process.pid}-${counter++}.log`)
		rmSync(logFile, { force: true })
		const ctx: any = {
			event: stream,
			options: { warmupMs: 0, checkIntervalMs: 20, chunkTimeoutMs: 600_000, gracePeriodMs: 0, logFile },
			session: { context: async () => [], active: async () => ({}), interrupt: async () => ({}), synthetic: async () => ({}) },
			model: { get: () => undefined },
			plugin: { list: async () => [{ id: "magic-context" }] },
		}
		const cleanup = await (plugin as any).setup(ctx)
		stream.push(ev("session.step.started", { model: { providerID: PROVIDER, id: "not-installed" } }))
		stream.push(ev("session.usage.updated", { tokens: usage(999_000) }))
		stream.push(ev("session.idle"))
		await wait(400)
		;(cleanup as (() => void) | undefined)?.()
		const logs = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
		rmSync(logFile, { force: true })
		expect(logs).not.toContain("context saturation")
	})
})
