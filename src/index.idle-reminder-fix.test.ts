import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
}) {
    const promptCalls: PromptCall[] = []
    const statusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        statusMap[s.id] = { type: s.status }
    }

    const ctx = {
        client: {
            app: {
                log: mock(async (_o: { body: { level: string; message: string } }) => {})
            },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map(s => ({
                        id: s.id,
                        projectID: "proj-1",
                        directory: "/test",
                        title: s.id,
                        version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() }
                    }))
                })),
                status: mock(async () => ({ data: statusMap })),
                todo: mock(async () => ({ data: [] })),
                messages: mock(async (config: { path: { id: string } }) => {
                    return { data: opts.messages[config.path.id] ?? [] }
                }),
                prompt: mock(async (config: {
                    path: { id: string }
                    body: { parts: Array<{ type: string; text: string }> }
                }) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map(p => p.text).join("")
                    })
                    return {}
                }),
                abort: mock(async () => ({}))
            }
        },
        ui: { toast: mock(async () => {}) }
    } as any

    return { ctx, promptCalls }
}

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" }
]

function makeStatusEvent(sid: string, status: string) {
    return { event: { type: "session.status", sessionID: sid, properties: { status } } }
}
function makeTodoUpdatedEvent(sid: string, todos: any[]) {
    return { event: { type: "todo.updated", sessionID: sid, properties: { todos } } }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("idle-reminder counter fix — todoNudgeAttempts incremented only after successful send", () => {
    test("maxRetries=3 produces exactly 3 nudges (was 2 with double-increment bug)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_nudge3", status: "idle" }],
            messages: {
                ses_nudge3: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 3,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_nudge3", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_nudge3", "idle") as any)

        await wait(20)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)

        await wait(600)
        expect(promptCalls.length).toBe(3)

        await wait(300)
        expect(promptCalls.length).toBe(3)

        for (const call of promptCalls) {
            expect(call.body).toContain("unfinished task")
        }
    })

    test("maxRetries=1 produces exactly 1 nudge (no pre-increment before guards)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_nudge1", status: "idle" }],
            messages: {
                ses_nudge1: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 1,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_nudge1", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_nudge1", "idle") as any)

        await wait(20)
        expect(promptCalls.length).toBe(1)

        await wait(400)
        expect(promptCalls.length).toBe(1)
    })

    test("failed send does not burn a retry (counter increments only on successful send)", async () => {
        let promptCallCount = 0
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_gap", status: "idle" }],
            messages: {
                ses_gap: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        // First send attempt fails through BOTH the initial call and the
        // internal one-shot retry (calls 1-2); later sends succeed.
        ctx.client.session.prompt = mock(async (config: {
            path: { id: string }
            body: { parts: Array<{ type: string; text: string }> }
        }) => {
            promptCallCount++
            if (promptCallCount <= 2) throw new Error("server down")
            promptCalls.push({
                sid: config.path.id,
                body: config.body.parts.map(p => p.text).join("")
            })
            return {}
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 1,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_gap", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_gap", "idle") as any)

        // Immediate idle-path nudge fails (calls 1-2 incl. internal retry) →
        // must NOT burn the retry. The armed checkForToolCallAsText (10ms)
        // then succeeds (call 3).
        await wait(100)
        expect(promptCalls.length).toBe(1)

        // Cap (maxRetries=1) holds — no further nudges.
        await wait(400)
        expect(promptCalls.length).toBe(1)
    })
})
