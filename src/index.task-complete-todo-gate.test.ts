import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { buildOpenTodosReminder, TASK_COMPLETE_ACK } from "./recovery/shared"
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
const OPTS = { enabled: true, baseBackoffMs: 1, checkIntervalMs: 99999, maxRetries: 3 }

describe("task_complete: open-todo gate and re-arm", () => {
    test("CONTRACT: task_completeOverrides must reset on genuine new user message", () => {
        // The message.updated handler must reset taskCompleteOverrides alongside
        // other per-episode budgets like doneClaimNoTodosAttempts.
        const msgUpdated = SOURCE.indexOf('case "message.updated"')
        expect(msgUpdated).toBeGreaterThan(-1)
        const msgBlock = SOURCE.slice(msgUpdated, msgUpdated + 2000)
        // Must reset taskCompleteOverrides in the genuine new work cycle block
        expect(msgBlock).toMatch(/taskCompleteOverrides\s*=\s*0/)
    })

    test("task_complete with open todos is blocked up to maxRetries, then accepts", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_gate", status: "busy" }],
            statusMap: { ses_gate: { type: "busy" } },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        // Register 2 open todos so the watch has something to check
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_gate",
                properties: {
                    todos: [
                        { id: "t1", content: "Implement feature A", status: "pending", priority: "high" },
                        { id: "t2", content: "Write tests", status: "in_progress", priority: "medium" },
                    ],
                },
            },
        } as any)
        await wait(50)

        const tool = hooks.tool!.task_complete
        const toolCtx = { sessionID: "ses_gate" } as any

        // Call 1: should be blocked (override 1/3)
        const r1 = await tool.execute({}, toolCtx)
        expect(typeof r1).toBe("string")
        expect(r1).toContain("unfinished task")
        expect(r1).toContain("Implement feature A")

        // Call 2: should be blocked (override 2/3)
        const r2 = await tool.execute({}, toolCtx)
        expect(typeof r2).toBe("string")
        expect(r2).toContain("unfinished task")

        // Call 3: should be blocked (override 3/3)
        const r3 = await tool.execute({}, toolCtx)
        expect(typeof r3).toBe("string")
        expect(r3).toContain("unfinished task")

        // Call 4: budget exhausted, should accept (return ACK)
        const r4 = await tool.execute({}, toolCtx)
        expect(r4).toBe(TASK_COMPLETE_ACK)
    })

    test("genuine new user message re-arms the task_completeOverrides budget", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_rearm", status: "busy" }],
            statusMap: { ses_rearm: { type: "busy" } },
        })
        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        // Register 2 open todos
        await hooks.event!({
            event: {
                type: "todo.updated",
                sessionID: "ses_rearm",
                properties: {
                    todos: [
                        { id: "t1", content: "Task one", status: "pending", priority: "high" },
                        { id: "t2", content: "Task two", status: "in_progress", priority: "medium" },
                    ],
                },
            },
        } as any)
        await wait(50)

        const tool = hooks.tool!.task_complete
        const toolCtx = { sessionID: "ses_rearm" } as any

        // Exhaust the budget: 3 blocks + 1 accept = 4 calls
        for (let i = 0; i < 3; i++) {
            const r = await tool.execute({}, toolCtx)
            expect(typeof r).toBe("string")
            expect(r).toContain("unfinished task")
        }
        const accepted = await tool.execute({}, toolCtx)
        expect(accepted).toBe(TASK_COMPLETE_ACK)

        // Fire a genuine new user message (not an own-prompt shape)
        await hooks.event!({
            event: {
                type: "message.updated",
                sessionID: "ses_rearm",
                properties: {
                    role: "user",
                    text: "please keep going",
                },
            },
        } as any)
        await wait(50)

        // Now the budget should be re-armed: calling task_complete with open todos
        // must be BLOCKED again (return the reminder, not the ACK)
        const rAfterRearm = await tool.execute({}, toolCtx)
        expect(typeof rAfterRearm).toBe("string")
        expect(rAfterRearm).toContain("unfinished task")
        expect(rAfterRearm).not.toBe(TASK_COMPLETE_ACK)
    })

    test("buildOpenTodosReminder guards against non-array todos", () => {
        expect(buildOpenTodosReminder(undefined as any)).toBe("continue")
        expect(buildOpenTodosReminder({} as any)).toBe("continue")
        expect(buildOpenTodosReminder([])).toBe("continue")
    })
})
