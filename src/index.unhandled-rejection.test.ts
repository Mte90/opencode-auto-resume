import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages?: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
    throwOnMessages?: boolean
    throwOnStatus?: boolean
    throwOnAbort?: boolean
    throwOnList?: boolean
    throwOnPrompt?: boolean
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []

    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        defaultStatusMap[s.id] = { type: s.status }
    }
    const statusMap = opts.statusMap ?? defaultStatusMap
    const messages = opts.messages ?? {}

    const unexpectedErr = () => {
        throw new Error("Unexpected server error. Check server logs for details.")
    }

    const ctx = {
        serverUrl: "http://localhost:4096",
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => {
                    if (opts.throwOnList) unexpectedErr()
                    return {
                        data: opts.sessions.map((s) => ({
                            id: s.id,
                            projectID: "proj-1",
                            directory: "/test",
                            title: s.id,
                            version: "1.0.0",
                            time: { created: Date.now(), updated: Date.now() },
                        })),
                    }
                }),
                status: mock(async () => {
                    if (opts.throwOnStatus) unexpectedErr()
                    return { data: statusMap }
                }),
                messages: mock(async (config: { path: { id: string } }) => {
                    if (opts.throwOnMessages) unexpectedErr()
                    return messages[config.path.id] ?? []
                }),
                prompt: mock(async (config: any) => {
                    if (opts.throwOnPrompt) unexpectedErr()
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    if (opts.throwOnAbort) unexpectedErr()
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
const OPTS = { enabled: true, baseBackoffMs: 1, checkIntervalMs: 50 }

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

describe("unhandled-rejection guards (regression for plugin host crash)", () => {
    test("REGRESSION: event hook must wrap handleEvent in .catch() to prevent unhandled rejection from SDK throws", () => {
        expect(
            SOURCE,
            "event hook must call handleEvent(...).catch(...)",
        ).toMatch(/handleEvent\(event as Record<string, unknown>\)\.catch\(/)
    })

    test("REGRESSION: periodic timer body must be wrapped in safe() (or equivalent error boundary)", () => {
        expect(
            SOURCE,
            "setInterval async callback must be wrapped in a safe()/try-catch error boundary",
        ).toMatch(/setInterval\(async \(\) => \{[\s\S]*?await safe\(async \(\) => \{/)
    })

    test("REGRESSION: log() catch block must not rethrow (silent log failures must not propagate)", () => {
        expect(
            SOURCE,
            "log() catch must not rethrow; it must console.error best-effort",
        ).toMatch(/async function log[\s\S]*?catch \(e\) \{[\s\S]*?console\.error/)
    })

    test("REGRESSION: a safe() error-boundary helper must exist", () => {
        expect(
            SOURCE,
            "plugin must define an async safe() error boundary",
        ).toMatch(/async function safe/)
    })

    test("REGRESSION: safe() helper must catch, log via console.error, and return undefined on error", () => {
        const safeMatch = SOURCE.match(
            /async function safe[\s\S]*?return undefined\s*\n\s*\}/,
        )
        expect(safeMatch, "safe() helper not found").not.toBeNull()
        const safeBody = safeMatch![0]
        expect(safeBody).toContain("try")
        expect(safeBody).toContain("catch")
        expect(safeBody).toContain("console.error")
        expect(safeBody).toContain("return undefined")
    })

    test("BEHAVIORAL: event() promise does not reject when SDK throws on idle path", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_beh1", status: "idle" }],
            throwOnMessages: true,
        })

        const hooks = await AutoResumePlugin(ctx, OPTS as any)

        let eventRejected = false
        let eventRejection: unknown
        const onUnhandled = (reason: unknown) => {
            eventRejected = true
            eventRejection = reason
        }
        process.on("unhandledRejection", onUnhandled)

        try {
            await hooks.event!({
                event: {
                    type: "session.status",
                    sessionID: "ses_beh1",
                    properties: { status: "idle" },
                },
            } as any)
            await wait(200)

            if (eventRejected) {
                throw new Error(
                    `REGRESSION broken: leaked rejection: ${
                        eventRejection instanceof Error ? eventRejection.message : eventRejection
                    }`,
                )
            }
            expect(eventRejected).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })

    test("BEHAVIORAL: periodic timer with throwing session.status does not leak rejection", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_beh2", status: "busy" }],
            throwOnStatus: true,
        })

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            await AutoResumePlugin(ctx, {
                ...OPTS,
                checkIntervalMs: 30,
                subagentWaitMs: 1,
                gracePeriodMs: 1,
            } as any)
            await wait(400)
            expect(leaked).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })

    test("BEHAVIORAL: log() never propagates when backend is down", async () => {
        const ctx = {
            serverUrl: "http://localhost:4096",
            client: {
                app: {
                    log: mock(async () => {
                        throw new Error("logging backend down")
                    }),
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({ data: {} })),
                    messages: mock(async () => []),
                    prompt: mock(async () => ({})),
                    abort: mock(async () => ({})),
                },
            },
            ui: { toast: mock(async () => {}) },
        } as any

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            const hooks = await AutoResumePlugin(ctx, OPTS as any)
            await hooks.event!({
                event: {
                    type: "session.status",
                    sessionID: "ses_logfail",
                    properties: { status: "idle" },
                },
            } as any)
            await wait(250)
            expect(leaked).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })

    test("BEHAVIORAL: abort path with throwing session.abort does not leak rejection", async () => {
        const { ctx, abortCalls } = createMockContext({
            sessions: [{ id: "ses_beh3", status: "busy" }],
            throwOnAbort: true,
        })

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            const hooks = await AutoResumePlugin(ctx, {
                ...OPTS,
                checkIntervalMs: 30,
                subagentWaitMs: 1,
                gracePeriodMs: 1,
                chunkTimeoutMs: 1,
            } as any)

            await hooks.event!({
                event: {
                    type: "session.status",
                    sessionID: "ses_beh3",
                    properties: { status: "busy" },
                },
            } as any)
            await hooks["tool.execute.before"]!({ sessionID: "ses_beh3" } as any, {} as any)
            await wait(500)

            expect(leaked).toBe(false)
            void abortCalls
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })
})
