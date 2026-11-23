import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { STALL_NO_TODOS_PROMPT } from "./recovery/shared"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: { todos?: Array<{ content: string; status: string; priority: string }> } = {}) {
    const promptCalls: PromptCall[] = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: {
                log: mock(async () => {}),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    return {}
                }),
                abort: mock(async () => ({})),
                todo: opts.todos
                    ? mock(async () => opts.todos)
                    : undefined,
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls }
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

// Fast busy-stall loop so the stall path fires within ~30ms of going busy.
const FAST = {
    enabled: true,
    checkIntervalMs: 20,
    chunkTimeoutMs: 30,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 3,
    baseBackoffMs: 200,
    maxBackoffMs: 400,
    loopMaxContinues: 99,
    toolTextCheckDelayMs: 50_000,
    maxRecoveryRetries: 3,
    warmupMs: 60_000,
}

async function setup(opts: { todos?: Array<{ content: string; status: string; priority: string }> } = {}) {
    const { ctx, promptCalls } = createMockContext(opts)
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    return { hooks, promptCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
}

describe("todos-aware stall prompt", () => {
    test("stall with NO open todos sends the completion check, not bare continue", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_stall_empty"

        await busy(hooks, sid)
        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)
        expect(promptCalls[0]!.body).toBe(STALL_NO_TODOS_PROMPT)
        expect(promptCalls[0]!.body).toContain("task_complete")
    })

    test("stall with open todos keeps the classic continue", async () => {
        const { hooks, promptCalls } = await setup({
            todos: [{ content: "Finish the report", status: "pending", priority: "medium" }],
        })
        const sid = "ses_stall_open"

        await busy(hooks, sid)
        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)
        expect(promptCalls[0]!.body).toBe("continue")
    })
})
