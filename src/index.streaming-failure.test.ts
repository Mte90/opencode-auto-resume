import { describe, test, expect } from "bun:test"
import { isStreamingFailure } from "./index"

describe("isStreamingFailure()", () => {
    // Acceptance criteria
    test("ProviderError with streaming response failed → true", () => {
        expect(isStreamingFailure("ProviderError", "Streaming response failed")).toBe(true)
    })

    test("MessageAbortedError with empty message → false", () => {
        expect(isStreamingFailure("MessageAbortedError", "")).toBe(false)
    })

    test("TimeoutError with stream timed out → true", () => {
        expect(isStreamingFailure("TimeoutError", "Stream timed out")).toBe(true)
    })

    test("UnknownError with something else → false", () => {
        expect(isStreamingFailure("UnknownError", "Something else")).toBe(false)
    })

    // Error name patterns (default)
    test("APIError matches default names", () => {
        expect(isStreamingFailure("APIError", "")).toBe(true)
    })

    test("StreamError matches default names", () => {
        expect(isStreamingFailure("StreamError", "")).toBe(true)
    })

    test("ConnectionError matches default names", () => {
        expect(isStreamingFailure("ConnectionError", "")).toBe(true)
    })

    test("TimeoutError matches default names", () => {
        expect(isStreamingFailure("TimeoutError", "")).toBe(true)
    })

    // Message patterns (default, case-insensitive)
    test("streaming response failed (exact) → true", () => {
        expect(isStreamingFailure("AnyError", "streaming response failed")).toBe(true)
    })

    test("Stream fail anywhere in message → true", () => {
        expect(isStreamingFailure("AnyError", "The stream operation failed")).toBe(true)
    })

    test("Connection reset → true", () => {
        expect(isStreamingFailure("AnyError", "Connection was reset by peer")).toBe(true)
    })

    test("Connection closed → true", () => {
        expect(isStreamingFailure("AnyError", "Connection closed unexpectedly")).toBe(true)
    })

    // Case insensitivity
    test("STREAMING RESPONSE FAILED (uppercase) → true", () => {
        expect(isStreamingFailure("AnyError", "STREAMING RESPONSE FAILED")).toBe(true)
    })

    test("Stream Fail (mixed case) → true", () => {
        expect(isStreamingFailure("AnyError", "Stream Fail")).toBe(true)
    })

    // Negative cases
    test("ProviderError with unrelated message → true (name matches)", () => {
        expect(isStreamingFailure("ProviderError", "Rate limited")).toBe(true)
    })

    test("Non-streaming error name + non-streaming message → false", () => {
        expect(isStreamingFailure("ValidationError", "Invalid input")).toBe(false)
    })

    test("Both non-matching with custom config → false", () => {
        expect(isStreamingFailure("OtherError", "unrelated", ["CustomError"], ["boom"])).toBe(false)
    })

    // Edge cases
    test("Empty error name and message → false", () => {
        expect(isStreamingFailure("", "")).toBe(false)
    })

    test("Only error name, empty message → matches name patterns", () => {
        expect(isStreamingFailure("ProviderError", "")).toBe(true)
        expect(isStreamingFailure("OtherError", "")).toBe(false)
    })

    test("Only message, empty error name → matches message patterns", () => {
        expect(isStreamingFailure("", "stream failed")).toBe(true)
        expect(isStreamingFailure("", "unrelated")).toBe(false)
    })

    test("Invalid regex pattern falls back to substring matching", () => {
        expect(isStreamingFailure("Error", "stream[failed", ["OtherError"], ["stream[failed"])).toBe(true)
        expect(isStreamingFailure("Error", "unrelated", ["OtherError"], ["stream[failed"])).toBe(false)
    })

    test("Error name matching is exact and case-sensitive", () => {
        expect(isStreamingFailure("providererror", "")).toBe(false)
        expect(isStreamingFailure("PROVIDERERROR", "")).toBe(false)
        expect(isStreamingFailure("ProviderError", "")).toBe(true)
    })

    test("Null/undefined inputs → false without crashing", () => {
        expect(isStreamingFailure(null as unknown as string, null as unknown as string)).toBe(false)
        expect(isStreamingFailure(undefined as unknown as string, undefined as unknown as string)).toBe(false)
    })

    test("Null error name with matching message → matches message patterns", () => {
        expect(isStreamingFailure(null as unknown as string, "stream failed")).toBe(true)
    })

    test("Null message with matching error name → matches name patterns", () => {
        expect(isStreamingFailure("ProviderError", null as unknown as string)).toBe(true)
        expect(isStreamingFailure("OtherError", null as unknown as string)).toBe(false)
    })

    // Configurability (acceptance criteria 5 & 6)
    test("custom error names override defaults", () => {
        expect(isStreamingFailure("CustomError", "", ["CustomError"])).toBe(true)
        expect(isStreamingFailure("ProviderError", "", ["CustomError"])).toBe(false)
    })

    test("empty error names disables name matching", () => {
        expect(isStreamingFailure("ProviderError", "", [])).toBe(false)
    })

    test("custom message patterns override defaults", () => {
        expect(isStreamingFailure("AnyError", "boom happened", [], ["boom"])).toBe(true)
        expect(isStreamingFailure("AnyError", "fine", [], ["boom"])).toBe(false)
    })

    test("empty message patterns disables message matching", () => {
        expect(isStreamingFailure("AnyError", "streaming response failed", [], [])).toBe(false)
    })
})
