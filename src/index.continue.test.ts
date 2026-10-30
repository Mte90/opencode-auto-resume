import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; agent?: string; body: string }

function createContinueContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
}) {
    const promptCalls: PromptCall[] = []
    const statusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        statusMap[s.id] = { type: s.status }
    }

    const ctx = {
        serverUrl: "http://localhost:4096",
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
        ui: {
            toast: mock(async () => {})
        }
    } as any

    return { ctx, promptCalls }
}

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" }
]

const CLOSED_TODOS = [
    { id: "t1", content: "task one", status: "completed", priority: "high" },
    { id: "t2", content: "task two", status: "completed", priority: "high" }
]

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status }
        }
    }
}

function makeTodoUpdatedEvent(sid: string, todos: any[]) {
    return {
        event: {
            type: "todo.updated",
            sessionID: sid,
            properties: { todos }
        }
    }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("Continue behavior — single session", () => {
    test("single session idle with open todos → continue sent (busyCount === 0)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_single", status: "busy" }],
            messages: {
                ses_single: [
                    { role: "user", parts: [{ type: "text", text: "do the work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working on it" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_single", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_single", "idle") as any)

        await wait(200)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_single")
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("single session idle, all todos completed → NO continue", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_done", status: "busy" }],
            messages: {
                ses_done: [
                    { role: "assistant", parts: [{ type: "text", text: "all done" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_done", CLOSED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_done", "idle") as any)

        await wait(200)
        expect(promptCalls.length).toBe(0)
    })

    test("no todo.updated event ever → NO continue (no heuristic fallback)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_notodos", status: "busy" }],
            messages: {
                ses_notodos: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // No todo.updated event sent — w.todos stays empty
        await hooks.event!(makeStatusEvent("ses_notodos", "idle") as any)
        await wait(300)
        // Wait past the tool-text-check timer too
        await wait(3500)

        expect(promptCalls.length).toBe(0)
    })

    test("todo.updated with empty array → NO continue", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_empty", status: "busy" }],
            messages: {
                ses_empty: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_empty", []) as any)
        await hooks.event!(makeStatusEvent("ses_empty", "idle") as any)
        await wait(300)
        await wait(3500)

        expect(promptCalls.length).toBe(0)
    })

    test("🎉 in last assistant message WITH open todos → continue sent (FIX #16: 🎉 is a false positive if todos open)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_emoji", status: "busy" }],
            messages: {
                ses_emoji: [
                    { role: "assistant", parts: [{ type: "text", text: "Finished everything 🎉" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_emoji", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_emoji", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_emoji", "idle") as any)

        await wait(300)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    })
})

describe("Continue behavior — subagent running", () => {
    test("parent idle with open todos but subagent busy → NO continue (busyCount > 0)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [
                { id: "ses_parent", status: "busy" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {
                ses_parent: [
                    { role: "assistant", parts: [{ type: "text", text: "delegating" }] }
                ],
                ses_sub: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Register both sessions in the sessions map via status events
        await hooks.event!(makeStatusEvent("ses_parent", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_sub", "busy") as any)

        await hooks.event!(makeTodoUpdatedEvent("ses_parent", OPEN_TODOS) as any)

        // Parent goes idle while sub is still busy → busyCount === 1 → no continue
        await hooks.event!(makeStatusEvent("ses_parent", "idle") as any)

        await wait(200)
        expect(promptCalls.length).toBe(0)
    })

    test("both sessions idle with parent open todos → continue sent to parent", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [
                { id: "ses_parent", status: "busy" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {
                ses_parent: [
                    { role: "assistant", parts: [{ type: "text", text: "waiting for subagent" }] }
                ],
                ses_sub: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Register both sessions
        await hooks.event!(makeStatusEvent("ses_parent", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_sub", "busy") as any)

        await hooks.event!(makeTodoUpdatedEvent("ses_parent", OPEN_TODOS) as any)

        // Sub goes idle first (parent still busy)
        await hooks.event!(makeStatusEvent("ses_sub", "idle") as any)
        await wait(100)

        // Parent goes idle → now busyCount === 0 → continue to parent
        await hooks.event!(makeStatusEvent("ses_parent", "idle") as any)
        await wait(200)

        const parentPrompts = promptCalls.filter(p => p.sid === "ses_parent")
        expect(parentPrompts.length).toBe(1)
    })
})

describe("Continue behavior — repeated continues until done", () => {
    test("continue fires across multiple idle cycles until 🎉 appears", async () => {
        const messages = {
            ses_loop: [
                { role: "user", parts: [{ type: "text", text: "do work" }] },
                { role: "assistant", parts: [{ type: "text", text: "step 1 done" }] }
            ]
        }
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_loop", status: "busy" }],
            messages
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_loop", OPEN_TODOS) as any)

        // Cycle 1: idle → continue
        await hooks.event!(makeStatusEvent("ses_loop", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(1)

        // Agent works again
        await hooks.event!(makeStatusEvent("ses_loop", "busy") as any)
        await wait(100)

        // Cycle 2: idle again, still no 🎉 → continue
        messages.ses_loop.push({ role: "assistant", parts: [{ type: "text", text: "step 2 done" }] })
        await hooks.event!(makeStatusEvent("ses_loop", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(2)

        // Cycle 3: agent writes 🎉 but todos are STILL OPEN → false positive, continue fires
        await hooks.event!(makeStatusEvent("ses_loop", "busy") as any)
        await wait(100)

        messages.ses_loop.push({ role: "assistant", parts: [{ type: "text", text: "All done 🎉" }] })
        await hooks.event!(makeStatusEvent("ses_loop", "idle") as any)
        await wait(300)

        // 3 continues — 🎉 with open todos is a false positive (FIX #16)
        expect(promptCalls.length).toBe(3)
    })

    test("continue fires across multiple idle cycles until todos close", async () => {
        const messages = {
            ses_todos: [
                { role: "user", parts: [{ type: "text", text: "do work" }] },
                { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
            ]
        }
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_todos", status: "busy" }],
            messages
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_todos", OPEN_TODOS) as any)

        // Cycle 1: idle → continue
        await hooks.event!(makeStatusEvent("ses_todos", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(1)

        // Cycle 2: busy → idle, still open → continue
        await hooks.event!(makeStatusEvent("ses_todos", "busy") as any)
        await wait(100)

        messages.ses_todos.push({ role: "assistant", parts: [{ type: "text", text: "step 2" }] })
        await hooks.event!(makeStatusEvent("ses_todos", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(2)

        // Cycle 3: todos close → no continue
        await hooks.event!(makeStatusEvent("ses_todos", "busy") as any)
        await wait(100)

        messages.ses_todos.push({ role: "assistant", parts: [{ type: "text", text: "step 3" }] })
        await hooks.event!(makeTodoUpdatedEvent("ses_todos", CLOSED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_todos", "idle") as any)
        await wait(300)

        expect(promptCalls.length).toBe(2)
    })

    test("continue fires repeatedly — todoNudgeAttempts resets on busy (fresh budget each cycle)", async () => {
        const messages = {
            ses_persist: [
                { role: "user", parts: [{ type: "text", text: "do work" }] },
                { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
            ]
        }
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_persist", status: "busy" }],
            messages
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1, maxRetries: 10 })

        await hooks.event!(makeTodoUpdatedEvent("ses_persist", OPEN_TODOS) as any)

        for (let i = 1; i <= 5; i++) {
            await hooks.event!(makeStatusEvent("ses_persist", "idle") as any)
            await wait(200)
            expect(promptCalls.length).toBe(i)

            if (i < 5) {
                await hooks.event!(makeStatusEvent("ses_persist", "busy") as any)
                await wait(100)
                messages.ses_persist.push({
                    role: "assistant",
                    parts: [{ type: "text", text: `step ${i + 1}` }]
                })
            }
        }

        expect(promptCalls.length).toBe(5)
    })
})

describe("Continue behavior — 🎉 race condition fix", () => {
    test("idle handler checks 🎉 before calling tryResume (with NO open todos → no continue)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_race", status: "busy" }],
            messages: {
                ses_race: [
                    { role: "assistant", parts: [{ type: "text", text: "Done with everything 🎉" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // NO open todos → 🎉 correctly signals completion
        await hooks.event!(makeTodoUpdatedEvent("ses_race", []) as any)

        await hooks.event!(makeStatusEvent("ses_race", "idle") as any)

        await wait(300)
        expect(promptCalls.length).toBe(0)

        await wait(3500)
        expect(promptCalls.length).toBe(0)
    })

    test("🎉 with punctuation before emoji → still detected (with NO open todos)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_punct", status: "busy" }],
            messages: {
                ses_punct: [
                    { role: "assistant", parts: [{ type: "text", text: "All tasks complete. 🎉" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_punct", []) as any)
        await hooks.event!(makeStatusEvent("ses_punct", "idle") as any)

        await wait(300)
        expect(promptCalls.length).toBe(0)
    })

    test("🎉 with whitespace before emoji → still detected (with NO open todos)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_ws", status: "busy" }],
            messages: {
                ses_ws: [
                    { role: "assistant", parts: [{ type: "text", text: "Done   🎉" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        await hooks.event!(makeTodoUpdatedEvent("ses_ws", []) as any)
        await hooks.event!(makeStatusEvent("ses_ws", "idle") as any)

        await wait(300)
        expect(promptCalls.length).toBe(0)
    })
})

describe("Continue behavior — periodic idle recheck", () => {
    test("periodic timer fires second nudge when session stays idle after first nudge", async () => {
        const { ctx, promptCalls } = createContinueContext({
            // Use "idle" as initial status so the periodic timer's status sync
            // (line 1134-1137) doesn't overwrite w.status back to "busy".
            sessions: [{ id: "ses_periodic", status: "idle" }],
            messages: {
                ses_periodic: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 5,
            // Raise loopMaxContinues so isHallucinationLoop (which also counts
            // periodic tryResume calls) doesn't intercept the second nudge.
            loopMaxContinues: 10
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_periodic", OPEN_TODOS) as any)

        // Fire idle event → triggers idle handler → nudge 1
        await hooks.event!(makeStatusEvent("ses_periodic", "idle") as any)

        // handleEvent is fire-and-forget (line 1532 lacks await),
        // so yield briefly for the async chain to complete.
        await wait(20)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)

        // Session stays idle — no more idle events.
        // The periodic timer (50ms interval) rechecks and sends nudge 2.
        await wait(400)
        expect(promptCalls.length).toBeGreaterThanOrEqual(2)

        const secondBody = promptCalls[1].body
        expect(secondBody).toContain("unfinished task")
    })

    test("periodic recheck respects busyCount > 0 (skips nudge when subagent busy)", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [
                // ses_parent starts idle so periodic timer sync doesn't reset it,
                // but ses_sub stays busy → busyCount = 1 → no nudge
                { id: "ses_parent", status: "idle" },
                { id: "ses_sub", status: "busy" }
            ],
            messages: {
                ses_parent: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "waiting for sub" }] }
                ],
                ses_sub: [
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 5,
            loopMaxContinues: 10
        })

        // Register both sessions
        await hooks.event!(makeStatusEvent("ses_parent", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_sub", "busy") as any)
        await hooks.event!(makeTodoUpdatedEvent("ses_parent", OPEN_TODOS) as any)

        // Parent goes idle but subagent still busy → busyCount = 1
        await hooks.event!(makeStatusEvent("ses_parent", "idle") as any)

        // The idle handler respects busyCount > 0, so no instant nudge.
        // The periodic recheck also checks busyCount() !== 0.
        await wait(500)
        expect(promptCalls.length).toBe(0)
    })

    test("periodic recheck respects maxRetries limit and stops after threshold", async () => {
        const { ctx, promptCalls } = createContinueContext({
            sessions: [{ id: "ses_limited", status: "idle" }],
            messages: {
                ses_limited: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "step 1" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 2,
            loopMaxContinues: 10
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_limited", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_limited", "idle") as any)

        // handleEvent is fire-and-forget; yield briefly for chain.
        await wait(20)
        expect(promptCalls.length).toBeGreaterThanOrEqual(1)

        // Wait enough periodic timer cycles for retries to exhaust.
        // todoNudgeAttempts: 0 → idle handler sets to 1 → periodic sets to 2,
        // then stops at maxRetries=2 (todoNudgeAttempts >= maxRetries).
        await wait(600)
        expect(promptCalls.length).toBe(2)
    })
})
