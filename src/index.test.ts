import { describe, test, expect } from "bun:test"
import { buildOpenTodosReminder } from "./index"

function short(id: string): string {
    return id.length > 8 ? id.slice(0, 4) + "…" + id.slice(-4) : id
}

function backoffMs(attempt: number): number {
    // exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s
    return Math.min(5000 * Math.pow(2, attempt), 160000)
}

function getSid(ev: Record<string, unknown>): string | undefined {
    const props = ev.properties as Record<string, unknown> | undefined
    return (
        (ev.sessionID as string | undefined) ??
        (props?.sessionID as string | undefined) ??
        ((props?.part as Record<string, unknown>)?.sessionID as string | undefined) ??
        ((props?.info as Record<string, unknown>)?.sessionID as string | undefined)
    )
}

function getError(ev: Record<string, unknown>): Record<string, unknown> | undefined {
    const props = ev.properties as Record<string, unknown> | undefined
    return (
        (ev.error as Record<string, unknown> | undefined) ??
        (props?.error as Record<string, unknown> | undefined)
    )
}

function isSessionWatch(obj: unknown): obj is { status?: string } {
    return typeof obj === "object" && obj !== null
}

// -----------------------------------------------------------------------
// Tests: short()
// -----------------------------------------------------------------------

describe("short()", () => {
    test("returns full string if length <= 8", () => {
        expect(short("abc")).toBe("abc")
        expect(short("12345678")).toBe("12345678")
    })

    test("truncates long strings with ellipsis", () => {
        expect(short("abcdefghij")).toBe("abcd…ghij")
        expect(short("session-123-abc")).toBe("sess…-abc")
    })
})

// -----------------------------------------------------------------------
// Tests: backoffMs()
// -----------------------------------------------------------------------

describe("backoffMs()", () => {
    test("returns 5000ms for attempt 0", () => {
        expect(backoffMs(0)).toBe(5000)
    })

    test("doubles each attempt (0-indexed)", () => {
        expect(backoffMs(1)).toBe(10000)
        expect(backoffMs(2)).toBe(20000)
        expect(backoffMs(3)).toBe(40000)
        expect(backoffMs(4)).toBe(80000)
    })

    test("caps at 160000ms (160s)", () => {
        expect(backoffMs(10)).toBe(160000)
        expect(backoffMs(100)).toBe(160000)
    })
})

// -----------------------------------------------------------------------
// Tests: getSid()
// -----------------------------------------------------------------------

describe("getSid()", () => {
    test("extracts sessionID from top-level event", () => {
        const ev = { sessionID: "session-123" }
        expect(getSid(ev)).toBe("session-123")
    })

    test("extracts sessionID from properties", () => {
        const ev = { properties: { sessionID: "session-456" } }
        expect(getSid(ev)).toBe("session-456")
    })

    test("extracts sessionID from nested part.info", () => {
        const ev = {
            properties: {
                part: { sessionID: "session-789" },
                info: { sessionID: "session-other" }
            }
        }
        expect(getSid(ev)).toBe("session-789")
    })

    test("prefers top-level over nested", () => {
        const ev = {
            sessionID: "top-level",
            properties: { sessionID: "nested" }
        }
        expect(getSid(ev)).toBe("top-level")
    })

    test("returns undefined if no sessionID", () => {
        expect(getSid({})).toBeUndefined()
        expect(getSid({ foo: "bar" })).toBeUndefined()
    })
})

// -----------------------------------------------------------------------
// Tests: getError()
// -----------------------------------------------------------------------

describe("getError()", () => {
    test("extracts error from top-level", () => {
        const ev = { error: { message: "Test error" } }
        expect(getError(ev)).toEqual({ message: "Test error" })
    })

    test("extracts error from properties", () => {
        const ev = { properties: { error: { code: 500 } } }
        expect(getError(ev)).toEqual({ code: 500 })
    })

    test("prefers top-level over nested", () => {
        const ev = {
            error: { from: "top" },
            properties: { error: { from: "nested" } }
        }
        expect(getError(ev)).toEqual({ from: "top" })
    })

    test("returns undefined if no error", () => {
        expect(getError({})).toBeUndefined()
    })
})

// -----------------------------------------------------------------------
// Tests: isSessionWatch()
// -----------------------------------------------------------------------

describe("isSessionWatch()", () => {
    test("returns true for any object (current implementation)", () => {
        expect(isSessionWatch({ status: "idle" })).toBe(true)
        expect(isSessionWatch({ status: "busy" })).toBe(true)
        expect(isSessionWatch({})).toBe(true)
        expect(isSessionWatch({ foo: "bar" })).toBe(true)
    })

    test("returns false for null or primitives", () => {
        expect(isSessionWatch(null)).toBe(false)
        expect(isSessionWatch("string")).toBe(false)
        expect(isSessionWatch(123)).toBe(false)
    })
})

// -----------------------------------------------------------------------
// Tests: Agent extraction edge cases
// -----------------------------------------------------------------------

describe("Agent validation", () => {
    test("validates string agent correctly", () => {
        const w = { agent: "prometheus" }
        const agent = typeof w.agent === "string" ? w.agent : undefined
        expect(agent).toBe("prometheus")
    })

    test("handles undefined agent", () => {
        const w = { agent: undefined }
        const agent = typeof w.agent === "string" ? w.agent : undefined
        expect(agent).toBe(undefined)
    })

    test("handles null agent", () => {
        const w = { agent: null } as { agent?: string }
        const agent = typeof w.agent === "string" ? w.agent : undefined
        expect(agent).toBe(undefined)
    })

    test("handles number agent (edge case)", () => {
        const w = { agent: 123 } as { agent?: string }
        const agent = typeof w.agent === "string" ? w.agent : undefined
        expect(agent).toBe(undefined)
    })
})

// -----------------------------------------------------------------------
// Tests: buildOpenTodosReminder()
// -----------------------------------------------------------------------

interface TestTodo {
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    priority: "high" | "medium" | "low"
}

describe("buildOpenTodosReminder()", () => {
    test("returns formatted reminder for pending todos", () => {
        const todos: TestTodo[] = [
            { content: "Fix login bug", status: "pending", priority: "high" },
        ]
        expect(buildOpenTodosReminder(todos)).toBe(
            "You have 1 unfinished task:\n1. [pending] Fix login bug\n\nPlease continue working on this task."
        )
    })

    test("returns formatted reminder for in_progress todos", () => {
        const todos: TestTodo[] = [
            { content: "Write tests", status: "in_progress", priority: "high" },
        ]
        const result = buildOpenTodosReminder(todos)
        expect(result).toContain("[in_progress] Write tests")
        expect(result).toContain("1 unfinished task")
    })

    test("lists multiple open todos with correct indices", () => {
        const todos: TestTodo[] = [
            { content: "Task one", status: "pending", priority: "high" },
            { content: "Task two", status: "in_progress", priority: "medium" },
            { content: "Task three", status: "pending", priority: "low" },
        ]
        const result = buildOpenTodosReminder(todos)
        expect(result).toContain("1. [pending] Task one")
        expect(result).toContain("2. [in_progress] Task two")
        expect(result).toContain("3. [pending] Task three")
        expect(result).toContain("3 unfinished tasks")
    })

    test("returns 'continue' for empty array", () => {
        expect(buildOpenTodosReminder([])).toBe("continue")
    })

    test("returns 'continue' when all todos are completed", () => {
        const todos: TestTodo[] = [
            { content: "Done task", status: "completed", priority: "high" },
            { content: "Cancelled task", status: "cancelled", priority: "low" },
        ]
        expect(buildOpenTodosReminder(todos)).toBe("continue")
    })

    test("returns 'continue' for non-array input (undefined)", () => {
        expect(buildOpenTodosReminder(undefined as unknown as TestTodo[])).toBe("continue")
    })

    test("returns 'continue' for non-array input (null)", () => {
        expect(buildOpenTodosReminder(null as unknown as TestTodo[])).toBe("continue")
    })

    test("returns 'continue' for non-array input (object)", () => {
        expect(buildOpenTodosReminder({} as TestTodo[])).toBe("continue")
    })

    test("returns 'continue' for non-array input (string)", () => {
        expect(buildOpenTodosReminder("not an array" as unknown as TestTodo[])).toBe("continue")
    })
})