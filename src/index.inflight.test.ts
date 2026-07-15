import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: { messages?: Record<string, Array<any>> } = {}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return opts.messages?.[config.path.id] ?? []
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
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const FAST = {
    checkIntervalMs: 20,
    chunkTimeoutMs: 50,
    gracePeriodMs: 0,
    subagentWaitMs: 100_000,
    maxRetries: 1,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    loopMaxContinues: 99,
}

async function setup(extra: Record<string, unknown> = {}) {
    const { ctx, promptCalls, abortCalls } = createMockContext()
    const hooks = await AutoResumePlugin(ctx, { ...FAST, ...extra } as any)
    return { hooks, promptCalls, abortCalls }
}

async function busy(hooks: any, sid: string) {
    await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
}

async function toolBefore(hooks: any, sid: string, callID = "c1", tool = "bash") {
    await hooks["tool.execute.before"]({ tool, sessionID: sid, callID }, { args: {} })
}

async function toolAfter(hooks: any, sid: string, callID = "c1", tool = "bash") {
    await hooks["tool.execute.after"]({ tool, sessionID: sid, callID, args: {} }, { title: "", output: "", metadata: {} })
}

async function cmdBefore(hooks: any, sid: string) {
    await hooks["command.execute.before"]({ command: "sleep", sessionID: sid, arguments: "10" }, { parts: [] })
}

async function cmdExecuted(hooks: any, sid: string) {
    await hooks.event({ event: { type: "command.executed", sessionID: sid, properties: { sessionID: sid } } })
}

describe("deterministic in-flight tool tracking", () => {
    test("long-running tool call is not aborted past the stall threshold", async () => {
        const { hooks, abortCalls, promptCalls } = await setup()
        const sid = "ses_long_tool"
        await busy(hooks, sid)
        await toolBefore(hooks, sid)
        await wait(250)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === sid)).toHaveLength(0)
    })

    test("stall recovery fires after the tool finishes", async () => {
        const { hooks, promptCalls, abortCalls } = await setup()
        const sid = "ses_long_tool_release"
        await busy(hooks, sid)
        await toolBefore(hooks, sid)
        await wait(150)
        await toolAfter(hooks, sid)
        await wait(250)
        // chunk-timeout path sends a continue prompt (no abort) once the guard releases
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
    })

    test("subagent delegation (task tool in-flight) protects the parent", async () => {
        const { hooks, abortCalls, promptCalls } = await setup()
        const parent = "ses_parent_delegation"
        await busy(hooks, parent)
        await toolBefore(hooks, parent, "t1", "task")
        await wait(250)
        expect(abortCalls.filter((a) => a.sid === parent)).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === parent)).toHaveLength(0)
        await toolAfter(hooks, parent, "t1", "task")
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === parent).length).toBeGreaterThanOrEqual(1)
    })

    test("command in-flight is not aborted; command.executed releases it", async () => {
        const { hooks, abortCalls, promptCalls } = await setup()
        const sid = "ses_long_cmd"
        await busy(hooks, sid)
        await cmdBefore(hooks, sid)
        await wait(250)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === sid)).toHaveLength(0)
        await cmdExecuted(hooks, sid)
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })

    test("command.executed for one session does not wipe another session's in-flight guard", async () => {
        const { hooks, abortCalls } = await setup()
        const a = "ses_a"
        const b = "ses_b"
        await busy(hooks, a)
        await toolBefore(hooks, a, "ca")
        await busy(hooks, b)
        await wait(150)
        await cmdExecuted(hooks, b)
        await wait(250)
        // A's tool is still in-flight → A must NOT have been aborted
        expect(abortCalls.filter((x) => x.sid === a)).toHaveLength(0)
    })

    test("counters reset on idle → stall recovery fires on next busy cycle", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_idle_reset"
        await busy(hooks, sid)
        await toolBefore(hooks, sid)
        await wait(120)
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
        await busy(hooks, sid)
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })

    test("counters reset on session.error (non-abort) → recovery fires on next busy cycle", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_err_reset"
        await busy(hooks, sid)
        await toolBefore(hooks, sid)
        await wait(120)
        await hooks.event({
            event: { type: "session.error", sessionID: sid, properties: { error: { name: "TimeoutError" } } },
        })
        await busy(hooks, sid)
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })

    test("counters reset on session.created (reused id) → recovery fires on next busy cycle", async () => {
        const { hooks, promptCalls } = await setup()
        const sid = "ses_created_reset"
        await busy(hooks, sid)
        await toolBefore(hooks, sid)
        await wait(120)
        await hooks.event({ event: { type: "session.created", sessionID: sid } })
        await busy(hooks, sid)
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })

    test("callID undefined is safe and the counter still guards", async () => {
        const { hooks, abortCalls, promptCalls } = await setup()
        const sid = "ses_noid"
        await busy(hooks, sid)
        await hooks["tool.execute.before"]({ tool: "bash", sessionID: sid, callID: "" as any }, { args: {} })
        await wait(200)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        await hooks["tool.execute.after"]({ tool: "bash", sessionID: sid, callID: "" as any, args: {} }, { title: "", output: "", metadata: {} })
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })

    test("concurrent tool calls: abort stays suppressed until the last one finishes", async () => {
        const { hooks, abortCalls, promptCalls } = await setup()
        const sid = "ses_concurrent"
        await busy(hooks, sid)
        await toolBefore(hooks, sid, "c1")
        await toolBefore(hooks, sid, "c2")
        await wait(200)
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        await toolAfter(hooks, sid, "c1")
        await wait(200)
        // one tool still running → still suppressed
        expect(abortCalls.filter((a) => a.sid === sid)).toHaveLength(0)
        expect(promptCalls.filter((p) => p.sid === sid)).toHaveLength(0)
        await toolAfter(hooks, sid, "c2")
        await wait(250)
        expect(promptCalls.filter((p) => p.sid === sid).length).toBeGreaterThanOrEqual(1)
    })
})