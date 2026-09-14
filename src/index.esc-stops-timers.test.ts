import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }
type CommandCall = { sid: string; command: string }

function createMockContext(opts: {
    sessions?: Array<{ id: string; status: string }>
    messages?: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
    plugins?: Array<string | [string, unknown]>
    providers?: Array<{
        id: string
        models: Array<{ id: string; limit: { context: number; output: number } }>
    }>
    onMessages?: (config: { path: { id: string } }) => Promise<Array<any>> | Array<any>
    onConfigGet?: () => Promise<unknown>
} = {}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const commandCalls: CommandCall[] = []
    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions ?? []) defaultStatusMap[s.id] = { type: s.status }
    const statusMap = opts.statusMap ?? defaultStatusMap
    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            config: {
                get: mock(async () => {
                    if (opts.onConfigGet) return opts.onConfigGet()
                    return { data: { plugin: opts.plugins ?? [] } }
                }),
            },
            provider: {
                get: mock(async () => ({
                    data: opts.providers ?? [],
                })),
            },
            session: {
                list: mock(async () => ({
                    data: (opts.sessions ?? []).map((s) => ({ id: s.id })),
                })),
                status: mock(async () => ({ data: statusMap })),
                messages: mock(async (config: { path: { id: string } }) => {
                    if (opts.onMessages) return opts.onMessages(config)
                    return opts.messages?.[config.path.id] ?? []
                }),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    return {}
                }),
                command: mock(async (config: any) => {
                    commandCalls.push({ sid: config.path.id, command: config.body.command })
                    return {}
                }),
                summarize: mock(async () => ({})),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls, commandCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" },
]

const PROVIDERS = [
    {
        id: "testprov",
        models: [{ id: "model-x", limit: { context: 100_000, output: 8_000 } }],
    },
]

function statusEvent(sid: string, status: string) {
    return { event: { type: "session.status", sessionID: sid, properties: { status } } }
}

function todoEvent(sid: string, todos: any[]) {
    return { event: { type: "todo.updated", sessionID: sid, properties: { todos } } }
}

function streamErrorEvent(sid: string) {
    return {
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ProviderError", data: { message: "stream failed" } } },
        },
    }
}

async function cycle(hooks: any, sid: string, idleWaitMs = 60) {
    await hooks.event!(statusEvent(sid, "busy") as any)
    await wait(20)
    await hooks.event!(statusEvent(sid, "idle") as any)
    await wait(idleWaitMs)
}

describe("ESC stops every timer-driven send", () => {
    test("ESC during abort+resume delay → no continue is sent", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_abortdelay", status: "idle" }],
            messages: {
                "ses_abortdelay": [
                    { role: "user", parts: [{ type: "text", text: "do things" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Working through it" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 6,
            loopMaxContinues: 3,
            toolTextCheckDelayMs: 5,
            minActivityGapMs: 0,
            checkIntervalMs: 60_000,
        } as any)
        await hooks.event!(todoEvent("ses_abortdelay", OPEN_TODOS) as any)

        // Three idle nudges arm the hallucination loop; the fourth idle aborts.
        await cycle(hooks, "ses_abortdelay")
        await cycle(hooks, "ses_abortdelay")
        await cycle(hooks, "ses_abortdelay")
        await hooks.event!(statusEvent("ses_abortdelay", "busy") as any)
        await wait(20)
        await hooks.event!(statusEvent("ses_abortdelay", "idle") as any)

        // Wait for aborts to land (up to 3s), then ESC inside the 2s delay.
        // Note: the loop arms at the 3rd nudge, so several overlapping
        // abort+resume delays may be in flight — all must stand down.
        let waited = 0
        while (abortCalls.length === 0 && waited < 3000) {
            await wait(50)
            waited += 50
        }
        expect(abortCalls.length).toBeGreaterThanOrEqual(1)
        const abortsAtEsc = abortCalls.length
        const promptsAtEsc = promptCalls.length
        await hooks.event!(statusEvent("ses_abortdelay", "interrupted") as any)
        await wait(2600)

        expect(abortCalls.length).toBe(abortsAtEsc)
        expect(promptCalls.length).toBe(promptsAtEsc)
    }, 15000)

    test("ESC landing between guard check and send → no prompt (TOCTOU)", async () => {
        let hooks: any
        let interrupted = false
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_toctou", status: "idle" }],
            messages: {
                "ses_toctou": [
                    { role: "user", parts: [{ type: "text", text: "do things" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Working through it" }] },
                ],
            },
            onMessages: async (config) => {
                if (!interrupted && config.path.id === "ses_toctou") {
                    interrupted = true
                    await hooks.event!(statusEvent("ses_toctou", "interrupted") as any)
                }
                return [
                    { role: "user", parts: [{ type: "text", text: "do things" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Working through it" }] },
                ]
            },
        })
        hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 3,
            toolTextCheckDelayMs: 5,
            minActivityGapMs: 0,
            checkIntervalMs: 60_000,
        } as any)
        await hooks.event!(todoEvent("ses_toctou", OPEN_TODOS) as any)
        await hooks.event!(statusEvent("ses_toctou", "busy") as any)
        await wait(20)
        await hooks.event!(statusEvent("ses_toctou", "idle") as any)
        await wait(200)

        expect(interrupted).toBe(true)
        expect(promptCalls.length).toBe(0)
    })

    test("ESC before saturation command resolves → no ctx-wrapup command", async () => {
        let hooks: any
        let configInterrupted = false
        const { ctx, promptCalls, commandCalls } = createMockContext({
            sessions: [{ id: "ses_satesc", status: "idle" }],
            messages: {
                "ses_satesc": [
                    {
                        role: "user",
                        model: { providerID: "testprov", modelID: "model-x" },
                        parts: [{ type: "text", text: "go" }],
                    },
                ],
            },
            providers: PROVIDERS,
            onConfigGet: async () => {
                if (!configInterrupted) {
                    configInterrupted = true
                    await hooks.event!(statusEvent("ses_satesc", "interrupted") as any)
                }
                return { data: { plugin: ["@cortexkit/opencode-magic-context"] } }
            },
        })
        hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 60_000,
            chunkTimeoutMs: 10_000,
            gracePeriodMs: 0,
            subagentWaitMs: 100_000,
        } as any)
        await hooks.event!(statusEvent("ses_satesc", "busy") as any)
        // usable = 92k; 90k ratio = 0.978 >= 0.85
        await hooks.event!({
            event: {
                type: "message.updated",
                sessionID: "ses_satesc",
                properties: {
                    sessionID: "ses_satesc",
                    info: {
                        role: "assistant",
                        tokens: { input: 88_000, output: 2_000, cache: { read: 0, write: 0 } },
                    },
                },
            },
        } as any)
        await hooks.event!(statusEvent("ses_satesc", "idle") as any)
        await wait(150)

        expect(configInterrupted).toBe(true)
        expect(commandCalls.length).toBe(0)
        expect(promptCalls.length).toBe(0)
    })

    test("ESC inside watchdog window disarms recovery: no retry, no stale refire", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_wd", status: "idle" }],
            messages: {
                "ses_wd": [
                    { role: "user", parts: [{ type: "text", text: "do things" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Working through it" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRecoveryRetries: 2,
            toolTextCheckDelayMs: 200,
            minActivityGapMs: 0,
            checkIntervalMs: 20,
        } as any)

        // Arm recovery, then let the first attempt send.
        await hooks.event!(statusEvent("ses_wd", "busy") as any)
        await hooks.event!(streamErrorEvent("ses_wd") as any)
        await hooks.event!(statusEvent("ses_wd", "idle") as any)
        await wait(120)
        expect(promptCalls.length).toBe(1)

        // ESC inside the 200ms watchdog window → no retry may fire.
        await hooks.event!(statusEvent("ses_wd", "interrupted") as any)
        await wait(400)
        expect(promptCalls.length).toBe(1)

        // Re-engage with a fresh failure: disarmed budget means a new attempt.
        await (hooks as any)["chat.message"]({ sessionID: "ses_wd" }, { message: {}, parts: [] })
        await hooks.event!(statusEvent("ses_wd", "busy") as any)
        await hooks.event!(streamErrorEvent("ses_wd") as any)
        await hooks.event!(statusEvent("ses_wd", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(2)
    }, 15000)
})
