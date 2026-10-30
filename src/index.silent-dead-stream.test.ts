import { describe, test, expect, mock } from "bun:test"
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

describe("getLastSilentDeadStream()", () => {
    test("returns null when no assistant message exists", () => {
        const messages: Array<Record<string, unknown>> = [
            { role: "user", parts: [] },
        ]
        // Simulate the helper behavior
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })

    test("returns null when message has text parts", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [{ type: "text", text: "Hello world" }],
                tokens: { output: 50 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })

    test("detects silent dead stream with finish=unknown and no text parts", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [{ type: "reasoning", text: "thinking..." }],
                tokens: { output: 250 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toEqual({ finish: "unknown", outputTokens: 250 })
    })

    test("detects silent dead stream with empty parts array", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [],
                tokens: { output: 300 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toEqual({ finish: "unknown", outputTokens: 300 })
    })

    test("returns finish reason even when terminal (stop) - no text parts", () => {
        const messages = [
            {
                role: "assistant",
                finish: "stop",
                parts: [],
                tokens: { output: 250 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        // Function returns any finish reason when no text parts exist
        expect(result).toEqual({ finish: "stop", outputTokens: 250 })
    })

    test("returns null when finish reason is null/undefined", () => {
        const messages = [
            {
                role: "assistant",
                finish: "",
                parts: [],
                tokens: { output: 250 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })

    test("handles info.finish shape", () => {
        const messages = [
            {
                role: "assistant",
                info: {
                    finish: "unknown",
                },
                parts: [{ type: "reasoning", text: "thinking" }],
                tokens: { output: 200 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toEqual({ finish: "unknown", outputTokens: 200 })
    })

    test("handles info.tokens shape", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [],
                info: {
                    tokens: { output: 150 },
                },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toEqual({ finish: "unknown", outputTokens: 150 })
    })

    test("combines tokens from both msg.tokens and info.tokens", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [],
                tokens: { output: 100 },
                info: {
                    tokens: { output: 100 },
                },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toEqual({ finish: "unknown", outputTokens: 200 })
    })

    test("newest assistant message has text → returns null (completed normally, never walks past the final answer)", () => {
        const messages = [
            {
                role: "assistant",
                finish: "unknown",
                parts: [],
                tokens: { output: 100 },
            },
            { role: "user", parts: [] },
            {
                role: "assistant",
                finish: "stop",
                parts: [{ type: "text", text: "done" }],
                tokens: { output: 50 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })

    test("skips non-assistant roles", () => {
        const messages = [
            {
                role: "user",
                finish: "unknown",
                parts: [],
                tokens: { output: 250 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })

    test("handles info.role shape for non-assistant", () => {
        const messages = [
            {
                info: {
                    role: "user",
                },
                finish: "unknown",
                parts: [],
                tokens: { output: 250 },
            },
        ]
        const result = getLastSilentDeadStream(messages)
        expect(result).toBeNull()
    })
})

describe("idle handler - silent dead stream detection", () => {
    test("idle with silent dead stream (finish=unknown, no text, 250 tokens) → recovery armed, prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_silent", status: "idle" }],
            messages: {
                ses_silent: [
                    { role: "user", parts: [{ type: "text", text: "go" }] },
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [{ type: "reasoning", text: "thinking..." }],
                        tokens: { output: 250 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_silent",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_silent")
    })

    test("idle with silent dead stream (empty parts, 300 tokens) → recovery armed, prompt sent", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_empty", status: "idle" }],
            messages: {
                ses_empty: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [],
                        tokens: { output: 300 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_empty",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_empty")
    })

    test("idle with message that has text parts → NO recovery (not a silent dead stream)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_text", status: "idle" }],
            messages: {
                ses_text: [
                    { role: "user", parts: [{ type: "text", text: "go" }] },
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [{ type: "text", text: "Hello world" }],
                        tokens: { output: 250 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_text",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("idle with low-token silent stream (50 tokens) → NO recovery (below threshold)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_low", status: "idle" }],
            messages: {
                ses_low: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [],
                        tokens: { output: 50 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_low",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("idle with silent stream at exact threshold (200 tokens) → recovery armed", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_threshold", status: "idle" }],
            messages: {
                ses_threshold: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [],
                        tokens: { output: 200 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_threshold",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_threshold")
    })

    test("idle with finish=stop and no text → recovery armed (function doesn't filter terminal)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_stop", status: "idle" }],
            messages: {
                ses_stop: [
                    {
                        role: "assistant",
                        finish: "stop",
                        parts: [],
                        tokens: { output: 250 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_stop",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        // Function returns any finish reason with no text; threshold check passes
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_stop")
    })

    test("idle with no finish reason → NO recovery", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_nofinish", status: "idle" }],
            messages: {
                ses_nofinish: [
                    {
                        role: "assistant",
                        parts: [],
                        tokens: { output: 250 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_nofinish",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("silent dead stream detection respects custom threshold", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_custom", status: "idle" }],
            messages: {
                ses_custom: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [],
                        tokens: { output: 150 },
                    },
                ],
            },
        })
        // Set threshold to 100, so 150 tokens should trigger recovery
        const hooks = await AutoResumePlugin(ctx, { ...OPTS, silentDeadStreamMinTokens: 100 } as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_custom",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_custom")
    })

    test("silent dead stream with info.finish shape → recovery armed", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_info", status: "idle" }],
            messages: {
                ses_info: [
                    {
                        role: "assistant",
                        info: {
                            finish: "unknown",
                        },
                        parts: [{ type: "reasoning", text: "thinking" }],
                        tokens: { output: 250 },
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

    test("silent dead stream with info.tokens shape → recovery armed", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_infotokens", status: "idle" }],
            messages: {
                ses_infotokens: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [],
                        info: {
                            tokens: { output: 250 },
                        },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_infotokens",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_infotokens")
    })
    test("REGRESSION (reported bug): tool-call step (205 tok, no text) then final text answer → NO recovery", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_repro", status: "idle" }],
            messages: {
                ses_repro: [
                    { role: "user", parts: [{ type: "text", text: "do it" }] },
                    {
                        role: "assistant",
                        finish: "tool-calls",
                        parts: [{ type: "reasoning", text: "planning..." }],
                        tokens: { output: 205 },
                    },
                    { role: "user", parts: [{ type: "tool", state: { output: "ok" } }] },
                    {
                        role: "assistant",
                        finish: "stop",
                        parts: [{ type: "text", text: "A".repeat(4124) }],
                        tokens: { output: 1200 },
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_repro",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })

    test("dead stream detected but live status is busy again → recovery skipped (race guard)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_race", status: "idle" }],
            messages: {
                ses_race: [
                    {
                        role: "assistant",
                        finish: "unknown",
                        parts: [{ type: "reasoning", text: "thinking..." }],
                        tokens: { output: 250 },
                    },
                ],
            },
            statusMap: { ses_race: { type: "busy" } },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "session.status",
                sessionID: "ses_race",
                properties: { status: "idle" },
            },
        } as any)
        await wait(50)

        expect(promptCalls.length).toBe(0)
    })
})

/**
 * Inline implementation of getLastSilentDeadStream for testing purposes.
 * This mirrors the private function in src/index.ts.
 */
function getLastSilentDeadStream(
    messages: Array<Record<string, unknown>>,
): { finish: string; outputTokens: number } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const role = (msg.role as string) ??
            ((msg.info as Record<string, unknown> | undefined)?.role as string)
        if (role !== "assistant") continue

        const info = msg.info as Record<string, unknown> | undefined
        const finish = (msg.finish as string) ??
            (info?.finish as string) ??
            (info?.finishReason as string)
        if (!finish) continue

        const parts = (msg.parts as Array<Record<string, unknown>> | undefined) ?? []
        const hasText = parts.some((p) => {
            const t = p as Record<string, unknown>
            return t.type === "text" && typeof t.text === "string" && t.text.length > 0
        })
        if (hasText) return null

        const tokens = msg.tokens as Record<string, unknown> | undefined
        const tInfo = info?.tokens as Record<string, unknown> | undefined
        const output = ((tokens?.output as number) ?? 0) +
            ((tInfo?.output as number) ?? 0)
        return { finish, outputTokens: output }
    }
    return null
}