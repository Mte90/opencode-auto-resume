import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }
type CommandCall = { sid: string; command: string; args?: unknown }
type SummarizeCall = { sid: string }

function createMockContext(opts: {
    plugins?: Array<string | [string, unknown]>
    providers?: Array<{
        id: string
        models: Array<{ id: string; limit: { context: number; output: number } }>
    }>
} = {}) {
    const promptCalls: PromptCall[] = []
    const commandCalls: CommandCall[] = []
    const summarizeCalls: SummarizeCall[] = []
    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            config: {
                get: mock(async () => ({
                    data: { plugin: opts.plugins ?? [] },
                })),
            },
            provider: {
                get: mock(async () => ({
                    data: opts.providers ?? [],
                })),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (_config: { path: { id: string } }) => [
                    {
                        role: "user",
                        model: { providerID: "testprov", modelID: "model-x" },
                        parts: [{ type: "text", text: "go" }],
                    },
                ]),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                command: mock(async (config: any) => {
                    commandCalls.push({
                        sid: config.path.id,
                        command: config.body.command,
                        args: config.body.arguments,
                    })
                    return {}
                }),
                summarize: mock(async (config: any) => {
                    summarizeCalls.push({ sid: config.path.id })
                    return {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, commandCalls, summarizeCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const PROVIDERS = [
    {
        id: "testprov",
        models: [{ id: "model-x", limit: { context: 100_000, output: 8_000 } }],
    },
]

const OPTS = { checkIntervalMs: 20, chunkTimeoutMs: 10_000, gracePeriodMs: 0, subagentWaitMs: 100_000 } as any
const OPTS_SUBAGENT_NATIVE = { ...OPTS, subagentNativeCompactionEnabled: true } as any

async function beginSession(hooks: any, sid: string, parentID?: string) {
    await hooks.event!({
        event: {
            type: "session.created",
            sessionID: sid,
            properties: parentID ? { parentID } : {},
        },
    } as any)
    await hooks.event!({
        event: { type: "session.status", sessionID: sid, properties: { status: "busy" } },
    } as any)
}

async function saturate(hooks: any, sid: string, tokens: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
}) {
    await hooks.event!({
        event: {
            type: "message.updated",
            sessionID: sid,
            properties: {
                sessionID: sid,
                info: {
                    role: "assistant",
                    tokens: {
                        input: tokens.input,
                        output: tokens.output,
                        cache: {
                            read: tokens.cacheRead ?? 0,
                            write: tokens.cacheWrite ?? 0,
                        },
                    },
                },
            },
        },
    } as any)
}

async function goIdle(hooks: any, sid: string) {
    await hooks.event!({
        event: { type: "session.status", sessionID: sid, properties: { status: "idle" } },
    } as any)
    await wait(80)
}

describe("context saturation → compaction routing", () => {
    test("saturated parent + magic-context detected → session.command(ctx-wrapup)", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_sat")
        // usable = 100k - min(20k, 8k) = 92k; 90k ratio = 0.978 >= 0.85
        await saturate(hooks, "ses_sat", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_sat")

        expect(commandCalls).toHaveLength(1)
        expect(commandCalls[0]).toEqual({ sid: "ses_sat", command: "ctx-wrapup", args: "" })
        expect(promptCalls.filter((p) => p.sid === "ses_sat")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_sat")).toHaveLength(0)
    })

    test("magic-context NOT in config → no intervention (fail-safe)", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["file:///some/other/plugin"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_nomc")
        await saturate(hooks, "ses_nomc", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_nomc")

        expect(promptCalls.filter((p) => p.sid === "ses_nomc")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_nomc")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_nomc")).toHaveLength(0)
    })

    test("tokens below threshold → no intervention", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_low")
        // 40k / 92k = 0.43 < 0.85
        await saturate(hooks, "ses_low", { input: 38_000, output: 2_000 })
        await goIdle(hooks, "ses_low")

        expect(promptCalls.filter((p) => p.sid === "ses_low")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_low")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_low")).toHaveLength(0)
    })

    test("config.get fails → no intervention (fail-safe)", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({ providers: PROVIDERS })
        ctx.client.config.get = mock(async () => {
            throw new Error("config unavailable")
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_cfgfail")
        await saturate(hooks, "ses_cfgfail", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_cfgfail")

        expect(promptCalls.filter((p) => p.sid === "ses_cfgfail")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_cfgfail")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_cfgfail")).toHaveLength(0)
    })

    test("provider limits unavailable → no intervention (fail-safe)", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: [],
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_nolimit")
        await saturate(hooks, "ses_nolimit", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_nolimit")

        expect(promptCalls.filter((p) => p.sid === "ses_nolimit")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_nolimit")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_nolimit")).toHaveLength(0)
    })

    test("userCancelled → no intervention", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_esc")
        await saturate(hooks, "ses_esc", { input: 88_000, output: 2_000 })
        await hooks.event!({
            event: { type: "session.status", sessionID: "ses_esc", properties: { status: "interrupted" } },
        } as any)
        await goIdle(hooks, "ses_esc")

        expect(promptCalls.filter((p) => p.sid === "ses_esc")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_esc")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_esc")).toHaveLength(0)
    })

    test("at most one parent wrapup per busy cycle", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_once")
        await saturate(hooks, "ses_once", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_once")
        // second idle without a new busy cycle: no second wrapup
        await goIdle(hooks, "ses_once")

        expect(commandCalls.filter((c) => c.sid === "ses_once")).toHaveLength(1)
        expect(promptCalls.filter((p) => p.sid === "ses_once")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_once")).toHaveLength(0)
    })

    test("custom threshold option is respected", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, { ...OPTS, contextSaturationThreshold: 0.5 } as any)

        await beginSession(hooks, "ses_custom")
        // 50k / 92k = 0.54 >= 0.5 (custom), but < 0.85 (default)
        await saturate(hooks, "ses_custom", { input: 48_000, output: 2_000 })
        await goIdle(hooks, "ses_custom")

        expect(commandCalls.filter((c) => c.sid === "ses_custom")).toHaveLength(1)
        expect(promptCalls.filter((p) => p.sid === "ses_custom")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_custom")).toHaveLength(0)
    })

    test("saturated subagent + native compaction enabled → session.summarize", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS_SUBAGENT_NATIVE)

        await beginSession(hooks, "ses_sub", "ses_parent")
        await saturate(hooks, "ses_sub", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_sub")

        expect(summarizeCalls).toHaveLength(1)
        expect(summarizeCalls[0]).toEqual({ sid: "ses_sub" })
        expect(commandCalls.filter((c) => c.sid === "ses_sub")).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === "ses_sub")).toHaveLength(0)
    })

    test("saturated subagent + native compaction disabled → no intervention", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await beginSession(hooks, "ses_sub_off", "ses_parent")
        await saturate(hooks, "ses_sub_off", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_sub_off")

        expect(promptCalls.filter((p) => p.sid === "ses_sub_off")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_sub_off")).toHaveLength(0)
        expect(summarizeCalls.filter((s) => s.sid === "ses_sub_off")).toHaveLength(0)
    })

    test("saturated subagent + native enabled without magic-context → native summarize (no MC detection needed)", async () => {
        const { ctx, promptCalls, commandCalls, summarizeCalls } = createMockContext({
            plugins: ["file:///some/other/plugin"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS_SUBAGENT_NATIVE)

        await beginSession(hooks, "ses_sub_nomc", "ses_parent")
        await saturate(hooks, "ses_sub_nomc", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_sub_nomc")

        expect(promptCalls.filter((p) => p.sid === "ses_sub_nomc")).toHaveLength(0)
        expect(commandCalls.filter((c) => c.sid === "ses_sub_nomc")).toHaveLength(0)
        expect(summarizeCalls).toHaveLength(1)
        expect(summarizeCalls[0]).toEqual({ sid: "ses_sub_nomc" })
    })

    test("nested session.created parent metadata routes a subagent to native summarize", async () => {
        const { ctx, summarizeCalls } = createMockContext({
            plugins: ["@cortexkit/opencode-magic-context"],
            providers: PROVIDERS,
        })
        const hooks = await AutoResumePlugin(ctx, OPTS_SUBAGENT_NATIVE)

        await hooks.event!({
            event: {
                type: "session.created",
                sessionID: "ses_sub_nested",
                properties: { session: { parentID: "ses_parent" } },
            },
        } as any)
        await hooks.event!({
            event: { type: "session.status", sessionID: "ses_sub_nested", properties: { status: "busy" } },
        } as any)
        await saturate(hooks, "ses_sub_nested", { input: 88_000, output: 2_000 })
        await goIdle(hooks, "ses_sub_nested")

        expect(summarizeCalls).toHaveLength(1)
        expect(summarizeCalls[0]).toEqual({ sid: "ses_sub_nested" })
    })
})
