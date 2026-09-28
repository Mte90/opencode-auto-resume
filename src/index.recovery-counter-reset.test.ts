import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }
type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    failFirstPrompts?: number
    blockPrompt?: boolean
} = {}) {
    const logCalls: LogCall[] = []
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const release: Array<() => void> = []
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
                prompt: mock(async (config: any) => {
                    callIndex++
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                    })
                    if (opts.failFirstPrompts && callIndex <= opts.failFirstPrompts) {
                        throw new Error("simulated prompt failure")
                    }
                    if (opts.blockPrompt) {
                        return new Promise<void>((resolve) => release.push(resolve))
                    }
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls, abortCalls, release }
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

async function setup(extra: Record<string, unknown> = {}, mockOpts: { failFirstPrompts?: number; blockPrompt?: boolean } = {}) {
    const { ctx, logCalls, promptCalls, abortCalls, release } = createMockContext(mockOpts)
    const hooks = await AutoResumePlugin(ctx, { ...FAST, ...extra } as any)
    return { hooks, logCalls, promptCalls, abortCalls, release }
}

async function busy(hooks: any, sid: string) {
        await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
}

async function idle(hooks: any, sid: string) {
        await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } } as any)
}

async function interrupted(hooks: any, sid: string) {
        await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "interrupted" } } } as any)
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

function triggeredLogs(logCalls: LogCall[]): LogCall[] {
    return logCalls.filter((l) => l.level === "info" && l.message.includes("Pending recovery triggered"))
}

async function oocError(hooks: any, sid: string, message: string) {
    await hooks.event!({
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { error: { name: "ProviderInvalidRequest", data: { message } } },
        },
    } as any)
}

const OOC_MSG = "request (137039 tokens) exceeds the available context size (131072 tokens), try increasing it"

describe("Recovery counter reset + OOC latch", () => {
    test("OOC error latches; subsequent recovery is refused; user message clears", async () => {
        const { hooks, logCalls, promptCalls } = await setup()
        const sid = "ses_ooc_latch"
        await busy(hooks, sid)
        await streamError(hooks, sid)
        await oocError(hooks, sid, OOC_MSG)
        expect(logCalls.some((l) => l.message.includes("OOC error latched"))).toBe(true)
        await idle(hooks, sid)
        await wait(400)
        expect(logCalls.some((l) => l.message.includes("oocLocked latched, refusing"))).toBe(true)
        expect(promptCalls.length).toBe(0)
        await hooks["chat.message"]!({ sessionID: sid } as any, { message: {} as any, parts: [] } as any)
        await wait(100)
        expect(logCalls.some((l) => l.message.includes("clearing oocLocked"))).toBe(true)
    })

    test("busy caused by our recovery prompt preserves the resume counter", async () => {
        // debug: true routes dbg() to console.log, so we can observe the
        // preservation branch directly (old code has no such branch at all).
        const { hooks, promptCalls, release } = await setup({ debug: true }, { blockPrompt: true })
        const sid = "ses_preserve"
        const dbgLines: string[] = []
        const origLog = console.log
        console.log = (...args: unknown[]) => {
            dbgLines.push(args.join(" "))
        }
        try {
            await busy(hooks, sid)
            await streamError(hooks, sid)
            await idle(hooks, sid)
            expect(await waitFor(() => promptCalls.length >= 1)).toBe(true)
            // Server accepted our recovery prompt -> session goes busy again
            // while w.continuing is latched (prompt still in flight). Old code
            // reset resumeAttempts/gaveUp here on EVERY such busy event, so a
            // session that kept failing recovered forever (the incident loop).
            await busy(hooks, sid)
            expect(
                dbgLines.some((l) => l.includes("via recovery prompt - preserving resumeAttempts=")),
            ).toBe(true)
        } finally {
            console.log = origLog
            for (const r of release) r()
            await wait(200)
        }
    })
})
