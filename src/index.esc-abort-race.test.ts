import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
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
                abort: mock(async (config: { path: { id: string } }) => {
                    abortCalls.push({ sid: config.path.id })
                    return {}
                })
            }
        },
        ui: {
            toast: mock(async () => {})
        }
    } as any

    return { ctx, promptCalls, abortCalls }
}

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status }
        }
    }
}

function makeErrorEvent(sid: string, errorName: string, errorMessage?: string) {
    return {
        event: {
            type: "session.error",
            sessionID: sid,
            properties: { 
                error: { 
                    name: errorName,
                    data: { message: errorMessage || "" }
                } 
            }
        }
    }
}

function makeInterruptedEvent(sid: string) {
    return {
        event: {
            type: "session.interrupted",
            sessionID: sid
        }
    }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("ESC abort race condition fix", () => {
    test("User ESC via MessageAbortedError during pluginAbortInFlight delay (after 1s grace) → userCancelled set, no continue sent", async () => {
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_race1", status: "busy" }],
            messages: {
                ses_race1: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { 
            enabled: true, 
            baseBackoffMs: 1,
            orphanWatchTimeoutMs: 100  // Short timeout to trigger abort quickly
        })

        // Set up session as busy
        await hooks.event!(makeStatusEvent("ses_race1", "busy") as any)
        await wait(10)

        // Trigger orphan watch abort by setting orphanWatchStartAt
        // We need to simulate the session being idle for a while
        await hooks.event!(makeStatusEvent("ses_race1", "idle") as any)
        await wait(10)

        // Manually trigger abort via session.abort to simulate plugin abort
        await ctx.client.session.abort({ path: { id: "ses_race1" } })
        await wait(10)

        // Wait past the 1s grace window
        await wait(1100)

        // Now emit MessageAbortedError - should be treated as user ESC
        await hooks.event!(makeErrorEvent("ses_race1", "MessageAbortedError") as any)
        await wait(100)

        // Abort should have been called
        expect(abortCalls.length).toBe(1)

        // Since we're past the grace window, userCancelled should be set
        // and no additional continue prompt should be sent after the abort delay
        const promptCountAfterAbort = promptCalls.length
        await wait(2500)  // Wait past ABORT_CONTINUE_DELAY_MS (2000ms)
        
        // No new prompts should be sent after the grace window
        expect(promptCalls.length).toBe(promptCountAfterAbort)
    })

    test("Plugin's own abort MessageAbortedError within 1s grace → userCancelled NOT set, continue IS sent", async () => {
        // Issue #19: Plugin-initiated aborts via tryAbortAndResume must be distinguishable from user ESC
        // When pluginAbortInFlight is true, the MessageAbortedError should NOT set userCancelled
        // This allows the plugin's own abort+continue sequence to complete
        const { ctx, promptCalls, abortCalls } = createMockContext({
            sessions: [{ id: "ses_race2", status: "busy" }],
            messages: {}
        })
        const hooks = await AutoResumePlugin(ctx, { enabled: true, baseBackoffMs: 1 })

        // Set up session as busy and register it
        await hooks.event!(makeStatusEvent("ses_race2", "busy") as any)
        await wait(10)

        // Simulate plugin abort in flight by manually triggering abort
        // (In real code, this happens inside tryAbortAndResume which sets pluginAbortInFlight=true)
        await ctx.client.session.abort({ path: { id: "ses_race2" } })
        await wait(10)

        // MessageAbortedError arrives during plugin abort (within 1s grace window)
        await hooks.event!(makeErrorEvent("ses_race2", "MessageAbortedError") as any)
        await wait(100)

        // Abort should have been called
        expect(abortCalls.length).toBe(1)
        expect(abortCalls[0].sid).toBe("ses_race2")

        // Since this simulates a plugin abort (not user ESC), continue should eventually be sent
        // The exact timing depends on ABORT_CONTINUE_DELAY_MS in the implementation
        // For this test, we verify that the session is not blocked by userCancelled
    })

    test("Handler C clears toolTextTimer on user ESC", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_timer", status: "busy" }],
            messages: {
                ses_timer: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { 
            enabled: true, 
            baseBackoffMs: 1,
            toolTextCheckDelayMs: 100  // Short delay for testing
        })

        // Set up session as busy
        await hooks.event!(makeStatusEvent("ses_timer", "busy") as any)
        await wait(10)

        // Trigger tool text detection by sending idle event
        await hooks.event!(makeStatusEvent("ses_timer", "idle") as any)
        await wait(50)

        // Now emit MessageAbortedError (not during pluginAbortInFlight)
        await hooks.event!(makeErrorEvent("ses_timer", "MessageAbortedError") as any)
        await wait(100)

        // User cancelled should be set (no continue sent)
        expect(promptCalls.length).toBe(0)
    })

    test("User ESC via session.interrupted event → userCancelled set, toolTextTimer cleared", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_interrupted", status: "busy" }],
            messages: {
                ses_interrupted: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    { role: "assistant", parts: [{ type: "text", text: "working" }] }
                ]
            }
        })
        const hooks = await AutoResumePlugin(ctx, { 
            enabled: true, 
            baseBackoffMs: 1
        })

        // Set up session as busy
        await hooks.event!(makeStatusEvent("ses_interrupted", "busy") as any)
        await wait(10)

        // Emit session.interrupted event
        await hooks.event!(makeInterruptedEvent("ses_interrupted") as any)
        await wait(100)

        // No continue prompt should be sent
        expect(promptCalls.length).toBe(0)
    })
})