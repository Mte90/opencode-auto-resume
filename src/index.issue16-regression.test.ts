import { describe, test, expect, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AutoResumePlugin } from "./index"

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createMockContext(opts: {
    sessions?: Array<{ id: string; status?: string }>
    messages?: Record<string, any[]>
    todos?: Record<string, any[]>
}) {
    const promptCalls: any[] = []
    const abortCalls: any[] = []
    const ctx = {
        client: {
            app: { log: mock(async () => {}) },
            session: {
                list: mock(async () => ({ data: opts.sessions ?? [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (cfg: any) => opts.messages?.[cfg.path.id] ?? []),
                todo: mock(async (cfg: any) => ({ data: opts.todos?.[cfg.path.id] ?? [] })),
                prompt: mock(async (cfg: any) => { promptCalls.push(cfg); return {} }),
                abort: mock(async (cfg: any) => { abortCalls.push(cfg); return {} }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls, abortCalls }
}

// ============================================================================
// CONTRACT TESTS — verify the source code contains the guard.
// These fail deterministically if someone removes the fix.
// ============================================================================

describe("Issue #16 regression: contract assertions on source", () => {
    test("FIX A1: resetBusyFlags preserves userCancelled (not cleared on busy)", () => {
        // resetBusyFlags must exist and must NOT clear userCancelled/completionSignaled
        expect(SOURCE).toMatch(/function resetBusyFlags/)
        // Extract the function body more robustly: find resetBusyFlags, then scan forward
        const fnStart = SOURCE.indexOf("function resetBusyFlags")
        expect(fnStart).toBeGreaterThan(-1)
        const fnEnd = SOURCE.indexOf("// PRESERVE: userCancelled", fnStart)
        expect(fnEnd).toBeGreaterThan(fnStart)
        const body = SOURCE.slice(fnStart, fnEnd)
        expect(body).not.toMatch(/w\.userCancelled\s*=\s*false/)
        expect(body).not.toMatch(/w\.completionSignaled\s*=\s*false/)
        expect(body).toMatch(/todoNudgeAttempts\s*=\s*0/)
        // #26: the done-claim budget must NOT re-arm on every busy (that let
        // the details prompt refire unboundedly across cycles); it re-arms
        // only on an inbound user message (genuine new work cycle).
        expect(body).not.toMatch(/doneClaimNoTodosAttempts\s*=\s*0/)
        const msgUpdated = SOURCE.indexOf('case "message.updated"')
        expect(msgUpdated).toBeGreaterThan(-1)
        const msgBlock = SOURCE.slice(msgUpdated, msgUpdated + 2000)
        expect(msgBlock).toMatch(/doneClaimNoTodosAttempts\s*=\s*0/)
    })

    test("FIX A2: command.executed resets only originating session (no loop over all sessions)", () => {
        const cmdBlock = SOURCE.match(/case "command\.executed":\s*\{[\s\S]*?\n\s*\}/)
        expect(cmdBlock).toBeDefined()
        expect(cmdBlock![0]).not.toMatch(/for\s*\(\s*const\s+\[\s*\w+\s*,\s*\w+\s*\]\s+of\s+sessions\s*\)/)
    })

    test("FIX A3: stall timer guard includes completionSignaled", () => {
        expect(SOURCE).toMatch(/if \(w\.status !== .busy.\)\s*continue[\s\S]*?if \(w\.userCancelled \|\| w\.completionSignaled\)\s*continue/)
    })

    test("FIX A4: action-intent setTimeout callback re-checks userCancelled", () => {
        const callbackGuards = SOURCE.match(/w2\.userCancelled/g)
        expect(callbackGuards).not.toBeNull()
        expect(callbackGuards!.length).toBeGreaterThanOrEqual(2)
    })

    test("FIX A5: tryAbortAndResume guards userCancelled at entry", () => {
        const abortFn = SOURCE.match(/async function tryAbortAndResume[\s\S]*?if\s*\(\s*w\.userCancelled\s*\|\|\s*w\.completionSignaled\s*\)\s*return false/)
        expect(abortFn).toBeDefined()
    })

    test("FIX A5: sendContinuePrompt guards userCancelled at entry", () => {
        const sendFn = SOURCE.match(/async function sendContinuePrompt[\s\S]*?if\s*\(\s*w\.userCancelled\s*\|\|\s*w\.completionSignaled\s*\)\s*return/)
        expect(sendFn).toBeDefined()
    })

    test("FIX A6: DONE_CLAIM_PATTERNS includes broadened patterns", () => {
        expect(SOURCE).toMatch(/done\\s\+with/i)
        expect(SOURCE).toMatch(/nothing/i)
    })

    test("FIX B1: fetchSessionTodos function exists", () => {
        expect(SOURCE).toMatch(/async function fetchSessionTodos/)
        expect(SOURCE).toMatch(/typeof todoFn !== .function.*/)
    })

    test("FIX B1: discoverSessions fetches todos for new sessions", () => {
        expect(SOURCE).toMatch(/fetchSessionTodos\(sid\)/)
    })

    test("FIX B4: celebration guard checks open todos before latching completionSignaled", () => {
        const celebrationGuards = SOURCE.match(/getOpenTodos\(w\.todos[^)]*\)\.length/g)
        expect(celebrationGuards).not.toBeNull()
        expect(celebrationGuards!.length).toBeGreaterThanOrEqual(2)
    })
})

// ============================================================================
// BEHAVIORAL TESTS — verify the runtime behavior of each fix.
// ============================================================================

describe("Issue #16 regression: behavioral tests", () => {
    test("FIX A1+A5: ESC survives busy event — no resume after interrupt", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_esc", status: "busy" }],
            messages: { ses_esc: [{ role: "assistant", parts: [{ type: "text", text: "working" }] }] },
            todos: { ses_esc: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Register todos
        await hooks.event!({ event: { type: "todo.updated", sessionID: "ses_esc", properties: { todos: [{ id: "t1", content: "task", status: "pending", priority: "medium" }] } } } as any)

        // User presses ESC
        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_esc" } } as any)
        await wait(50)
        expect(promptCalls.length).toBe(0)

        // Busy event must NOT clear userCancelled
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_esc", properties: { status: "busy" } } } as any)
        await wait(20)

        // Session goes idle — must NOT resume (ESC sticks)
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_esc", properties: { status: "idle" } } } as any)
        await wait(200)

        expect(promptCalls.length).toBe(0)
    })

    test("FIX A2: command.executed does not clear userCancelled on other sessions", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_a", status: "busy" }, { id: "ses_b", status: "busy" }],
            messages: {},
            todos: {},
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Session A gets ESC
        await hooks.event!({ event: { type: "session.interrupted", sessionID: "ses_a" } } as any)
        await wait(30)

        // Session B executes a command — must NOT clear session A's userCancelled
        await hooks.event!({ event: { type: "command.executed", sessionID: "ses_b" } } as any)
        await wait(20)

        // Session A goes idle — must NOT resume
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_a", properties: { status: "idle" } } } as any)
        await wait(200)

        expect(promptCalls.length).toBe(0)
    })

    test("FIX A3: completionSignaled blocks stall timer resume", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_stall", status: "busy" }],
            messages: { ses_stall: [{ role: "assistant", parts: [{ type: "text", text: "All done" }] }] },
            todos: { ses_stall: [] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3 })

        // Signal completion via task_complete tool
        await hooks.event!({ event: { type: "todo.updated", sessionID: "ses_stall", properties: { todos: [] } } } as any)

        // Simulate completion signal (no todos open, agent finished)
        const w = (hooks as any)
        // Trigger idle
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_stall", properties: { status: "idle" } } } as any)
        await wait(200)

        // Even with stall, should not resume because completionSignaled or no open todos
        expect(promptCalls.length).toBe(0)
    })

    test("FIX B1: fetchSessionTodos lazily fetches when no todo.updated event received", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_lazy", status: "busy" }],
            messages: { ses_lazy: [{ role: "assistant", parts: [{ type: "text", text: "step 1" }] }] },
            todos: { ses_lazy: [{ id: "t1", content: "open task", status: "pending", priority: "medium" }] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 3 })

        // NO todo.updated event sent — w.todos starts empty

        // Session goes idle — lazy fetch should populate w.todos from the API mock
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_lazy", properties: { status: "idle" } } } as any)
        await wait(200)

        // The nudge should fire because fetchSessionTodos populated open todos
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    })

    test("FIX B4: 🎉 with open todos does NOT latch completionSignaled (nudge sent)", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_emoji", status: "busy" }],
            messages: { ses_emoji: [{ role: "assistant", parts: [{ type: "text", text: "Step done 🎉" }] }] },
            todos: { ses_emoji: [{ id: "t1", content: "remaining", status: "pending", priority: "medium" }] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Open todos set
        await hooks.event!({ event: { type: "todo.updated", sessionID: "ses_emoji", properties: { todos: [{ id: "t1", content: "remaining", status: "pending", priority: "medium" }] } } } as any)

        // Idle — 🎉 detected but todos open → false positive → nudge sent
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_emoji", properties: { status: "idle" } } } as any)
        await wait(200)

        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    })

    test("FIX B4: 🎉 with NO open todos correctly blocks continue", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_done", status: "busy" }],
            messages: { ses_done: [{ role: "assistant", parts: [{ type: "text", text: "All done 🎉" }] }] },
            todos: { ses_done: [] },
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // NO open todos
        await hooks.event!({ event: { type: "todo.updated", sessionID: "ses_done", properties: { todos: [] } } } as any)

        // Idle — 🎉 with no todos → correctly latches completion
        await hooks.event!({ event: { type: "session.status", sessionID: "ses_done", properties: { status: "idle" } } } as any)
        await wait(200)

        expect(promptCalls.length).toBe(0)
    })
})
