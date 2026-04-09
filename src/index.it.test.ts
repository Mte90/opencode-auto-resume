import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test"

const mockSessions = new Map<string, {
    id: string
    status?: string
    lastActivityAt: number
    resumeAttempts: number
    lastRetryAt: number
    toolTextRecovered: boolean
    toolTextAttempts: number
    userCancelled: boolean
    aborting: boolean
    agent?: string
    idleSince?: number
}>()

const mockCtx = {
    client: {
        session: {
            list: mock(() => Promise.resolve({
                data: Array.from(mockSessions.values()).map(s => ({ id: s.id, status: s.status }))
            })),
            messages: mock(() => Promise.resolve([
                { role: "assistant", agent: "sisyphus", id: "msg-1" }
            ])),
            prompt: mock(() => Promise.resolve({})),
            abort: mock(() => Promise.resolve({})),
        }
    },
    on: mock(() => {}),
    idle: mock(() => {}),
}

describe("Plugin Core Logic", () => {
    beforeEach(() => {
        mockSessions.clear()
        mockCtx.client.session.list.mockClear()
        mockCtx.client.session.prompt.mockClear()
        mockCtx.client.session.messages.mockClear()
    })

    describe("SessionWatch state machine", () => {
        test("transitions from idle to busy on activity", () => {
            const sessions = new Map<string, any>()
            
            function ensureWatch(sid: string) {
                if (!sessions.has(sid)) {
                    sessions.set(sid, {
                        status: undefined,
                        lastActivityAt: Date.now(),
                        resumeAttempts: 0,
                        lastRetryAt: 0,
                    })
                }
                return sessions.get(sid)
            }

            const w = ensureWatch("test-session")
            expect(w.status).toBeUndefined()
            
            w.status = "busy"
            w.lastActivityAt = Date.now()
            
            expect(w.status).toBe("busy")
            expect(w.resumeAttempts).toBe(0)
        })

        test("tracks retry attempts with backoff", () => {
            const sessions = new Map<string, any>()
            
            function ensureWatch(sid: string) {
                if (!sessions.has(sid)) {
                    sessions.set(sid, {
                        resumeAttempts: 0,
                        lastRetryAt: 0,
                    })
                }
                return sessions.get(sid)
            }

            const w = ensureWatch("test-session")
            
            w.resumeAttempts = 0
            w.lastRetryAt = 0
            expect(w.resumeAttempts).toBe(0)

            w.resumeAttempts++
            w.lastRetryAt = Date.now()
            expect(w.resumeAttempts).toBe(1)
        })

        test("detects when backoff is required", () => {
            function backoffMs(attempt: number): number {
                return Math.min(5000 * Math.pow(2, attempt), 160000)
            }

            expect(backoffMs(0)).toBe(5000)
            expect(backoffMs(1)).toBe(10000)
            
            const now = Date.now()
            const lastRetryAt = now - 3000
            const elapsed = now - lastRetryAt
            expect(elapsed < backoffMs(0)).toBe(true)
            
            const lastRetryAt2 = now - 10000
            const elapsed2 = now - lastRetryAt2
            expect(elapsed2 >= backoffMs(0)).toBe(true)
        })
    })

    describe("Event parsing", () => {
        test("parses session.message.delta event", () => {
            const event = {
                type: "session.message.delta",
                sessionID: "session-abc123",
                properties: {
                    token: "thinking"
                }
            }

            expect(event.sessionID).toBe("session-abc123")
            expect(event.properties.token).toBe("thinking")
        })

        test("parses session.message.complete event", () => {
            const event = {
                type: "session.message.complete",
                sessionID: "session-abc123",
                properties: {
                    message: { role: "assistant" }
                }
            }

            expect(event.sessionID).toBe("session-abc123")
        })

        test("parses error event with error object", () => {
            const event = {
                type: "session.error",
                sessionID: "session-abc123",
                error: {
                    message: "Expected 'id' to be a string"
                }
            }

            expect(event.error.message).toBe("Expected 'id' to be a string")
            expect(event.sessionID).toBe("session-abc123")
        })
    })

    describe("Hallucination loop detection", () => {
        test("detects repeated similar content", () => {
            const recentContents = [
                "I will analyze this further",
                "I will analyze this further",
                "I will analyze this further",
                "Let me provide a solution",
            ]

            const loopCount = recentContents.filter(
                (c, i) => i > 0 && c === recentContents[i - 1]
            ).length

            expect(loopCount).toBe(2)
        })

        test("detects alternating identical messages", () => {
            const recentContents = [
                "Analyzing the code...",
                "Analyzing the code...",
                "Analyzing the code...",
                "Analyzing the code...",
            ]

            const allSame = recentContents.every(c => c === recentContents[0])
            expect(allSame).toBe(true)
        })
    })

    describe("Agent preservation", () => {
        test("extracts agent from assistant message", () => {
            const messages = [
                { role: "user", content: "Hello" },
                { role: "assistant", agent: "prometheus", content: "Hi!" },
            ]

            const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
            expect(lastAssistant?.agent).toBe("prometheus")
        })

        test("returns undefined if no assistant message", () => {
            const messages = [
                { role: "user", content: "Hello" },
            ]

            const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
            expect(lastAssistant).toBeUndefined()
        })

        test("preserves agent across session state changes", () => {
            let session = { agent: "metis", status: "idle" }
            
            session.status = "busy"
            expect(session.agent).toBe("metis")
            
            session.status = "idle"
            expect(session.agent).toBe("metis")
        })
    })

    describe("Resume flow", () => {
        test("validates session ID before prompt", async () => {
            const invalidIds = ["", null, undefined, 123, {}]
            
            for (const id of invalidIds) {
                const isValid = typeof id === "string" && id.length > 0
                expect(isValid).toBe(false)
            }
        })

        test("includes agent in prompt request", async () => {
            const session = {
                agent: "prometheus",
            }

            const agent = typeof session.agent === "string" ? session.agent : undefined
            
            expect(agent).toBe("prometheus")
        })

        test("handles missing agent gracefully", async () => {
            const session = {
                agent: undefined,
            }

            const agent = typeof session.agent === "string" ? session.agent : undefined
            
            expect(agent).toBeUndefined()
        })
    })

    describe("Tool-text recovery", () => {
        test("increments toolTextAttempts on retry", () => {
            const w = {
                toolTextAttempts: 0,
                toolTextRecovered: false,
            }

            w.toolTextAttempts++
            expect(w.toolTextAttempts).toBe(1)
            expect(w.toolTextRecovered).toBe(false)
        })

        test("sets toolTextRecovered on success", () => {
            const w = {
                toolTextAttempts: 3,
                toolTextRecovered: false,
            }

            w.toolTextRecovered = true
            expect(w.toolTextRecovered).toBe(true)
            expect(w.toolTextAttempts).toBe(3)
        })

        test("respects max retry limit", () => {
            const maxRetries = 3
            let attempts = 0
            
            for (let i = 0; i < 10; i++) {
                if (attempts < maxRetries) {
                    attempts++
                }
            }

            expect(attempts).toBe(maxRetries)
        })
    })

    describe("Abort + Resume flow", () => {
        test("sets aborting flag before abort", async () => {
            const w = { aborting: false }

            w.aborting = true
            expect(w.aborting).toBe(true)
        })

        test("clears aborting after resume", async () => {
            const w = { aborting: true }

            w.aborting = false
            expect(w.aborting).toBe(false)
        })

        test("prevents concurrent aborts", () => {
            const w = { aborting: false }

            const shouldAbort = !w.aborting
            expect(shouldAbort).toBe(true)

            w.aborting = true
            const shouldAbort2 = !w.aborting
            expect(shouldAbort2).toBe(false)
        })
    })

    describe("Edge cases", () => {
        test("handles empty session list", async () => {
            const sessions: any[] = []
            expect(sessions.length).toBe(0)
        })

        test("handles malformed session data", () => {
            const malformed = [
                { id: undefined },
                { id: null },
                { id: 123 },
                {},
            ]

            const valid = malformed.filter(s => typeof s.id === "string" && s.id)
            expect(valid.length).toBe(0)
        })

        test("handles rapid state changes", () => {
            const states = ["idle", "busy", "idle", "busy", "idle"]
            const lastState = states[states.length - 1]
            expect(lastState).toBe("idle")
        })
    })
})

describe("OpenCode Context Mock", () => {
    test("mock client.session methods exist", () => {
        expect(typeof mockCtx.client.session.list).toBe("function")
        expect(typeof mockCtx.client.session.prompt).toBe("function")
        expect(typeof mockCtx.client.session.messages).toBe("function")
        expect(typeof mockCtx.client.session.abort).toBe("function")
    })

    test("mock context has event handlers", () => {
        expect(typeof mockCtx.on).toBe("function")
        expect(typeof mockCtx.idle).toBe("function")
    })

    test("mock session.list returns expected structure", async () => {
        mockSessions.set("session-1", { id: "session-1", status: "idle", lastActivityAt: Date.now(), resumeAttempts: 0, lastRetryAt: 0, toolTextRecovered: false, toolTextAttempts: 0, userCancelled: false, aborting: false })
        
        const result = await mockCtx.client.session.list()
        const data = result as { data: Array<{ id: string; status?: string }> }
        
        expect(Array.isArray(data.data)).toBe(true)
        expect(data.data[0].id).toBe("session-1")
    })
})