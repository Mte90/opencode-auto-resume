import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<any>>
}) {
    const promptCalls: PromptCall[] = []
    const statusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) statusMap[s.id] = { type: s.status }
    const ctx = {
        client: {
            app: { log: mock(async () => {}) },
            session: {
                list: mock(async () => ({
                    data: opts.sessions.map(s => ({
                        id: s.id, projectID: "proj-1", directory: "/test", title: s.id, version: "1.0.0",
                        time: { created: Date.now(), updated: Date.now() }
                    }))
                })),
                status: mock(async () => ({ data: statusMap })),
                todo: mock(async () => ({ data: OPEN_TODOS })),
                messages: mock(async (config: { path: { id: string } }) => ({ data: opts.messages[config.path.id] ?? [] })),
                prompt: mock(async (config: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => {
                    promptCalls.push({ sid: config.path.id, body: config.body.parts.map(p => p.text).join("") })
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
    { id: "t1", content: "pick the storage backend", status: "pending", priority: "high" },
    { id: "t2", content: "migrate the schema", status: "pending", priority: "high" }
]
const STOP = ["STOP:\\s*(BLOCKED|NEEDS_DECISION)\\b"]
const OPTIONS = {
    enabled: true, baseBackoffMs: 1, checkIntervalMs: 10_000_000, maxRetries: 3, loopMaxContinues: 10,
    minActivityGapMs: 0, toolTextCheckDelayMs: 10, warmupMs: 0, activeUserWindowMs: 0
}
const event = (type: string, sid: string, properties: Record<string, unknown>) => ({ event: { type, sessionID: sid, properties } })
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("stopPatterns", () => {
    async function nudgesAfterIdle(lastText: string, stopPatterns?: string[], partType = "text") {
        const sid = "ses_stop"
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: sid, status: "idle" }],
            messages: { [sid]: [
                { role: "user", parts: [{ type: "text", text: "set up the storage layer" }] },
                { role: "assistant", parts: [{ type: partType, text: lastText }] }
            ] }
        })
        const hooks = await AutoResumePlugin(ctx, stopPatterns ? { ...OPTIONS, stopPatterns } : OPTIONS)
        await hooks.event!(event("todo.updated", sid, { todos: OPEN_TODOS }) as any)
        await hooks.event!(event("session.status", sid, { status: "idle" }) as any)
        await wait(150)
        return promptCalls.length
    }

    test("a turn ending in a stop line with open todos is not nudged", async () => {
        expect(await nudgesAfterIdle("Two options.\nSTOP: NEEDS_DECISION Postgres or SQLite?", STOP)).toBe(0)
    })

    test("without stopPatterns the same turn is nudged (unchanged default)", async () => {
        expect(await nudgesAfterIdle("Two options.\nSTOP: NEEDS_DECISION Postgres or SQLite?")).toBeGreaterThanOrEqual(1)
    })

    test("a silent turn end is still nudged with stopPatterns set", async () => {
        expect(await nudgesAfterIdle("Schema drafted.", STOP)).toBeGreaterThanOrEqual(1)
    })

    test("only visible text counts: a stop line in reasoning does not hold back the nudge", async () => {
        expect(await nudgesAfterIdle("maybe STOP: BLOCKED here", STOP, "reasoning")).toBeGreaterThanOrEqual(1)
    })

    test("an invalid pattern is skipped instead of breaking the plugin", async () => {
        expect(await nudgesAfterIdle("Two options.\nSTOP: NEEDS_DECISION Postgres or SQLite?", ["(", ...STOP])).toBe(0)
    })
})
