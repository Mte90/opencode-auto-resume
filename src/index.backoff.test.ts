import { describe, test, expect, mock } from "bun:test"
import { backoffMs, AutoResumePlugin } from "./index"

describe("backoffMs()", () => {
    describe("formula verification", () => {
        test("attempt 0 uses base * 2^-1", () => {
            expect(backoffMs(0, 1000, 8000)).toBe(500)
        })

        test("attempt 1 = base", () => {
            expect(backoffMs(1, 1000, 8000)).toBe(1000)
        })

        test("attempt 2 = 2 * base", () => {
            expect(backoffMs(2, 1000, 8000)).toBe(2000)
        })

        test("attempt 3 = 4 * base", () => {
            expect(backoffMs(3, 1000, 8000)).toBe(4000)
        })

        test("attempt N = 2^(N-1) * base (exponential growth)", () => {
            expect(backoffMs(4, 1000, 8000)).toBe(8000)
            expect(backoffMs(6, 1, 100_000)).toBe(32)
            expect(backoffMs(10, 1, 100_000)).toBe(512)
        })
    })

    describe("cap enforcement", () => {
        test("result is capped at maxBackoffMs", () => {
            expect(backoffMs(5, 1000, 8000)).toBe(8000)
            expect(backoffMs(20, 1000, 8000)).toBe(8000)
        })

        test("high attempts with small base cap quickly", () => {
            expect(backoffMs(10, 1, 8)).toBe(8)
        })

        test("maxBackoffMs == baseBackoffMs caps every attempt", () => {
            expect(backoffMs(0, 1000, 1000)).toBe(500)
            expect(backoffMs(1, 1000, 1000)).toBe(1000)
            expect(backoffMs(5, 1000, 1000)).toBe(1000)
        })
    })

    describe("config variations", () => {
        test("custom baseBackoffMs shifts the curve", () => {
            expect(backoffMs(1, 500, 8000)).toBe(500)
            expect(backoffMs(2, 500, 8000)).toBe(1000)
        })

        test("custom maxBackoffMs caps earlier", () => {
            expect(backoffMs(3, 1000, 3000)).toBe(3000)
            expect(backoffMs(4, 1000, 3000)).toBe(3000)
        })

        test("both custom base and max", () => {
            expect(backoffMs(3, 100, 5000)).toBe(400)
            expect(backoffMs(10, 100, 5000)).toBe(5000)
        })

        test("defaults match the plugin defaults (1000 / 8000)", () => {
            expect(backoffMs(1)).toBe(1000)
            expect(backoffMs(3)).toBe(4000)
            expect(backoffMs(5)).toBe(8000)
        })
    })

    describe("edge cases", () => {
        test("negative attempt follows the formula (no clamp, never hit in practice)", () => {
            expect(backoffMs(-1, 1000, 8000)).toBe(250)
            expect(backoffMs(-1)).toBe(250)
        })

        test("zero baseBackoffMs returns 0", () => {
            expect(backoffMs(3, 0, 8000)).toBe(0)
        })

        test("zero maxBackoffMs returns 0", () => {
            expect(backoffMs(3, 1000, 0)).toBe(0)
        })
    })
})

describe("backoffMs() integration with the timer loop", () => {
    type LogCall = { level: string; message: string }
    type PromptCall = { sid: string; body: string }

    function createMockContext() {
        const logCalls: LogCall[] = []
        const promptCalls: PromptCall[] = []
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
                    prompt: mock(async (config: any) => {
                        promptCalls.push({ sid: config.path.id, body: config.body.parts.map((p: any) => p.text).join("") })
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

    async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (cond()) return true
            await wait(10)
        }
        return cond()
    }

    async function busy(hooks: any, sid: string) {
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
    }

    async function idle(hooks: any, sid: string) {
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
    }

    async function streamError(hooks: any, sid: string) {
        await hooks.event({
            event: { type: "session.error", sessionID: sid, properties: { error: { name: "ProviderError", data: { message: "stream failed" } } } },
        })
    }

    test("pending recovery trigger waits for backoffMs(0)", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 20,
            chunkTimeoutMs: 100_000,
            gracePeriodMs: 0,
            subagentWaitMs: 100_000,
            maxRetries: 3,
            baseBackoffMs: 1000,
            maxBackoffMs: 1000,
            loopMaxContinues: 99,
            toolTextCheckDelayMs: 50_000,
            maxRecoveryRetries: 3,
            warmupMs: 60_000,
        } as any)
        const sid = "ses_backoff_delay"

        await busy(hooks, sid)
        await streamError(hooks, sid)
        await idle(hooks, sid)

        // backoffMs(0) = 500ms; nothing may fire before it elapses
        await wait(250)
        expect(promptCalls.length).toBe(0)
        expect(logCalls.some((l) => l.level === "info" && l.message.includes("Pending recovery triggered"))).toBe(false)

        const triggered = await waitFor(() => promptCalls.length >= 1)
        expect(triggered).toBe(true)
        expect(logCalls.some((l) => l.level === "info" && l.message.includes("Pending recovery triggered"))).toBe(true)
    })

    test("watchdog retry uses backoffMs(recoveryAttempts) with configured base", async () => {
        const { ctx, logCalls, promptCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            checkIntervalMs: 20,
            chunkTimeoutMs: 100_000,
            gracePeriodMs: 0,
            subagentWaitMs: 100_000,
            maxRetries: 3,
            baseBackoffMs: 1000,
            maxBackoffMs: 1000,
            loopMaxContinues: 99,
            toolTextCheckDelayMs: 60,
            maxRecoveryRetries: 3,
            warmupMs: 60_000,
        } as any)
        const sid = "ses_backoff_retry"

        await busy(hooks, sid)
        await streamError(hooks, sid)
        await idle(hooks, sid)

        const sent = await waitFor(() => promptCalls.length >= 1, 3000)
        expect(sent).toBe(true)

        // Watchdog retry at recoveryAttempts=2 → backoffMs(2, 1000, 1000) = 1000
        const retried = await waitFor(
            () => logCalls.some((l) => l.level === "info" && l.message.includes("Retrying recovery on") && l.message.includes("attempt=2") && l.message.includes("backoffMs=1000")),
            3000,
        )
        expect(retried).toBe(true)
    })
})
