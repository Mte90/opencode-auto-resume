import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createPromptResponseContext(opts: {
    promptResult?: unknown | ((call: number) => unknown)
    promptThrowsOn?: number[]
}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    let callIndex = 0

    const ctx = {
        client: {
            app: {
                log: mock(async (o: { body: { level: string; message: string } }) => {
                    logCalls.push({ level: o.body.level, message: o.body.message })
                }),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => []),
                prompt: mock(async (config: {
                    path: { id: string }
                    body: { parts: Array<{ type: string; text: string }> }
                }) => {
                    callIndex++
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map(p => p.text).join(""),
                    })
                    if (opts.promptThrowsOn?.includes(callIndex)) {
                        throw new Error("simulated prompt failure")
                    }
                    if (typeof opts.promptResult === "function") {
                        return opts.promptResult(callIndex)
                    }
                    return opts.promptResult ?? {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any

    return { ctx, logCalls, promptCalls }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 800): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status },
        },
    }
}

function makeErrorEvent(sid: string, name: string, message: string) {
    return {
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name, data: { message } } },
        },
    }
}

const BASE_OPTS = {
    enabled: true,
    baseBackoffMs: 1,
    minActivityGapMs: 1,
}

async function triggerRecovery(hooks: any, sid: string) {
    await hooks.event(makeStatusEvent(sid, "busy"))
    await hooks.event(makeErrorEvent(sid, "ProviderError", "stream failed"))
    await hooks.event(makeStatusEvent(sid, "idle"))
}

describe("WP-06 â€” session.prompt() return value validation", () => {
    test("successful prompt response is logged at debug with structure info", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptResult: {
                data: {
                    info: { id: "msg-1", role: "assistant" },
                    parts: [{ type: "text", text: "working" }],
                },
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_pr"

        await triggerRecovery(hooks, sid)
        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)

        const structLog = logCalls.find(l => l.message.includes("session.prompt() response received"))!
        expect(structLog).toBeDefined()
        expect(structLog.level).toBe("debug")
        expect(structLog.message).toContain('"sessionId":"ses_pr"')
        expect(structLog.message).toContain('"isRetry":false')
        expect(structLog.message).toContain('"hasParts":true')
        expect(structLog.message).toContain('"partsCount":1')
        expect(structLog.message).toContain('"infoKeys":')
        expect(logCalls.some(l => l.message.includes("empty parts array"))).toBe(false)
        expect(logCalls.some(l => l.message.includes("contains error indicator"))).toBe(false)
        expect(promptCalls.length).toBe(1)
    })

    test("empty parts array triggers a warn log (possible stream initiation failure)", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptResult: {
                data: {
                    info: { id: "msg-1", role: "assistant" },
                    parts: [],
                },
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_empty"

        await triggerRecovery(hooks, sid)
        const warned = await waitFor(() => logCalls.some(l => l.message.includes("empty parts array")))
        expect(warned).toBe(true)

        const warnLog = logCalls.find(l => l.level === "warn" && l.message.includes("possible stream initiation failure"))!!
        expect(warnLog).toBeDefined()
        expect(warnLog.message).toContain('"sessionId":"ses_empty"')
        expect(warnLog.message).toContain('"isRetry":false')
        expect(warnLog.message).toContain('"partsCount":0')
        expect(warnLog.message).toContain('"responseInfo":')
        expect(promptCalls.length).toBe(1)
    })

    test("error indicator in response.info triggers a warn log", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptResult: {
                data: {
                    info: {
                        id: "msg-1",
                        role: "assistant",
                        error: { name: "StreamError", message: "stream failed" },
                    },
                    parts: [{ type: "text", text: "partial" }],
                },
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_err"

        await triggerRecovery(hooks, sid)
        const warned = await waitFor(() => logCalls.some(l => l.message.includes("contains error indicator")))
        expect(warned).toBe(true)

        const warnLog = logCalls.find(l => l.level === "warn" && l.message.includes("contains error indicator"))!!
        expect(warnLog).toBeDefined()
        expect(warnLog.message).toContain('"sessionId":"ses_err"')
        expect(warnLog.message).toContain('"isRetry":false')
        expect(warnLog.message).toContain('"errorInfo":')
        expect(warnLog.message).toContain("StreamError")
        expect(promptCalls.length).toBe(1)
    })

    test("retry prompt response is logged with isRetry:true context", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptThrowsOn: [1],
            promptResult: {
                data: {
                    info: { id: "msg-2", role: "assistant" },
                    parts: [{ type: "text", text: "retried" }],
                },
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_retry"

        await triggerRecovery(hooks, sid)
        const retried = await waitFor(() => promptCalls.length >= 2)
        expect(retried).toBe(true)

        expect(logCalls.some(l => l.level === "warn" && l.message.includes("prompt failed"))).toBe(true)
        const retryLog = logCalls.find(l =>
            l.message.includes("session.prompt() response received") && l.message.includes('"isRetry":true'),
        )!
        expect(retryLog).toBeDefined()
        expect(retryLog.message).toContain('"sessionId":"ses_retry"')
        expect(retryLog.message).toContain('"hasParts":true')
        expect(retryLog.message).toContain('"partsCount":1')
    })

    test("raw response payload shape (without data wrapper) is handled and raw JSON logged", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptResult: {
                info: { id: "msg-3", role: "assistant" },
                parts: [{ type: "text", text: "direct" }],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_direct"

        await triggerRecovery(hooks, sid)
        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)

        const structLog = logCalls.find(l => l.message.includes("session.prompt() response received"))!
        expect(structLog).toBeDefined()
        expect(structLog.message).toContain('"partsCount":1')
        expect(structLog.message).toContain('"hasParts":true')

        const rawLog = logCalls.find(l => l.message.includes("session.prompt() raw response"))!
        expect(rawLog).toBeDefined()
        expect(rawLog.message).toContain('"rawResponse":')
        expect(rawLog.message).toContain("direct")
        expect(promptCalls.length).toBe(1)
    })

    test("unexpected response structure is logged at debug without throwing", async () => {
        const { ctx, logCalls, promptCalls } = createPromptResponseContext({
            promptResult: {},
        })
        const hooks = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            toolTextCheckDelayMs: 300,
            checkIntervalMs: 20,
        } as any)
        const sid = "ses_odd"

        await triggerRecovery(hooks, sid)
        const logged = await waitFor(() => logCalls.some(l => l.message.includes("unexpected structure")))
        expect(logged).toBe(true)

        const debugLog = logCalls.find(l => l.message.includes("unexpected structure"))!
        expect(debugLog.level).toBe("debug")
        expect(debugLog.message).toContain('"sessionId":"ses_odd"')
        expect(debugLog.message).toContain('"rawResponse":"{}"')
        expect(logCalls.some(l => l.level === "warn" && l.message.includes("empty parts array"))).toBe(false)
        expect(promptCalls.length).toBe(1)
    })
})
