import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

const AVAILABLE_TOOLS = ["read", "write", "bash", "task", "task_complete", "grep", "glob", "edit"]

function makeToolPart(opts: {
    id: string
    tool: string
    status: string
    error?: string
}): Record<string, unknown> {
    const state: Record<string, unknown> = { status: opts.status, input: {} }
    if (opts.error) state.error = opts.error
    if (opts.status === "completed") {
        state.output = "ok"
        state.title = "done"
        state.metadata = {}
        state.time = { start: 0, end: 1 }
    }
    if (opts.status === "error") {
        state.time = { start: 0, end: 1 }
    }
    return {
        id: opts.id,
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "tool",
        callID: opts.id,
        tool: opts.tool,
        state,
    }
}

function createMockContext(toolIds: string[] = AVAILABLE_TOOLS, messages: Array<Record<string, unknown>> = []) {
    const promptCalls: PromptCall[] = []
    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            tool: {
                ids: mock(async () => ({ data: toolIds })),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (_config: { path: { id: string } }) => ({ data: messages })),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                abort: mock(async () => {}),
                command: mock(async () => {}),
                summarize: mock(async () => {}),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FAST = {
    checkIntervalMs: 20,
    chunkTimeoutMs: 50,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 3,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    loopMaxContinues: 99,
    toolTextCheckDelayMs: 9999,
}

async function setup(
    toolIds: string[] = AVAILABLE_TOOLS,
    messages: Array<Record<string, unknown>> = [],
    extra: Record<string, unknown> = {},
) {
    const { ctx, promptCalls } = createMockContext(toolIds, messages)
    const hooks = await AutoResumePlugin(ctx, { ...FAST, ...extra } as any)
    return { hooks, promptCalls, ctx }
}

async function fireBusy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function fireIdle(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.idle", sessionID: sid, properties: {} } })
}

async function fireUserMessage(hooks: any, sid: string) {
    await hooks.event!({
        event: {
            type: "message.updated",
            sessionID: sid,
            properties: {
                info: { role: "user" },
            },
        },
    })
}

describe("unknown tool suggestion", () => {
    test("2x same non-existent tool → sends suggestion with closest match", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "raed", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "raed", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_suggestion")
        await fireIdle(hooks, "ses_suggestion")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_suggestion" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(1)
        expect(suggestionPrompts[0].body).toContain("raed")
        expect(suggestionPrompts[0].body).toContain("read")
    })

    test("1x non-existent tool → no suggestion (below threshold)", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_one")
        await fireIdle(hooks, "ses_one")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_one" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(0)
    })

    test("existing tool with error → no suggestion", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "bash", status: "error", error: "Command failed" }),
                    makeToolPart({ id: "tp2", tool: "bash", status: "error", error: "Command failed" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_existing")
        await fireIdle(hooks, "ses_existing")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_existing" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(0)
    })

    test("completed tool parts → no suggestion", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "completed" }),
                    makeToolPart({ id: "tp2", tool: "serach", status: "completed" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_completed")
        await fireIdle(hooks, "ses_completed")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_completed" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(0)
    })

    test("suggestion sent once → not repeated on second idle", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "serach", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_repeat")
        await fireIdle(hooks, "ses_repeat")
        await wait(200)

        const firstCount = promptCalls.filter(
            (p) => p.sid === "ses_repeat" && p.body.includes("does not exist"),
        ).length
        expect(firstCount).toBe(1)

        await fireIdle(hooks, "ses_repeat")
        await wait(200)

        const total = promptCalls.filter(
            (p) => p.sid === "ses_repeat" && p.body.includes("does not exist"),
        ).length
        expect(total).toBe(1)
    })

    test("reset on new user message → suggestion can fire again", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "serach", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_reset")
        await fireIdle(hooks, "ses_reset")
        await wait(200)

        const firstCount = promptCalls.filter(
            (p) => p.sid === "ses_reset" && p.body.includes("does not exist"),
        ).length
        expect(firstCount).toBe(1)

        await fireUserMessage(hooks, "ses_reset")
        await fireIdle(hooks, "ses_reset")
        await wait(200)

        const total = promptCalls.filter(
            (p) => p.sid === "ses_reset" && p.body.includes("does not exist"),
        ).length
        expect(total).toBe(2)
    })

    test("no close match → lists available tools without specific suggestion", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "zzzzzzzz", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "zzzzzzzz", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_nomatch")
        await fireIdle(hooks, "ses_nomatch")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_nomatch" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(1)
        expect(suggestionPrompts[0].body).toContain("Available tools include:")
        expect(suggestionPrompts[0].body).not.toContain("closest matching tool")
    })

    test("tool.ids() returns empty → no suggestion", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "serach", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup([], messages)
        await fireBusy(hooks, "ses_empty")
        await fireIdle(hooks, "ses_empty")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_empty" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(0)
    })

    test("two different non-existent tools → no suggestion (need 2x same name)", async () => {
        const messages = [
            {
                role: "assistant",
                parts: [
                    makeToolPart({ id: "tp1", tool: "serach", status: "error", error: "Tool not found" }),
                    makeToolPart({ id: "tp2", tool: "raed", status: "error", error: "Tool not found" }),
                ],
            },
        ]
        const { hooks, promptCalls } = await setup(AVAILABLE_TOOLS, messages)
        await fireBusy(hooks, "ses_diff")
        await fireIdle(hooks, "ses_diff")
        await wait(200)

        const suggestionPrompts = promptCalls.filter(
            (p) => p.sid === "ses_diff" && p.body.includes("does not exist"),
        )
        expect(suggestionPrompts).toHaveLength(0)
    })
})
