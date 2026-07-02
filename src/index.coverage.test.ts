import { describe, test, expect } from "bun:test"

describe("Tool Text Patterns Coverage", () => {
    const patterns = [
        /<function=/i,
        /<invoke/i,
        /<tool_call/i,
        /<parameter/i,
        /{"type":/i,
        /{"name":/i,
    ]

    test("matches function tag", () => {
        expect(patterns.some(p => p.test("<function=edit"))).toBe(true)
    })

    test("matches invoke tag", () => {
        expect(patterns.some(p => p.test("<invoke name=test"))).toBe(true)
    })

    test("matches tool_call tag", () => {
        expect(patterns.some(p => p.test("<tool_call>"))).toBe(true)
    })

    test("matches parameter tag", () => {
        expect(patterns.some(p => p.test("<parameter name=test"))).toBe(true)
    })

    test("matches type JSON", () => {
        expect(patterns.some(p => p.test("{\"type\":\"function\""))).toBe(true)
    })

    test("matches name JSON", () => {
        expect(patterns.some(p => p.test("{\"name\":\"edit\""))).toBe(true)
    })
})
