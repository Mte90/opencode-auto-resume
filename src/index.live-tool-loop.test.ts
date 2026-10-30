import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext() {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (_config: { path: { id: string } }) => []),
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
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Mirrors the observed production loop: identical tool, args alternating
// between two nearly-identical ranges — never 3 consecutive identical calls,
// but a period-2 cycle repeated many times.
const READ_A = { filePath: "src/config/phases.rs", startLine: 66, endLine: 72 }
const READ_B = { filePath: "src/config/phases.rs", startLine: 64, endLine: 72 }

async function fireRead(hooks: any, sid: string, args: unknown) {
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: sid, callID: `c-${Math.random()}` }, { args })
}

async function fireLoop(hooks: any, sid: string, cycles = 3) {
    for (let i = 0; i < cycles; i++) {
        await fireRead(hooks, sid, READ_A)
        await fireRead(hooks, sid, READ_B)
    }
}

const OPTS = { checkIntervalMs: 20, chunkTimeoutMs: 10_000, gracePeriodMs: 0, subagentWaitMs: 100_000 } as any

describe("live tool-loop interception (tool.execute.before)", () => {
    test("REGRESSION (user repro): alternating identical reads → session aborted + TOOL_LOOP_RECOVERY_PROMPT", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await fireLoop(hooks, "ses_loop1", 3) // [A,B] x3 = 6 calls, period-2 pattern
        await wait(2500) // abort + ABORT_CONTINUE_DELAY_MS + prompt

        expect(abortCalls.filter((a) => a.sid === "ses_loop1").length).toBeGreaterThanOrEqual(1)
        const loopPrompts = promptCalls.filter(
            (p) => p.sid === "ses_loop1" && p.body.includes("same tool multiple times"),
        )
        expect(loopPrompts.length).toBe(1)
    })

    test("3 identical consecutive calls (same args) → abort + recovery prompt", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS)

        for (let i = 0; i < 6; i++) await fireRead(hooks, "ses_same", READ_A)
        await wait(2500)

        expect(abortCalls.filter((a) => a.sid === "ses_same").length).toBeGreaterThanOrEqual(1)
        expect(
            promptCalls.filter((p) => p.sid === "ses_same" && p.body.includes("same tool multiple times")).length,
        ).toBe(1)
    })

    test("same tool name but distinct args → NO intervention (fingerprint is name+args)", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS)

        for (let i = 0; i < 10; i++) {
            await fireRead(hooks, "ses_distinct", { filePath: "a.rs", startLine: i * 10, endLine: i * 10 + 5 })
        }
        await wait(300)

        expect(abortCalls.filter((a) => a.sid === "ses_distinct")).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === "ses_distinct")).toHaveLength(0)
    })

    test("at most 2 interventions per busy turn, then silence", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await fireLoop(hooks, "ses_cap", 3)
        await wait(2300) // intervention 1 completes (prompt sent)

        await fireLoop(hooks, "ses_cap", 3)
        await wait(2300) // intervention 2 aborts (prompt may be skipped: continuing)

        await fireLoop(hooks, "ses_cap", 3)
        await wait(500) // no third intervention expected

        expect(abortCalls.filter((a) => a.sid === "ses_cap").length).toBe(2)
        expect(
            promptCalls.filter((p) => p.sid === "ses_cap" && p.body.includes("same tool multiple times")).length,
        ).toBeGreaterThanOrEqual(1)
    }, 12000)

    test("userCancelled → no live intervention", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS)

        await hooks.event!({
            event: { type: "session.status", sessionID: "ses_esc", properties: { status: "busy" } },
        } as any)
        await hooks.event!({
            event: { type: "session.status", sessionID: "ses_esc", properties: { status: "interrupted" } },
        } as any)

        await fireLoop(hooks, "ses_esc", 3)
        await wait(2500)

        expect(abortCalls.filter((a) => a.sid === "ses_esc")).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === "ses_esc")).toHaveLength(0)
    })
})
