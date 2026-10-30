import { describe, test, expect, mock } from "bun:test"
import dispatcher from "./dispatch"
import { capturePluginLogs } from "./v2/test-utils"

describe("dispatch.ts — dual-shape plugin entry", () => {
    describe("shape contract", () => {
        test("dispatcher.id is a string", () => {
            expect(typeof dispatcher.id).toBe("string")
            expect(dispatcher.id).toBe("auto-resume.v2")
        })

        test("dispatcher.server is a function", () => {
            expect(typeof dispatcher.server).toBe("function")
        })

        test("dispatcher.setup is a function", () => {
            expect(typeof dispatcher.setup).toBe("function")
        })
    })

    describe(".server delegates to the v1 build", () => {
        function createMinimalV1Ctx() {
            return {
                client: {
                    app: {
                        log: mock(async (_o: { body: { level: string; message: string } }) => {})
                    },
                    session: {
                        list: mock(async () => ({ data: [] })),
                        status: mock(async () => ({ data: {} })),
                        todo: mock(async (_config: { path: { id: string } }) => ({ data: [] })),
                        messages: mock(async (_config: { path: { id: string } }) => ({ data: [] })),
                        prompt: mock(async (_config: {
                            path: { id: string }
                            body: { parts: Array<{ type: string; text: string }> }
                        }) => ({})),
                        abort: mock(async () => ({}))
                    }
                },
                ui: {
                    toast: mock(async () => {})
                }
            }
        }

        test("without serverUrl warns about ctx.serverUrl is missing and returns hooks with callable event", async () => {
            const warns: string[] = []
            const originalWarn = console.warn
            console.warn = mock((msg: string) => {
                warns.push(msg)
            })

            try {
                const ctx = createMinimalV1Ctx()
                // Explicitly NO serverUrl

                const options = {
                    enabled: true,
                    baseBackoffMs: 1,
                    checkIntervalMs: 10_000_000,
                    maxRetries: 3,
                    loopMaxContinues: 10,
                    minActivityGapMs: 0,
                    toolTextCheckDelayMs: 10,
                    warmupMs: 0,
                    activeUserWindowMs: 0
                }

                const hooks = await (dispatcher.server as any)(ctx, options)

                // Assert the warning was emitted
                expect(warns.length).toBe(1)
                expect(warns[0]).toContain("ctx.serverUrl is missing")

                // Assert hooks has callable event
                expect(hooks).toBeDefined()
                expect(typeof hooks.event).toBe("function")
            } finally {
                console.warn = originalWarn
            }
        })

        test("with proper v1 serverUrl emits no warning and returns hooks", async () => {
            const warns: string[] = []
            const originalWarn = console.warn
            console.warn = mock((msg: string) => {
                warns.push(msg)
            })

            try {
                const ctxWithUrl: any = createMinimalV1Ctx()
                ctxWithUrl.serverUrl = "http://localhost:4096"

                const options = {
                    enabled: true,
                    baseBackoffMs: 1,
                    checkIntervalMs: 10_000_000,
                    maxRetries: 3,
                    loopMaxContinues: 10,
                    minActivityGapMs: 0,
                    toolTextCheckDelayMs: 10,
                    warmupMs: 0,
                    activeUserWindowMs: 0
                }

                const hooks = await (dispatcher.server as any)(ctxWithUrl, options)

                // Assert no warning about missing serverUrl
                const serverUrlWarnings = warns.filter(w => w.includes("ctx.serverUrl is missing"))
                expect(serverUrlWarnings.length).toBe(0)

                // Assert hooks has callable event
                expect(hooks).toBeDefined()
                expect(typeof hooks.event).toBe("function")
            } finally {
                console.warn = originalWarn
            }
        })
    })

    describe(".setup delegates to the v2 build", () => {
        const textPart = (t: string) => ({ type: "text", text: t })

        function makeEventStream() {
            const queue: any[] = []
            const waiters: ((ev: any) => void)[] = []
            let closed = false
            const stream = {
                push(ev: any) {
                    if (waiters.length) waiters.shift()!(ev)
                    else queue.push(ev)
                },
                close() {
                    closed = true
                    while (waiters.length) waiters.shift()!(null)
                },
                subscribe: () => stream,
                [Symbol.asyncIterator]() {
                    return {
                        next: () =>
                            new Promise((resolve) => {
                                if (queue.length) return resolve({ value: queue.shift(), done: false })
                                if (closed) return resolve({ value: undefined, done: true })
                                waiters.push((ev) =>
                                    resolve(ev === null ? { value: undefined, done: true } : { value: ev, done: false }),
                                )
                            }),
                        return: () => {
                            closed = true
                            return Promise.resolve({ value: undefined, done: true })
                        },
                    }
                },
            }
            return stream
        }

        let counter = 0

        test("without app key warns about ctx.app.version is missing", async () => {
            const capture = capturePluginLogs()

            const stream = makeEventStream()
            const ctx: any = {
                event: stream,
                options: { toolTextCheckDelayMs: 0, registryScope: "DispatchTest" },
                session: {
                    context: async () => [
                        {
                            type: "user",
                            id: "msg_u0",
                            time: { created: Date.now() - 60 * 60_000 },
                            content: [textPart("go ahead")],
                        },
                        {
                            type: "assistant",
                            id: "msg_a1",
                            time: { created: Date.now() - 60_000 },
                            content: [textPart("Ready to continue")],
                        },
                    ],
                    active: async () => ({}),
                    interrupt: async () => ({}),
                    synthetic: async () => ({ kind: "synthetic" }),
                    prompt: async () => ({ kind: "prompt" }),
                },
                // NO app key
            }

            const cleanup = await (dispatcher.setup as any)(ctx)
            await new Promise(r => setTimeout(r, 200))

            try {
                // Check BEFORE stopping capture
                const warnLines = capture.warns.filter((l: string) =>
                    l.includes("ctx.app.version is missing")
                )
                expect(warnLines.length).toBe(1)
            } finally {
                capture.stop()
                cleanup?.()
            }
        })

        test("with proper app context emits no warning", async () => {
            const capture = capturePluginLogs()

            const stream = makeEventStream()
            const ctx: any = {
                event: stream,
                options: { toolTextCheckDelayMs: 0, registryScope: "DispatchTest" },
                session: {
                    context: async () => [
                        {
                            type: "user",
                            id: "msg_u0",
                            time: { created: Date.now() - 60 * 60_000 },
                            content: [textPart("go ahead")],
                        },
                        {
                            type: "assistant",
                            id: "msg_a1",
                            time: { created: Date.now() - 60_000 },
                            content: [textPart("Ready to continue")],
                        },
                    ],
                    active: async () => ({}),
                    interrupt: async () => ({}),
                    synthetic: async () => ({ kind: "synthetic" }),
                    prompt: async () => ({ kind: "prompt" }),
                },
                app: {
                    name: "opencode",
                    version: "2.0.27",
                    channel: "stable"
                }
            }

            const cleanup = await (dispatcher.setup as any)(ctx)
            await new Promise(r => setTimeout(r, 200))

            try {
                // Check BEFORE stopping capture
                const warnLines = capture.warns.filter((l: string) =>
                    l.includes("ctx.app.version is missing")
                )
                expect(warnLines.length).toBe(0)
            } finally {
                capture.stop()
                cleanup?.()
            }
        })

        test("setup() with a v1-shaped ctx (no app, no event) falls back to the v1 build", async () => {
            const capture = capturePluginLogs()

            // Setup-style host carrying a v1 PluginInput shape: serverUrl and
            // client present, no ctx.app, no ctx.event.
            const appLog = mock()
            const ctx: any = {
                serverUrl: "http://localhost:4096",
                client: {
                    app: { log: appLog },
                    session: {
                        list: async () => ({ data: [] }),
                        status: async () => ({ data: {} }),
                        todo: async () => ({ data: [] }),
                        messages: async () => ({ data: [] }),
                        prompt: async () => ({}),
                        abort: async () => ({}),
                    },
                    config: { get: async () => ({ data: { plugin: [] } }) },
                    file: { status: async () => ({ data: [] }) },
                    auth: { list: async () => ({ data: {} }) },
                    find: { text: async () => ({ data: [] }) },
                    app: { log: appLog, agents: async () => ({ data: [] }) },
                },
                options: {
                    enabled: true,
                    baseBackoffMs: 1,
                    checkIntervalMs: 10_000_000,
                    maxRetries: 3,
                    loopMaxContinues: 10,
                    minActivityGapMs: 0,
                    toolTextCheckDelayMs: 10,
                    warmupMs: 0,
                    activeUserWindowMs: 0,
                },
            }

            const hooks = await (dispatcher.setup as any)(ctx)

            try {
                // The v1 build ran for real: it wires the task_complete tool
                // and logs "ready" through ctx.client.app.log on the first
                // event. An inert abort would have neither.
                expect(hooks).toBeDefined()
                expect(hooks.tool).toBeDefined()

                const serverUrlWarnings = capture.warns.filter((l: string) =>
                    l.includes("ctx.serverUrl is missing"),
                )
                expect(serverUrlWarnings.length).toBe(0)

                await hooks.event({ event: { type: "session.idle", properties: {} } } as any)
                const readyCalls = appLog.mock.calls.filter((c: any[]) =>
                    JSON.stringify(c).includes("opencode-auto-resume ready"),
                )
                expect(readyCalls.length).toBe(1)
            } finally {
                capture.stop()
            }
        })

        test("setup() with an unrecognised ctx warns and returns an inert dispose", async () => {
            const capture = capturePluginLogs()

            // No app.version, no event.subscribe, no serverUrl, no client.
            const cleanup = await (dispatcher.setup as any)({})

            try {
                expect(typeof cleanup).toBe("function")
                expect(() => cleanup()).not.toThrow()

                const diag = capture.warns.filter((l: string) =>
                    l.includes("unrecognised host context"),
                )
                expect(diag.length).toBe(1)
                expect(diag[0]).toContain("ctx.app.version")
                expect(diag[0]).toContain("ctx.serverUrl")
                expect(diag[0]).toContain("README")
            } finally {
                capture.stop()
            }
        })
    })
})
