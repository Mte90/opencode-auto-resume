import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createMockContext() {
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

// Fast busy-stall loop so tryResume fires within ~30ms of going busy.
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

async function setup() {
    const { ctx, logCalls, promptCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    return { hooks, logCalls, promptCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
}

async function streamError(hooks: any, sid: string) {
    await hooks.event!({
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ProviderError", data: { message: "stream failed" } } },
        },
    } as any)
}

async function oocError(hooks: any, sid: string) {
    await hooks.event!({
        event: {
            type: "session.error",
            sessionID: sid,
            properties: {
                error: {
                    name: "ProviderInvalidRequest",
                    data: {
                        message:
                            "request (137039 tokens) exceeds the available context size (131072 tokens), try increasing it",
                    },
                },
            },
        },
    } as any)
}

async function userMessage(hooks: any, sid: string) {
    await hooks["chat.message"]!({ sessionID: sid } as any, { message: {} as any, parts: [] } as any)
}

// The OOC latch refuses every send while it holds. Those refusals must not
// count as attempts: no "retry sent" lies, no budget burn toward gaveUp,
// and once the user clears the latch the stall delivers a real prompt.
describe("ghost sends must not count as attempts", () => {
    test("oocLocked refusals burn nothing; user message restores delivery", async () => {
        const { hooks, logCalls, promptCalls } = await setup()
        const sid = "ses_ghost"

        await busy(hooks, sid)
        await streamError(hooks, sid)
        await oocError(hooks, sid)
        expect(logCalls.some((l) => l.message.includes("OOC error latched"))).toBe(true)

        // Several stall ticks while the latch holds: everything refused.
        await wait(800)

        expect(promptCalls.length).toBe(0)
        expect(logCalls.some((l) => l.message.includes("retry sent"))).toBe(false)
        expect(logCalls.some((l) => l.message.includes("retries exhausted") || l.message.includes("GAVE UP"))).toBe(
            false,
        )

        // A genuine user message clears the OOC latch and re-arms the
        // budget; the still-stalled session must now be nudged for real.
        await userMessage(hooks, sid)
        const delivered = await waitFor(() => promptCalls.length >= 1)
        expect(delivered).toBe(true)
        expect(promptCalls[0]!.sid).toBe(sid)
    })
})

describe("sendContinuePrompt refusal matrix", () => {
    test("every latch refuses with false; a clean session sends and returns true", async () => {
        const { hooks, promptCalls } = await setup()
        const send = (hooks as any).__sendContinuePromptForTest as
            (sid: string, text: string, w: unknown) => Promise<boolean>
        const sessions = (hooks as any).__sessionsForTest as Map<string, { [k: string]: unknown }>

        const cases: Array<[string, (w: { [k: string]: unknown }) => void]> = [
            ["userCancelled", (w) => { w.userCancelled = true }],
            ["completionSignaled", (w) => { w.completionSignaled = true }],
            ["gaveUp", (w) => { w.gaveUp = true }],
            ["oocLocked", (w) => { w.oocLocked = true }],
            ["continuing", (w) => { w.continuing = true }],
        ]

        for (const [name, setLatch] of cases) {
            const sid = `ses_m_${name}`
            await busy(hooks, sid)
            const w = sessions.get(sid)!
            expect(w).toBeDefined()
            setLatch(w)
            const sent = await send(sid, "continue", w)
            expect(sent).toBe(false)
        }

        // No prompt may have gone out for any latched session.
        expect(promptCalls.length).toBe(0)

        // Clean session: the send goes through and reports true.
        const sidClean = "ses_m_clean"
        await busy(hooks, sidClean)
        const wClean = sessions.get(sidClean)!
        const sentClean = await send(sidClean, "continue", wClean)
        expect(sentClean).toBe(true)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0]!.sid).toBe(sidClean)
    })
})
