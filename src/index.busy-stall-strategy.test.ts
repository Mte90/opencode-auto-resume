import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext() {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (_config: { path: { id: string } }) => []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FAST = {
    checkIntervalMs: 20,
    chunkTimeoutMs: 50,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 1,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    loopMaxContinues: 99,
}

async function setup(extra: Record<string, unknown> = {}) {
    const { ctx, promptCalls, abortCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, { ...FAST, ...extra } as any)
    return { hooks, promptCalls, abortCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function stall(hooks: any, sid: string) {
    await busy(hooks, sid)
    await wait(300)
}

describe("busyStallStrategy", () => {
    test("default (option absent): stall sends a continue prompt, no abort", async () => {
        const { hooks, promptCalls, abortCalls } = await setup()
        await stall(hooks, "ses_default")
        expect(promptCalls.filter((p) => p.sid === "ses_default").length).toBeGreaterThanOrEqual(1)
        expect(abortCalls.filter((a) => a.sid === "ses_default")).toHaveLength(0)
    })

    test("explicit \"continue\": same as default", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({ busyStallStrategy: "continue" })
        await stall(hooks, "ses_continue")
        expect(promptCalls.filter((p) => p.sid === "ses_continue").length).toBeGreaterThanOrEqual(1)
        expect(abortCalls.filter((a) => a.sid === "ses_continue")).toHaveLength(0)
    })

    test("\"abort\": stall aborts the session before continuing", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({ busyStallStrategy: "abort" })
        await stall(hooks, "ses_abort")
        expect(abortCalls.filter((a) => a.sid === "ses_abort").length).toBeGreaterThanOrEqual(1)
        // ABORT_CONTINUE_DELAY_MS (2000ms) has not elapsed yet, so no prompt at this point
        expect(promptCalls.filter((p) => p.sid === "ses_abort")).toHaveLength(0)
    })

    test("\"off\": stall sends nothing", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({ busyStallStrategy: "off" })
        await stall(hooks, "ses_off")
        expect(promptCalls.filter((p) => p.sid === "ses_off")).toHaveLength(0)
        expect(abortCalls.filter((a) => a.sid === "ses_off")).toHaveLength(0)
    })

    test("invalid value falls back to \"continue\"", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({ busyStallStrategy: "nonsense" })
        await stall(hooks, "ses_invalid")
        expect(promptCalls.filter((p) => p.sid === "ses_invalid").length).toBeGreaterThanOrEqual(1)
        expect(abortCalls.filter((a) => a.sid === "ses_invalid")).toHaveLength(0)
    })

    test("\"abort\" respects the in-flight tool guard: no abort while a tool runs", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({ busyStallStrategy: "abort" })
        const sid = "ses_abort_tool"
        await busy(hooks, sid)
        await hooks["tool.execute.before"]!({ tool: "bash", sessionID: sid, callID: "c1" }, { args: {} })
        await wait(300)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === sid)).toHaveLength(0)
    })
})
