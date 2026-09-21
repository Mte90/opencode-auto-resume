import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" },
]

const CLOSED_TODOS = [
    { id: "t1", content: "task one", status: "completed", priority: "high" },
    { id: "t2", content: "task two", status: "completed", priority: "high" },
]

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status },
        },
    }
}

function makeTodoUpdatedEvent(sid: string, todos: any[]) {
    return {
        event: {
            type: "todo.updated",
            sessionID: sid,
            properties: { todos },
        },
    }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

function createContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
    todosFromApi?: Record<string, any[]>
}) {
    const promptCalls: PromptCall[] = []
    const statusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) statusMap[s.id] = { type: s.status }
    const todosFromApi = opts.todosFromApi ?? {}

    const ctx = {
        client: {
            app: {
                log: mock(async (_o: { body: { level: string; message: string } }) => {}),
            },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map(s => ({
                        id: s.id,
                        projectID: "proj-1",
                        directory: "/test",
                        title: s.id,
                        version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() },
                    })),
                })),
                status: mock(async () => ({ data: statusMap })),
                todo: mock(async (config: { path: { id: string } }) => ({
                    data: todosFromApi[config.path.id] ?? [],
                })),
                messages: mock(async (config: { path: { id: string } }) => ({
                    data: opts.messages[config.path.id] ?? [],
                })),
                prompt: mock(async (config: {
                    path: { id: string }
                    body: { parts: Array<{ type: string; text: string }> }
                }) => {
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map(p => p.text).join(""),
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

describe("Lazy todo fetch — idle path fetches todos on-demand when w.todos is empty", () => {
    test("no todo.updated event, API returns open todos → idle path sends reminder", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy1", status: "busy" }],
            messages: {
                ses_lazy1: [
                    { role: "user", parts: [{ type: "text", text: "do the work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working on it" }] },
                ],
            },
            todosFromApi: { ses_lazy1: OPEN_TODOS },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        // No todo.updated event — w.todos stays empty until the idle path fetches
        await hooks.event!(makeStatusEvent("ses_lazy1", "idle") as any)
        await wait(500)

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        expect(promptCalls[0].sid).toBe("ses_lazy1")
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("no todo.updated event, API returns empty → no reminder sent", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy2", status: "busy" }],
            messages: {
                ses_lazy2: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
            todosFromApi: { ses_lazy2: [] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        await hooks.event!(makeStatusEvent("ses_lazy2", "idle") as any)
        await wait(500)

        expect(promptCalls.length).toBe(0)
    })

    test("no todo.updated event, API returns closed todos → no reminder sent", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy3", status: "busy" }],
            messages: {
                ses_lazy3: [
                    { role: "assistant", parts: [{ type: "text", text: "all done" }] },
                ],
            },
            todosFromApi: { ses_lazy3: CLOSED_TODOS },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        await hooks.event!(makeStatusEvent("ses_lazy3", "idle") as any)
        await wait(500)

        expect(promptCalls.length).toBe(0)
    })

    test("todo.updated already received → no duplicate fetch needed, reminder fires", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy4", status: "busy" }],
            messages: {
                ses_lazy4: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
            todosFromApi: {},
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        await hooks.event!(makeTodoUpdatedEvent("ses_lazy4", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_lazy4", "idle") as any)
        await wait(500)

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("🎉 with empty w.todos but API has open todos → completion NOT latched", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy5", status: "busy" }],
            messages: {
                ses_lazy5: [
                    { role: "assistant", parts: [{ type: "text", text: "done 🎉" }] },
                ],
            },
            todosFromApi: { ses_lazy5: OPEN_TODOS },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        // No todo.updated — w.todos is empty, so 🎉 would normally latch completion.
        // With the fix, the idle path fetches todos first and sees open todos.
        await hooks.event!(makeStatusEvent("ses_lazy5", "idle") as any)
        await wait(500)

        // A reminder should be sent because there are open todos.
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("fetch error → no crash, no reminder", async () => {
        const { ctx, promptCalls } = createContext({
            sessions: [{ id: "ses_lazy6", status: "busy" }],
            messages: {
                ses_lazy6: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] },
                ],
            },
        })
        // Override todo to throw
        ;(ctx.client.session as any).todo = mock(async () => { throw new Error("API down") })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, toolTextCheckDelayMs: 50 })

        await hooks.event!(makeStatusEvent("ses_lazy6", "idle") as any)
        await wait(500)

        // No crash, no reminder (empty todos + fetch failed)
        expect(promptCalls.length).toBe(0)
    })
})
