import { describe, test, expect, mock } from "bun:test"
import { getLastAssistantError } from "./test-utils"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []

    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        defaultStatusMap[s.id] = { type: s.status }
    }
    const statusMap = opts.statusMap ?? defaultStatusMap

    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: {
                log: mock(async (_o: any) => {})
            },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map((s) => ({
                        id: s.id,
                        projectID: "proj-1",
                        directory: "/test",
                        title: s.id,
                        version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() },
                    }))
                })),
                status: mock(async () => ({ data: statusMap })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return opts.messages[config.path.id] ?? []
                }),
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
                })
            }
        },
        ui: { toast: mock(async () => {}) }
    } as any

    return { ctx, promptCalls, abortCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const OPTS = { enabled: true, baseBackoffMs: 1 }

const API_ERROR_503 = {
    error: {
        name: "APIError",
        data: {
            message: "Streaming response failed: [503] The request queue is full.",
            statusCode: 503,
            isRetryable: true,
        },
    },
}

describe("getLastAssistantError()", () => {
    test("returns null when no assistant message exists", () => {
        expect(getLastAssistantError([])).toBeNull()
        expect(
            getLastAssistantError([{ role: "user", parts: [] }])
        ).toBeNull()
    })

    test("returns null for assistant message without error", () => {
        expect(
            getLastAssistantError([
                { role: "assistant", parts: [{ type: "text", text: "hi" }] },
            ])
        ).toBeNull()
    })

    test("returns {name, message} for assistant message.error with data.message", () => {
        const result = getLastAssistantError([
            {
                role: "assistant",
                error: {
                    name: "APIError",
                    data: { message: "Streaming response failed", statusCode: 503 },
                },
            },
        ])
        expect(result).toEqual({
            name: "APIError",
            message: "Streaming response failed",
        })
    })

    test("handles nested info.error shape", () => {
        const result = getLastAssistantError([
            {
                info: {
                    role: "assistant",
                    error: {
                        name: "ProviderError",
                        data: { message: "stream failed" },
                    },
                },
            },
        ])
        expect(result).toEqual({ name: "ProviderError", message: "stream failed" })
    })

    test("returns the LAST assistant message's error, not an earlier one", () => {
        const result = getLastAssistantError([
            {
                role: "assistant",
                error: { name: "OldError", data: { message: "old" } },
            },
            { role: "user", parts: [] },
            {
                role: "assistant",
                error: { name: "NewError", data: { message: "new" } },
            },
        ])
        expect(result).toEqual({ name: "NewError", message: "new" })
    })

    test("falls back to error.message when data.message is absent", () => {
        const result = getLastAssistantError([
            {
                role: "assistant",
                error: { name: "StreamError", message: "fallback message" },
            },
        ])
        expect(result).toEqual({ name: "StreamError", message: "fallback message" })
    })

    test("scans retry parts for an ApiError", () => {
        const result = getLastAssistantError([
            {
                role: "assistant",
                parts: [
                    { type: "text", text: "thinking..." },
                    {
                        type: "retry",
                        error: {
                            name: "APIError",
                            data: { message: "Streaming response failed: [503]" },
                        },
                    },
                ],
            },
        ])
        expect(result).toEqual({
            name: "APIError",
            message: "Streaming response failed: [503]",
        })
    })

    test("prefers message.error over retry parts", () => {
        const result = getLastAssistantError([
            {
                role: "assistant",
                error: { name: "TopError", data: { message: "top" } },
                parts: [
                    {
                        type: "retry",
                        error: { name: "RetryError", data: { message: "retry" } },
                    },
                ],
            },
        ])
        expect(result).toEqual({ name: "TopError", message: "top" })
    })
})

describe("idle handler - streaming failure detection on message.error", () => {
    test("idle with 503 ApiError on last assistant message → recovery armed, prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_503", status: "idle" }],
            messages: {
                ses_503: [
                    { role: "user", parts: [{ type: "text", text: "go" }] },
                    { role: "assistant", ...API_ERROR_503, parts: [] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_503",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_503")
    })

    test("idle with nested info.error shape → recovery armed, prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_info", status: "idle" }],
            messages: {
                ses_info: [
                    {
                        info: {
                            role: "assistant",
                            error: {
                                name: "APIError",
                                data: {
                                    message:
                                        "Streaming response failed: [503] queue full",
                                },
                            },
                        },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_info",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_info")
    })

    test("idle with retry-part ApiError → recovery armed, prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_retry", status: "idle" }],
            messages: {
                ses_retry: [
                    { role: "user", parts: [{ type: "text", text: "go" }] },
                    {
                        role: "assistant",
                        parts: [
                            { type: "text", text: "..." },
                            {
                                type: "retry",
                                error: {
                                    name: "APIError",
                                    data: {
                                        message:
                                            "Streaming response failed: [503]",
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_retry",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_retry")
    })

    test("idle with MessageAbortedError → NOT classified as streaming failure, no prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_abort", status: "idle" }],
            messages: {
                ses_abort: [
                    {
                        role: "assistant",
                        error: { name: "MessageAbortedError", data: { message: "" } },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_abort",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("idle with non-streaming error → no streaming recovery, no prompt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_other", status: "idle" }],
            messages: {
                ses_other: [
                    {
                        role: "assistant",
                        error: {
                            name: "ValidationError",
                            data: { message: "invalid input" },
                        },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_other",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("idle with no error on last assistant → no streaming recovery (unchanged path)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_clean", status: "idle" }],
            messages: {
                ses_clean: [
                    { role: "user", parts: [{ type: "text", text: "hi" }] },
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "hello" }],
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_clean",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("does not re-arm when pendingRecovery already armed (no duplicate prompt)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_dup", status: "idle" }],
            messages: {
                ses_dup: [
                    { role: "assistant", ...API_ERROR_503, parts: [] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_dup",
                properties: { status: "idle" },
            },
        } as any)
        await wait(30)
        // Second idle event while first recovery is still in flight.
        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_dup",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        // Exactly one resume — tryResume's continuing/backoff guards prevent dup.
        expect(promptCalls.length).toBe(1)
    })
})
