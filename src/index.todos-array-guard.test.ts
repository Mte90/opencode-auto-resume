import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions?: Array<{ id: string; status: string }>
    messages?: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
} = {}) {
    const promptCalls: PromptCall[] = []
    const sessions = opts.sessions ?? []
    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of sessions) defaultStatusMap[s.id] = { type: s.status }
    const statusMap = opts.statusMap ?? defaultStatusMap
    const messages = opts.messages ?? {}
const ctx = {

        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => ({
                    data: sessions.map((s) => ({
                        id: s.id,
                        projectID: "proj-1",
                        directory: "/test",
                        title: s.id,
                        version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() },
                    })),
                })),
                status: mock(async () => ({ data: statusMap })),
                messages: mock(async (config: { path: { id: string } }) => messages[config.path.id] ?? []),
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OPTS = { enabled: true, baseBackoffMs: 1, checkIntervalMs: 99999 }

describe("REGRESSION: todo.updated with non-array todos must not crash the plugin", () => {
    test("REGRESSION CONTRACT: todo.updated handler must coerce non-array todos via Array.isArray", () => {
        expect(
            SOURCE,
            "todo.updated handler must validate Array.isArray before .map() — this is the crash root cause from v1.1.4+",
        ).toMatch(/Array\.isArray\(rawTodos\)/)
    })

    test("REGRESSION CONTRACT: getOpenTodos must guard against non-array input", () => {
        const m = SOURCE.match(/function getOpenTodos[\s\S]*?\n\}/)
        expect(m, "getOpenTodos function not found").not.toBeNull()
        expect(m![0]).toContain("Array.isArray")
    })

    test("REGRESSION CONTRACT: buildOpenTodosReminder must guard against non-array input", () => {
        const m = SOURCE.match(/function buildOpenTodosReminder[\s\S]*?\n\}/)
        expect(m, "buildOpenTodosReminder function not found").not.toBeNull()
        expect(m![0]).toContain("Array.isArray")
    })
    test("todo.updated with properties = {} (missing todos field) does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t1", properties: {} },
        } as any)
        await wait(50)
    })

    test("todo.updated with properties.todos = null does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t2", properties: { todos: null } },
        } as any)
        await wait(50)
    })

    test("todo.updated with properties.todos = undefined does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t3", properties: { todos: undefined } },
        } as any)
        await wait(50)
    })

    test("todo.updated with properties.todos = {} (object, not array) does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t4", properties: { todos: { a: 1 } } },
        } as any)
        await wait(50)
    })

    test("todo.updated with properties.todos = string does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t5", properties: { todos: "not-an-array" } },
        } as any)
        await wait(50)
    })

    test("todo.updated with properties.todos = number does not throw", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_t6", properties: { todos: 42 } },
        } as any)
        await wait(50)
    })

    test("REGRESSION CHECK: bad todos do not poison later idle handler (buildOpenTodosReminder)", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_recur", status: "idle" }],
            statusMap: { ses_recur: { type: "idle" } },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: { type: "todo.updated", sessionID: "ses_recur", properties: { todos: { poison: true } } },
        } as any)

        let threw = false
        const onUnhandled = () => { threw = true }
        process.on("unhandledRejection", onUnhandled)
        try {
            await hooks.event!({
                event: { type: "session.status", sessionID: "ses_recur", properties: { status: "idle" } },
            } as any)
            await wait(200)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
        expect(threw).toBe(false)
    })

    test("REGRESSION CHECK: valid array todos still work correctly after guard", async () => {
        const { ctx } = createMockContext()
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_valid",
                properties: {
                    todos: [
                        { content: "task A", status: "pending", priority: "high" },
                        { content: "task B", status: "completed", priority: "low" },
                    ],
                },
            },
        } as any)
        await wait(50)
    })
})
