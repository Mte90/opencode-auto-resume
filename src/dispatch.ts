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
import pkg from "../package.json"

const PLUGIN_VERSION = pkg.version
const noopDispose = () => {}

// The service-only setup() context proves nothing on its own: 1.19.x hosts
// run it in the same process as the server() loader, so the dispatcher only
// speaks when the check window closes without any server() activation — the
// one case where auto-resume is genuinely not running. The 5s window covers
// loader-order differences; both calls land in the same plugin-load phase on
// verified 1.19.4/1.19.5 hosts.
const INERT_SETUP_CHECK_MS = 5000
let v1LoaderRan = false

const runV1 = (input: any, options: any) => {
    v1LoaderRan = true
    return AutoResumePlugin(input, options)
}

// opencode 1.19.5+ runs two plugin loaders: the legacy `server()` loader and the
// v2 config-plugin `setup()` loader. The setup context carries only service
// domains (no event stream, no client), so auto-resume cannot run there; the
// v1 copy loaded through `server()` stays active.
const isV2ServiceContext = (ctx: any): boolean =>
    typeof ctx?.plugin?.add === "function" &&
    typeof ctx?.agent?.transform === "function" &&
    typeof ctx?.skill?.transform === "function"

const dispatcher = {
    id: "auto-resume.v2",
    server: runV1,
    setup: async (ctx: any) => {
        if (ctx?.app?.version) return v2.setup(ctx)
        if (typeof ctx?.event?.subscribe === "function") {
            // v2-shaped host without app metadata: the v2 build's guard
            // warns and aborts inertly.
            return v2.setup(ctx)
        }
        if (ctx?.serverUrl || ctx?.client?.session) {
            return runV1(ctx, ctx.options)
        }
        if (isV2ServiceContext(ctx)) {
            const timer = setTimeout(() => {
                if (v1LoaderRan) return
                console.warn(`[auto-resume v${PLUGIN_VERSION}] the host provided only the v2 config-plugin service context and no server() loader ran — auto-resume is NOT active on this host. See the README on npm (opencode-auto-resume).`)
            }, INERT_SETUP_CHECK_MS)
            timer.unref?.()
            return () => clearTimeout(timer)
        }
        console.warn(`[auto-resume v${PLUGIN_VERSION}] unrecognised host context — no ctx.app.version (opencode v2), no ctx.event.subscribe (v2 loader), no ctx.serverUrl/client (opencode v1). Plugin disabled; see the README on npm (opencode-auto-resume).`)
        return noopDispose
    },
}
export default dispatcher
