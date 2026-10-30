import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

// Mirror of the 2026-10-30 v2 incident (src/v2/index.unknown-tool.test.ts):
// the unknown-tool suggestion must fire once for the CURRENT episode and
// never again — not after a reload (empty examined-set) and not when the
// plugin's own suggestion is echoed back as a user message.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const AVAILABLE_TOOLS = ["bash", "read", "edit", "todowrite", "grep"]

function toolPart(id: string, tool: string, at: number, state = "error") {
    return { type: "tool", id, tool, state: { status: state }, time: { created: at } }
}

function createMockContext(opts: {
    sessions?: Array<{ id: string; status?: string }>
    messages?: Record<string, any[]>
    todos?: Record<string, any[]>
}) {
    const promptCalls: any[] = []
    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async () => {}) },
            tool: { ids: mock(async () => ({ data: AVAILABLE_TOOLS })) },
            session: {
                list: mock(async () => ({ data: opts.sessions ?? [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async (cfg: any) => opts.messages?.[cfg.path.id] ?? []),
                todo: mock(async (cfg: any) => ({ data: opts.todos?.[cfg.path.id] ?? [] })),
                prompt: mock(async (cfg: any) => { promptCalls.push(cfg); return {} }),
                abort: mock(async (cfg: any) => ({ ctx, abortCalls: [] })),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, promptCalls }
}

async function goBusyIdle(hooks: any, sid: string) {
    await hooks.event!({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } } as any)
    await wait(20)
    await hooks.event!({ event: { type: "session.idle", sessionID: sid } } as any)
    await wait(400)
}

describe("v1 unknown-tool suggestion: episode scoping", () => {
    test("CONTROL: two errored calls in the current episode still trigger the suggestion", async () => {
        const T = Date.now()
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_ctl", status: "idle" }],
            messages: { ses_ctl: [
                { role: "user", parts: [{ type: "text", text: "go" }], time: { created: T } },
                { role: "assistant", parts: [toolPart("c1", "aft_read", T + 1000), toolPart("c2", "aft_read", T + 2000)], time: { created: T + 2500 } },
            ] },
            todos: {},
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await goBusyIdle(hooks, "ses_ctl")
        expect(promptCalls).toHaveLength(1)
        expect(promptCalls[0].body?.parts?.[0]?.text ?? promptCalls[0].body?.text ?? "").toContain('closest matching tool is "read"')
    })

    test("a finished episode's stale errors are not recounted (reload-equivalent)", async () => {
        const OLD = Date.now() - 60_000
        const NEW = Date.now() - 5_000
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_stale", status: "idle" }],
            messages: { ses_stale: [
                { role: "user", parts: [{ type: "text", text: "earlier task" }], time: { created: OLD } },
                { role: "assistant", parts: [toolPart("o1", "aft_read", OLD + 1000), toolPart("o2", "aft_read", OLD + 2000)], time: { created: OLD + 2500 } },
                { role: "user", parts: [{ type: "text", text: "new clean turn" }], time: { created: NEW } },
                { role: "assistant", parts: [toolPart("ok1", "bash", NEW + 500, "completed")], time: { created: NEW + 800 } },
            ] },
            todos: {},
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await goBusyIdle(hooks, "ses_stale")
        expect(promptCalls).toHaveLength(0)
    })
})

describe("v1 unknown-tool suggestion: own prompt is not a new request", () => {
    test("the plugin's own suggestion echoed back does not re-arm and re-fire", async () => {
        const T = Date.now()
        const suggestionText =
            'You tried to use the tool "aft_read" 2 times, but it does not exist. ' +
            'The closest matching tool is "read". Please use "read" instead and adjust your arguments accordingly. ' +
            `Available tools include: ${AVAILABLE_TOOLS.slice(0, 20).join(", ")}.`
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_own", status: "idle" }],
            messages: { ses_own: [
                { role: "user", parts: [{ type: "text", text: "go" }], time: { created: T } },
                { role: "assistant", parts: [toolPart("e1", "aft_read", T + 1000), toolPart("e2", "aft_read", T + 2000)], time: { created: T + 2500 } },
            ] },
            todos: {},
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })
        await goBusyIdle(hooks, "ses_own")
        expect(promptCalls).toHaveLength(1)

        // The suggestion travels the visible channel: the server records it as
        // a user message and the plugin receives message.updated for it.
        await hooks.event!({
            event: {
                type: "message.updated",
                sessionID: "ses_own",
                properties: { info: { role: "user" }, parts: [{ type: "text", text: suggestionText }] },
            },
        } as any)
        await wait(50)

        // A second idle cycle after the echo must not produce a new suggestion.
        await goBusyIdle(hooks, "ses_own")
        expect(promptCalls).toHaveLength(1)
    })
})
