import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
    todos?: Record<string, Array<any>>
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
                // NOTE: list responses intentionally omit `status` — the real
                // SDK never includes it there (status lives on the separate
                // session.status endpoint). Discovery must not rely on it.
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
                todo: mock(async (config: { path: { id: string } }) => ({
                    data: opts.todos?.[config.path.id] ?? []
                })),
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
function makeUserMessageEvent(sid: string, text: string) {
    return { event: { type: "message.updated", sessionID: sid, properties: { info: { role: "user" }, parts: [{ type: "text", text }] } } }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("idle-nudge gate coverage", () => {
    test("discovery: plugin attached to already-idle session with open todos → periodic nudge fires without any events", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_restarted", status: "idle" }],
            messages: {
                ses_restarted: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            },
            todos: { ses_restarted: OPEN_TODOS }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 20,
            discoveryDelayMs: 20,
            maxRetries: 3,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0,
            activeUserWindowMs: 0
        })

        // No events fired at all — discovery + periodic recheck must be enough.
        await wait(250)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        for (const call of promptCalls) {
            expect(call.body).toContain("unfinished task")
        }

        // Cap discipline: discovery-driven nudges also respect maxRetries.
        await wait(300)
        expect(promptCalls.length).toBeLessThanOrEqual(3)
    })

    test("re-arm contract: user message alone does NOT reset the todo-nudge budget; a busy work cycle does", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_rearm", status: "idle" }],
            messages: {
                ses_rearm: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 10_000_000,
            maxRetries: 1,
            loopMaxContinues: 10,
            minActivityGapMs: 0,
            toolTextCheckDelayMs: 10,
            warmupMs: 0,
            activeUserWindowMs: 0
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_rearm", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_rearm", "idle") as any)
        await wait(100)
        expect(promptCalls.length).toBe(1)

        // User message WITHOUT a busy/command work cycle: budget must stay
        // exhausted (deliberate asymmetry vs doneClaimNoTodosAttempts).
        await hooks.event!(makeUserMessageEvent("ses_rearm", "hmm ok") as any)
        await hooks.event!(makeStatusEvent("ses_rearm", "idle") as any)
        await wait(150)
        expect(promptCalls.length).toBe(1)

        // Genuine busy→idle work cycle: resetBusyFlags re-arms the budget.
        await hooks.event!(makeStatusEvent("ses_rearm", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_rearm", "idle") as any)
        await wait(150)
        expect(promptCalls.length).toBe(2)
    })

    test("minActivityGapMs suppresses the armed check right after a busy→idle transition", async () => {
        const setup = async (minActivityGapMs: number) => {
            const { ctx, promptCalls } = createMockContext({
                sessions: [{ id: "ses_gap", status: "idle" }],
                messages: {
                    ses_gap: [
                        { role: "user", parts: [{ type: "text", text: "do work" }] },
                        { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                    ]
                }
            })
            const hooks = await AutoResumePlugin(ctx, {
                enabled: true,
                baseBackoffMs: 1,
                checkIntervalMs: 10_000_000,
                maxRetries: 3,
                loopMaxContinues: 10,
                minActivityGapMs,
                toolTextCheckDelayMs: 10,
                warmupMs: 0,
                activeUserWindowMs: 0
            })
            return { hooks, promptCalls }
        }

        // Gap 0: immediate nudge (1) + armed check at 10ms (2) both fire.
        const { hooks: hooksA, promptCalls: callsA } = await setup(0)
        await hooksA.event!(makeTodoUpdatedEvent("ses_gap", OPEN_TODOS) as any)
        await hooksA.event!(makeStatusEvent("ses_gap", "idle") as any)
        await wait(150)
        expect(callsA.length).toBe(2)

        // Gap 5000: armed check at ~10ms after the idle event is inside the
        // activity gap → suppressed, only the immediate nudge went out.
        const { hooks: hooksB, promptCalls: callsB } = await setup(5000)
        await hooksB.event!(makeTodoUpdatedEvent("ses_gap", OPEN_TODOS) as any)
        await hooksB.event!(makeStatusEvent("ses_gap", "idle") as any)
        await wait(150)
        expect(callsB.length).toBe(1)
    })
})
