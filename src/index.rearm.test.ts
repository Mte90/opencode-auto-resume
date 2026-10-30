import { describe, test, expect, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AutoResumePlugin } from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
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
}

async function setup() {
    const { ctx, logCalls, promptCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    return { hooks, logCalls, promptCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function idle(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
}

async function interrupted(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.interrupted", sessionID: sid } })
}

async function userMessage(hooks: any, sid: string) {
    await hooks["chat.message"]({ sessionID: sid }, { message: {}, parts: [] })
}

async function streamError(hooks: any, sid: string) {
    await hooks.event!({
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ProviderError", data: { message: "stream failed" } } },
        },
    })
}

// ============================================================================
// CONTRACT TESTS — fail deterministically if someone removes the fix.
// ============================================================================

describe("Re-arm on user message: contract assertions on source", () => {
    test("chat.message hook exists and clears both latches", () => {
        const hookStart = SOURCE.indexOf('"chat.message"')
        expect(hookStart).toBeGreaterThan(-1)
        const hookEnd = SOURCE.indexOf('"tool.execute.before"', hookStart)
        expect(hookEnd).toBeGreaterThan(hookStart)
        const body = SOURCE.slice(hookStart, hookEnd)
        expect(body).toMatch(/w\.userCancelled\s*=\s*false/)
        expect(body).toMatch(/w\.completionSignaled\s*=\s*false/)
    })

    test("chat.message ignores the plugin's own recovery prompts (continuing guard)", () => {
        const hookStart = SOURCE.indexOf('"chat.message"')
        const hookEnd = SOURCE.indexOf('"tool.execute.before"', hookStart)
        const body = SOURCE.slice(hookStart, hookEnd)
        expect(body).toMatch(/if\s*\(\s*w\.continuing\s*\)\s*return/)
    })

    test("issue #16 contract still holds: resetBusyFlags preserves userCancelled", () => {
        const fnStart = SOURCE.indexOf("function resetBusyFlags")
        expect(fnStart).toBeGreaterThan(-1)
        const fnEnd = SOURCE.indexOf("// PRESERVE", fnStart)
        expect(fnEnd).toBeGreaterThan(fnStart)
        const body = SOURCE.slice(fnStart, fnEnd)
        expect(body).not.toMatch(/w\.userCancelled\s*=\s*false/)
        expect(body).not.toMatch(/w\.completionSignaled\s*=\s*false/)
    })
})

// ============================================================================
// BEHAVIORAL TESTS — drive the real plugin through ESC → new prompt → stall.
// ============================================================================

describe("Re-arm on user message: behavioral tests", () => {
    test("ESC, then a new user prompt, then a stall → recovery fires again", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_rearm"

        // Round 1: user interrupts mid-run; recovery must stay quiet
        await busy(hooks, sid)
        await interrupted(hooks, sid)
        await idle(hooks, sid)
        await wait(350)
        expect(promptCalls.length).toBe(0)

        // Round 2: user types a new prompt (chat.message), session goes busy,
        // then a streaming failure hits — recovery must be armed again
        await userMessage(hooks, sid)
        await busy(hooks, sid)
        await streamError(hooks, sid)
        await idle(hooks, sid)

        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)
        expect(promptCalls[0]!.sid).toBe(sid)
    })

    test("without a new user prompt, ESC back-off still sticks (issue #16)", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_stick"

        await busy(hooks, sid)
        await streamError(hooks, sid)
        await interrupted(hooks, sid)

        // Busy/idle cycles alone must not re-arm
        await busy(hooks, sid)
        await idle(hooks, sid)
        await wait(350)
        expect(promptCalls.length).toBe(0)
    })

    test("re-arm also lifts the task_complete latch", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_done"

        // task_complete latches completionSignaled
        await busy(hooks, sid)
        await hooks.tool!.task_complete.execute({} as any, { sessionID: sid } as any)
        await idle(hooks, sid)
        await wait(350)
        expect(promptCalls.length).toBe(0)

        // New user prompt starts a new round of work; a stall must recover
        await userMessage(hooks, sid)
        await busy(hooks, sid)
        await streamError(hooks, sid)
        await idle(hooks, sid)

        const sent = await waitFor(() => promptCalls.length >= 1)
        expect(sent).toBe(true)
    })

    test("chat.message without sessionID is a no-op", async () => {
        const { hooks, promptCalls } = await setup()
        await hooks["chat.message"]!({} as any, { message: {}, parts: [] } as any)
        await wait(50)
        expect(promptCalls.length).toBe(0)
    })
})
