import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { SUBAGENT_LOOP_RECOVERY_PROMPT } from "./recovery/shared"

type PromptCall = { sid: string; body: string }

function toolUsePart(name: string, input: Record<string, unknown>) {
    return { type: "tool_use", name, input, state: { status: "completed" } }
}

function createMockContext(messagesBySid: Record<string, Array<Record<string, unknown>>>) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async () => {}) },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (config: any) => messagesBySid[config.path.id] ?? []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
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

const CHILD = "ses_child_loop"
const PARENT = "ses_parent_loop"

async function setup(messagesBySid: Record<string, Array<Record<string, unknown>>>) {
    const { ctx, promptCalls, abortCalls } = createMockContext(messagesBySid)
    const hooks = await AutoResumePlugin(ctx, FAST as any)
    // Register the child as a subagent of PARENT, then set it busy: the
    // timer's busy-loop pass is what inspects its tool history.
    await hooks.event!({
        event: { type: "session.created", sessionID: CHILD, properties: { parentID: PARENT } },
    } as any)
    await hooks.event!({
        event: { type: "session.status", sessionID: CHILD, properties: { status: "busy" } },
    } as any)
    return { hooks, promptCalls, abortCalls }
}

describe("subagent same-command loop", () => {
    test("identical repeated commands → loop-breaker prompt with todowrite reset", async () => {
        const { promptCalls } = await setup({
            [CHILD]: [
                {
                    role: "assistant",
                    parts: [
                        toolUsePart("bash", { command: "grep -r foo src/" }),
                        toolUsePart("bash", { command: "grep -r foo src/" }),
                        toolUsePart("bash", { command: "grep -r foo src/" }),
                        toolUsePart("bash", { command: "grep -r foo src/" }),
                        toolUsePart("bash", { command: "grep -r foo src/" }),
                    ],
                },
            ],
        })

        const sent = await waitFor(() =>
            promptCalls.some((p) => p.sid === CHILD && p.body === SUBAGENT_LOOP_RECOVERY_PROMPT),
        )
        expect(sent).toBe(true)
        expect(SUBAGENT_LOOP_RECOVERY_PROMPT).toContain("todowrite")
    })

    test("two corrections already spent → the looping subagent is killed (aborted)", async () => {
        const { hooks, promptCalls, abortCalls } = await setup({
            [CHILD]: [
                {
                    role: "assistant",
                    parts: [
                        toolUsePart("bash", { command: "npm test" }),
                        toolUsePart("bash", { command: "npm test" }),
                        toolUsePart("bash", { command: "npm test" }),
                        toolUsePart("bash", { command: "npm test" }),
                        toolUsePart("bash", { command: "npm test" }),
                    ],
                },
            ],
        })

        // Budget already burned by two failed corrections: the next
        // detection must kill the child instead of prompting again.
        const sessions = (hooks as any).__sessionsForTest as Map<string, { subagentLoopAttempts: number }>
        sessions.get(CHILD)!.subagentLoopAttempts = 2

        const killed = await waitFor(() => abortCalls.some((a) => a.sid === CHILD))
        expect(killed).toBe(true)
        expect(promptCalls.filter((p) => p.sid === CHILD && p.body === SUBAGENT_LOOP_RECOVERY_PROMPT)).toHaveLength(0)
    })

    test("varied commands are not a loop (control)", async () => {
        const { promptCalls, abortCalls } = await setup({
            [CHILD]: [
                {
                    role: "assistant",
                    parts: [
                        toolUsePart("bash", { command: "ls" }),
                        toolUsePart("read", { path: "a.ts" }),
                        toolUsePart("bash", { command: "ls" }),
                        toolUsePart("grep", { pattern: "x" }),
                        toolUsePart("write", { path: "b.ts" }),
                    ],
                },
            ],
        })

        await wait(400)
        expect(promptCalls.filter((p) => p.sid === CHILD)).toHaveLength(0)
        expect(abortCalls).toHaveLength(0)
    })

    test("invalid tool calls with unparseable args count as identical (real-world loop)", async () => {
        // Mirrors a live incident: a subagent repeatedly calling edit with
        // truncated JSON ("edits: ." → JSON Parse error: Unexpected EOF),
        // rejected at input validation — never executed, so no tool hooks
        // ever fired. The args never parse into the part, degrading every
        // fingerprint to the same "edit:undefined" — which is exactly why
        // the message-based detector still catches it.
        const { promptCalls } = await setup({
            [CHILD]: [
                { role: "assistant", parts: [{ type: "tool_use", name: "edit", state: { status: "error" } }] },
                { role: "assistant", parts: [{ type: "tool_use", name: "edit", state: { status: "error" } }] },
                { role: "assistant", parts: [{ type: "tool_use", name: "edit", state: { status: "error" } }] },
                { role: "assistant", parts: [{ type: "tool_use", name: "edit", state: { status: "error" } }] },
                { role: "assistant", parts: [{ type: "tool_use", name: "edit", state: { status: "error" } }] },
            ],
        })

        const sent = await waitFor(() =>
            promptCalls.some((p) => p.sid === CHILD && p.body === SUBAGENT_LOOP_RECOVERY_PROMPT),
        )
        expect(sent).toBe(true)
    })
})
