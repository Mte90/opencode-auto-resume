/**
 * Dual-shape plugin entry for universal opencode v1/v2 compatibility.
 *
 * opencode v1's loader takes `default.server(input, options)` (readV1Plugin
 * phase 1); opencode v2's loader takes `default.setup(context)` (the promise
 * Plugin branch). One object serves both hosts — each loader calls its own
 * branch.
 *
 * For setup()-style hosts the call itself carries no era signal, so selection
 * falls back to context shape (verified contracts):
 *   ctx.app.version       — v2 host metadata
 *   ctx.event.subscribe   — v2 loader shape (present, only app missing)
 *   ctx.serverUrl/client  — v1 PluginInput (serverUrl required per
 *                           @opencode-ai/plugin 1.x types)
 * A ctx matching none of these gets one diagnostic and an inert dispose
 * rather than a crash deep inside a build built for another era.
 */

import { AutoResumePlugin } from "./index"
import v2 from "./v2/index"

const noopDispose = () => {}

const dispatcher = {
    id: "auto-resume.v2",
    server: AutoResumePlugin,
    setup: async (ctx: any) => {
        if (ctx?.app?.version) return v2.setup(ctx)
        if (typeof ctx?.event?.subscribe === "function") {
            // v2-shaped host without app metadata: the v2 build's guard
            // warns and aborts inertly.
            return v2.setup(ctx)
        }
        if (ctx?.serverUrl || ctx?.client?.session) {
            return AutoResumePlugin(ctx, ctx.options)
        }
        console.warn("[auto-resume] unrecognised host context — no ctx.app.version (opencode v2), no ctx.event.subscribe (v2 loader), no ctx.serverUrl/client (opencode v1). Plugin disabled; see the README on npm (opencode-auto-resume).")
        return noopDispose
    },
}
export default dispatcher
