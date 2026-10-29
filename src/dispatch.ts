/**
 * Dual-shape plugin entry for universal opencode v1/v2 compatibility.
 *
 * opencode v1's loader takes `default.server(input, options)` (readV1Plugin
 * phase 1); opencode v2's loader takes `default.setup(context)` (the promise
 * Plugin branch). One object serves both hosts — each loader calls its own
 * branch, so no version probing is needed for selection. The mismatch guards
 * inside each build stay as the safety net for hosts that behave differently.
 */

import { AutoResumePlugin } from "./index"
import v2 from "./v2/index"

const dispatcher = {
    id: "auto-resume.v2",
    server: AutoResumePlugin,
    setup: v2.setup,
}
export default dispatcher
