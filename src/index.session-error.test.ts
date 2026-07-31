import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }

function createMockContext() {
    const logCalls: LogCall[] = []
    const promptCalls: Array<{ sid: string }> = []
    const ctx = {
        client: {
            app: {
                log: mock(async (o: any) => {
                    logCalls.push({ level: o.body.level, message: o.body.message })
                }),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({ sid: config.path.id })
                    return {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const OPTS = { enabled: true, baseBackoffMs: 1 }

function logsOf(logCalls: LogCall[], level: string, message: string): LogCall[] {
    return logCalls.filter((l) => l.level === level && l.message === message)
}

function anyStreamingInfo(logCalls: LogCall[]): boolean {
    return logCalls.some((l) => l.level === "info" && l.message.startsWith("Streaming failure detected:"))
}

function anyStreamingWarn(logCalls: LogCall[]): boolean {
    return logCalls.some((l) => l.level === "warn" && l.message.startsWith("Streaming failure detected but no session ID:"))
}

async function busy(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function idle(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
}

async function sendError(hooks: any, event: Record<string, unknown>) {
    await hooks.event({ event })
}

describe("handleEvent - session.error (streaming failure detection)", () => {
    test("TC-01: StreamTimeoutError with stream message on busy session → streaming failure logged", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_tc01"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "StreamTimeoutError", data: { message: "stream failed" } } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "Streaming failure detected: StreamTimeoutError - stream failed").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-02: ConnectionReset with connection message on busy session → streaming failure logged", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_tc02"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ConnectionReset", data: { message: "Connection reset by peer" } } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "Streaming failure detected: ConnectionReset - Connection reset by peer").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-03: MessageAbortedError → user abort path unchanged, not classified as streaming failure", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_tc03"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "MessageAbortedError" } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "User abort (ESC)").length).toBe(1)
        expect(anyStreamingInfo(logCalls)).toBe(false)
        expect(anyStreamingWarn(logCalls)).toBe(false)
        expect(logsOf(logCalls, "debug", "Session error: MessageAbortedError - ").length).toBe(0)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-04: generic error on busy session → no streaming classification, debug log preserved", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_tc04"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "SomeError", data: { message: "something happened" } } },
        })
        await wait(50)

        expect(anyStreamingInfo(logCalls)).toBe(false)
        expect(anyStreamingWarn(logCalls)).toBe(false)
        expect(logsOf(logCalls, "debug", "Session error: SomeError - something happened").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-05: streaming failure without session ID → warning only", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await sendError(hooks, {
            type: "session.error",
            properties: { error: { name: "TimeoutError" } },
        })
        await wait(50)

        expect(logsOf(logCalls, "warn", "Streaming failure detected but no session ID: TimeoutError - ").length).toBe(1)
        expect(anyStreamingInfo(logCalls)).toBe(false)
        expect(logsOf(logCalls, "debug", "Session error: TimeoutError - ").length).toBe(0)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-06: streaming failure with busyCount === 0 (idle session) → logged, break before recovery state", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_tc06"
        await idle(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "TimeoutError" } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "Streaming failure detected: TimeoutError - ").length).toBe(1)
        expect(logsOf(logCalls, "debug", "Session error: TimeoutError - ").length).toBe(0)
        expect(promptCalls.length).toBe(0)
    })

    test("TC-07: streaming failure with valid sid but session not in map → logged, no crash", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await sendError(hooks, {
            type: "session.error",
            sessionID: "ses_tc07",
            properties: { error: { name: "TimeoutError" } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "Streaming failure detected: TimeoutError - ").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })

    test("custom streamingFailureErrorNames option is honored by the handler", async () => {
        const { ctx, logCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, {
            ...OPTS,
            streamingFailureErrorNames: ["CustomStreamError"],
        } as any)
        const sid = "ses_custom"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "CustomStreamError" } },
        })
        await wait(50)

        expect(logsOf(logCalls, "info", "Streaming failure detected: CustomStreamError - ").length).toBe(1)
    })

    test("error name not in default patterns → generic handling", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_nomatch"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "CustomStreamError" } },
        })
        await wait(50)

        expect(anyStreamingInfo(logCalls)).toBe(false)
        expect(logsOf(logCalls, "debug", "Session error: CustomStreamError - ").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })

    test("session.error without error object → safe generic handling", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)
        const sid = "ses_noerr"
        await busy(hooks, sid)

        await sendError(hooks, {
            type: "session.error",
            sessionID: sid,
            properties: {},
        })
        await wait(50)

        expect(anyStreamingInfo(logCalls)).toBe(false)
        expect(anyStreamingWarn(logCalls)).toBe(false)
        expect(logsOf(logCalls, "debug", "Session error:  - ").length).toBe(1)
        expect(promptCalls.length).toBe(0)
    })
})
