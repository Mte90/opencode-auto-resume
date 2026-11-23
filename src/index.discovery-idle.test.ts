import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createMockContext(opts: { statusFails?: boolean; statusEntry?: Record<string, string> } = {}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: {
                log: mock(async (o: { body: { level: string; message: string } }) => {
                    logCalls.push({ level: o.body.level, message: o.body.message })
                }),
            },
            session: {
                list: mock(async () => ({ data: [{ id: "ses_dead" }] })),
                status: mock(async () => {
                    if (opts.statusFails) throw new Error("endpoint down")
                    // Successful fetch; nothing running unless the test says so.
                    return { data: opts.statusEntry ?? {} }
                }),
                messages: mock(async () => []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    return {}
                }),
                abort: mock(async () => ({})),
                todo: mock(async () => [
                    { content: "Finish the report", status: "pending", priority: "medium" },
                ]),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

const FAST = {
    enabled: true,
    checkIntervalMs: 20,
    chunkTimeoutMs: 100_000,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 3,
    baseBackoffMs: 200,
    maxBackoffMs: 400,
    loopMaxContinues: 99,
    toolTextCheckDelayMs: 50_000,
    maxRecoveryRetries: 3,
    warmupMs: 60_000,
    discoveryDelayMs: 20,
}

async function setup(opts: { statusFails?: boolean; statusEntry?: Record<string, string> } = {}) {
    const { ctx, logCalls, promptCalls } = createMockContext(opts)
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    return { hooks, logCalls, promptCalls }
}

// A session that exists in storage (with open todos) but was never run by
// this server process is idle by definition: absent from the live status
// map, no session.status event will ever arrive for it. Discovery must
// default it to idle so the periodic open-todos nudge can fire.
describe("discovery: storage sessions absent from the live status map", () => {
    test("successful empty status map → dead session gets the open-todos nudge", async () => {
        const { promptCalls } = await setup()
        const nudged = await waitFor(() => promptCalls.length >= 1)
        expect(nudged).toBe(true)
        expect(promptCalls[0]!.sid).toBe("ses_dead")
        expect(promptCalls[0]!.body).toContain("Finish the report")
    })

    test("status endpoint failure → no default, no nudge (unknown stays unknown)", async () => {
        const { promptCalls } = await setup({ statusFails: true })
        await wait(1000)
        expect(promptCalls.length).toBe(0)
    })

    test("session busy in the live map is NOT defaulted to idle", async () => {
        const { promptCalls } = await setup({ statusEntry: { ses_dead: "busy" } })
        await wait(1000)
        // Busy sessions are none of the nudge's business: the periodic
        // open-todos path only touches idle sessions.
        expect(promptCalls.length).toBe(0)
    })
})
