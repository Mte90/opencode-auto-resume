import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
}) {
    const promptCalls: PromptCall[] = []
    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) defaultStatusMap[s.id] = { type: s.status }
    const statusMap = opts.statusMap ?? defaultStatusMap

    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => ({ data: opts.sessions.map(s => ({
                    id: s.id, projectID: "proj-1", directory: "/test",
                    title: s.id, version: "1.0.0",
                    time: { created: Date.now(), updated: Date.now() }
                })) })),
                status: mock(async () => ({ data: statusMap })),
                todo: mock(async () => ({ data: [] })),
                messages: mock(async (config: { path: { id: string } }) => opts.messages[config.path.id] ?? []),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const BASE_OPTS = { enabled: true, baseBackoffMs: 1, maxRetries: 3, toolTextCheckDelayMs: 1, minActivityGapMs: 0 }

async function runDoneClaimWith(opts: {
    sid: string
    assistantText: string
    pluginOptions?: Record<string, unknown>
}) {
    const { ctx, promptCalls } = createMockContext({
        sessions: [{ id: opts.sid, status: "busy" }],
        messages: {
            [opts.sid]: [
                { id: "m1", role: "user", parts: [{ type: "text", text: "do the thing" }] },
                { id: "m2", role: "assistant", parts: [{ type: "text", text: opts.assistantText }] },
            ],
        },
    })
    const hooks = await AutoResumePlugin(ctx, { ...BASE_OPTS, ...(opts.pluginOptions ?? {}) } as any)

    await hooks.event!({
        event: { type: "todo.updated", sessionID: opts.sid, properties: { todos: [] } } as any,
    })
    await hooks.event!({ event: { type: "session.status", sessionID: opts.sid, properties: { status: "idle" } } as any })
    await wait(100)
    return promptCalls
}

describe("Configurable done-claim patterns", () => {
    test("custom doneClaimPatterns overrides default — custom pattern triggers details prompt", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg1",
            assistantText: "my-task-is-finished.",
            pluginOptions: { doneClaimPatterns: ["my-task-is-finished"] },
        })

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        const last = promptCalls[promptCalls.length - 1].body
        expect(last).toContain("verify")
    })

    test("default pattern NOT matched when custom doneClaimPatterns provided", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg2",
            assistantText: "Task completed.",
            pluginOptions: { doneClaimPatterns: ["my-task-is-finished"] },
        })

        expect(promptCalls.length).toBe(0)
    })

    test("invalid regex in doneClaimPatterns is skipped, valid ones still work", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg3",
            assistantText: "task finished.",
            pluginOptions: { doneClaimPatterns: ["[invalid", "task finished"] },
        })

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        expect(promptCalls[promptCalls.length - 1].body).toContain("verify")
    })

    test("empty doneClaimPatterns array falls back to defaults", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg4",
            assistantText: "Task completed.",
            pluginOptions: { doneClaimPatterns: [] },
        })

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        expect(promptCalls[promptCalls.length - 1].body).toContain("verify")
    })
})

describe("Configurable ready-to-continue patterns", () => {
    test("custom readyToContinuePatterns overrides default", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg5",
            assistantText: "let's keep going with the next step",
            pluginOptions: { readyToContinuePatterns: ["let's keep going"] },
        })

        // Custom pattern matches → ready-to-continue path fires, no done-claim
        // → bare continue prompt (no work description skip since text is short)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    })

    test("default ready-to-continue pattern NOT matched when custom provided", async () => {
        const promptCalls = await runDoneClaimWith({
            sid: "ses_cfg6",
            assistantText: "ready to continue with task",
            pluginOptions: { readyToContinuePatterns: ["let's keep going"] },
        })

        // Default pattern not matched → no ready-to-continue, no done-claim → no prompt
        expect(promptCalls.length).toBe(0)
    })
})
