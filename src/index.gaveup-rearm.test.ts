import { describe, test, expect, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AutoResumePlugin } from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createMockContext(opts: { failFirstPrompts?: number } = {}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    let callIndex = 0
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
                    callIndex++
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    if (opts.failFirstPrompts && callIndex <= opts.failFirstPrompts) {
                        throw new Error("simulated prompt failure")
                    }
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

// Small chunkTimeoutMs so the busy-stall path fires within ~30ms; the
// first three session.prompt() calls throw so resumeAttempts climbs to
// maxRetries and the timer latches gaveUp ("all N retries exhausted").
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

async function setup(mockOpts: { failFirstPrompts?: number } = {}) {
    const { ctx, logCalls, promptCalls } = createMockContext(mockOpts)
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    return { hooks, logCalls, promptCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
}

async function userMessage(hooks: any, sid: string) {
    await hooks["chat.message"]!({ sessionID: sid } as any, { message: {} as any, parts: [] } as any)
}

describe("gaveUp re-arm on genuine user message", () => {
    test("contract: chat.message resets gaveUp/resumeAttempts/recoveryAttempts", () => {
        const hookStart = SOURCE.indexOf('"chat.message"')
        expect(hookStart).toBeGreaterThan(-1)
        const hookEnd = SOURCE.indexOf('"tool.execute.before"', hookStart)
        expect(hookEnd).toBeGreaterThan(hookStart)
        const body = SOURCE.slice(hookStart, hookEnd)
        expect(body).toMatch(/w\.gaveUp\s*=\s*false/)
        expect(body).toMatch(/w\.resumeAttempts\s*=\s*0/)
        expect(body).toMatch(/w\.recoveryAttempts\s*=\s*0/)
    })

    test("exhausted budget latches gaveUp and stays mute; a user message re-arms recovery", async () => {
        const { hooks, logCalls, promptCalls } = await setup({ failFirstPrompts: 3 })
        const sid = "ses_gaveup"

        // Burn the retry budget: every send fails, resumeAttempts hits
        // maxRetries, the stall timer latches gaveUp.
        await busy(hooks, sid)
        const latched = await waitFor(() =>
            logCalls.some((l) => l.message.includes("retries exhausted") || l.message.includes("GAVE UP")),
        )
        expect(latched).toBe(true)

        // Muted phase: sendContinuePrompt refuses from every code path,
        // so no further prompt may go out while the user stays silent.
        await wait(200)
        const countWhenMuted = promptCalls.length
        expect(countWhenMuted).toBeGreaterThanOrEqual(3)
        await wait(500)
        expect(promptCalls.length).toBe(countWhenMuted)

        // A genuine user message starts a new work cycle: the budget
        // re-arms and the next stall sends a real continue prompt.
        await userMessage(hooks, sid)
        const resumed = await waitFor(() => promptCalls.length > countWhenMuted)
        expect(resumed).toBe(true)
        expect(promptCalls[promptCalls.length - 1]!.sid).toBe(sid)
    })
})
