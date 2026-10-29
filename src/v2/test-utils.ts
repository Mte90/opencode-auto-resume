/**
 * Shared test helper for capturing plugin console output.
 *
 * Replaces file-based log assertions with console spy capture.
 * Used by: index.options.test.ts, index.log-path.test.ts, dispatch.test.ts
 */

type LogCapture = {
	/** All captured lines (console.log + console.error + console.warn) */
	lines: string[]
	/** Lines captured via console.error */
	errors: string[]
	/** Lines captured via console.warn */
	warns: string[]
	/** Debug lines (those with [auto-resume:debug] prefix) */
	debug: string[]
	/** Stop the capture and restore original console methods */
	stop: () => void
}

/**
 * Capture all plugin console output.
 *
 * Returns an object with captured lines and a stop() method to restore console.
 * Example:
 *   const capture = capturePluginLogs()
 *   // ... run plugin ...
 *   capture.stop()
 *   expect(capture.errors).toContain(expect.stringContaining("[auto-resume]"))
 */
export function capturePluginLogs(): LogCapture {
	const lines: string[] = []
	const errors: string[] = []
	const warns: string[] = []
	const debug: string[] = []

	const originalLog = console.log
	const originalError = console.error
	const originalWarn = console.warn

	console.log = (...args: unknown[]) => {
		const line = args.map((a) => String(a)).join(" ")
		lines.push(line)
		if (line.includes("[auto-resume:debug]")) {
			debug.push(line)
		}
		// Don't call original - we're capturing, not forwarding
	}

	console.error = (...args: unknown[]) => {
		const line = args.map((a) => String(a)).join(" ")
		lines.push(line)
		errors.push(line)
	}

	console.warn = (...args: unknown[]) => {
		const line = args.map((a) => String(a)).join(" ")
		lines.push(line)
		warns.push(line)
	}

	return {
		lines,
		errors,
		warns,
		debug,
		stop: () => {
			console.log = originalLog
			console.error = originalError
			console.warn = originalWarn
		},
	}
}
