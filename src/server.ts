// OpenCode v2 entrypoint for opencode-auto-resume.
//
// OpenCode 2.x loads plugins that export `{ id, setup(context) }` (the v2
// plugin API) and prefers the `./server` export of an npm plugin. The v1
// engine in `src/index.ts` expects the legacy `Plugin(ctx, options)` shape
// with v1 hooks (`event`, `config`, `tool`, `chat.message`,
// `tool.execute.before/after`, `command.execute.before`).
//
// This adapter bridges the two: it builds a v1-shaped `client` on top of the
// v2 plugin context, invokes the real v1 plugin with it, and re-registers the
// returned v1 hooks into the v2 domain API. The recovery engine itself is
// untouched — all stall/recovery logic keeps coming from `src/index.ts`, so
// v1 and v2 stay automatically in sync.
import { z } from "zod"
import AutoResumePlugin from "./index"

type LegacyEvent = { type: string; properties?: Record<string, any> }

// Translate v2 bus events into the v1 event names the engine's
// handleEvent() understands ({type, properties:{sessionID, ...}}).
function translateEvent(ev: any): LegacyEvent[] {
    const type: string = ev?.type ?? ""
    const data: Record<string, any> = ev?.data ?? {}
    const sid: string | undefined = data.sessionID
    const props = { ...data, sessionID: sid }

    switch (type) {
        case "session.execution.started":
            return [{ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } }]
        case "session.execution.succeeded":
            return [
                { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
                { type: "session.idle", properties: { sessionID: sid } },
            ]
        case "session.execution.failed":
            return [
                { type: "session.error", properties: { sessionID: sid, error: data.error } },
                { type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } },
            ]
        case "session.execution.interrupted":
            return [{ type: "session.interrupted", properties: { sessionID: sid } }]
        case "session.created":
            return [{ type: "session.created", properties: { sessionID: sid, parentID: data.parentID, session: data } }]
        case "session.updated":
        case "session.renamed":
            return [{ type: "session.updated", properties: { sessionID: sid } }]
        default:
            if (sid) return [{ type: "message.updated", properties: props }]
            return []
    }
}

export default {
    id: "opencode-auto-resume-v2",
    setup: async (context: any) => {
        const abort = new AbortController()

        // v1-shaped client bridged onto the v2 context.
        const bridgeClient = {
            app: {
                log: async ({ body }: any) => {
                    try {
                        console.error(`[auto-resume] ${body?.level ?? "info"}: ${body?.message ?? ""}`)
                    } catch {}
                },
            },
            session: {
                prompt: async (input: any) => {
                    const body = input?.body ?? {}
                    const text = Array.isArray(body.parts)
                        ? body.parts.map((p: any) => p?.text ?? "").join("")
                        : (body.text ?? "")
                    const req: any = { sessionID: input?.path?.id ?? input?.sessionID, text }
                    const agent = body.agent ?? body.agents?.[0]?.name
                    if (agent) req.agents = [{ name: agent }]
                    return await context.session.prompt(req)
                },
                abort: async (input: any) => context.session.interrupt({ sessionID: input?.path?.id ?? input?.sessionID }),
                interrupt: async (input: any) => context.session.interrupt({ sessionID: input?.path?.id ?? input?.sessionID }),
                messages: async (input: any) => ({ data: await context.session.context({ sessionID: input?.path?.id ?? input?.sessionID }) }),
                context: async (input: any) => ({ data: await context.session.context({ sessionID: input?.path?.id ?? input?.sessionID }) }),
                status: async () => ({ data: {} }),
                list: async () => ({ data: [] }),
                todo: async () => ({ data: [] }),
                summarize: async () => undefined,
                command: async (input: any) =>
                    context.session.command({
                        sessionID: input?.path?.id ?? input?.sessionID,
                        command: input?.body?.command ?? "",
                        text: input?.body?.arguments ?? input?.body?.text ?? "",
                    }),
            },
            config: { get: async () => ({ data: {} }) },
            provider: { get: async () => ({ data: {} }) },
        }

        const legacyCtx = {
            client: bridgeClient,
            app: {},
            directory: context.location?.directory ?? process.cwd(),
            worktree: context.location?.directory ?? process.cwd(),
            serverUrl: undefined,
            $: undefined,
        }

        let hooks: any
        try {
            hooks = await (AutoResumePlugin as any)(legacyCtx, context.options ?? {})
        } catch (e) {
            console.error("[auto-resume-v2] construction failed:", e)
            return () => {}
        }

        try {
            await hooks?.config?.()
        } catch {}

        // v1 tool definitions -> v2 tool registry.
        if (hooks?.tool) {
            try {
                await context.tool.transform((draft: any) => {
                    for (const [name, def] of Object.entries<any>(hooks.tool)) {
                        let input: any
                        try {
                            input = z.toJSONSchema(z.object(def.args ?? {}))
                        } catch {
                            input = { type: "object", properties: {}, additionalProperties: true }
                        }
                        draft.add({
                            name,
                            description: def.description,
                            input,
                            execute: async (args: any, toolContext: any) => {
                                try {
                                    const r = await def.execute(args, { sessionID: toolContext?.sessionID })
                                    return { content: typeof r === "string" ? r : "" }
                                } catch (e) {
                                    return { content: `auto-resume tool error: ${String((e as any)?.message ?? e)}` }
                                }
                            },
                        })
                    }
                })
            } catch (e) {
                console.error("[auto-resume-v2] tool registration failed:", e)
            }
        }

        if (hooks?.["chat.message"]) {
            try {
                await context.session.hook("prompt", (input: any) => hooks["chat.message"]({ sessionID: input?.sessionID }))
            } catch (e) {
                console.error("[auto-resume-v2] prompt hook failed:", e)
            }
        }

        if (hooks?.["tool.execute.before"]) {
            try {
                await context.tool.hook("execute.before", (input: any) =>
                    hooks["tool.execute.before"]({ sessionID: input?.sessionID, tool: input?.tool, args: input?.input }, { args: input?.input }),
                )
            } catch (e) {
                console.error("[auto-resume-v2] tool.execute.before hook failed:", e)
            }
        }

        if (hooks?.["tool.execute.after"]) {
            try {
                await context.tool.hook("execute.after", (input: any) =>
                    hooks["tool.execute.after"]({ sessionID: input?.sessionID }),
                )
            } catch (e) {
                console.error("[auto-resume-v2] tool.execute.after hook failed:", e)
            }
        }

        if (hooks?.["command.execute.before"]) {
            try {
                const commandDomain = context.command ?? (context as any).commands
                if (typeof commandDomain?.hook === "function") {
                    await commandDomain.hook("execute.before", (input: any) =>
                        hooks["command.execute.before"]({ sessionID: input?.sessionID, command: input?.command }),
                    )
                } else {
                    console.error("[auto-resume-v2] command.execute.before: no command domain in this OpenCode build; skipping")
                }
            } catch (e) {
                console.error("[auto-resume-v2] command.execute.before hook failed:", e)
            }
        }

        // Feed translated v2 events into the v1 engine's event hook.
        ;(async () => {
            try {
                const sub: any = context.event.subscribe({ signal: abort.signal })
                const it = sub[Symbol.asyncIterator]()
                while (true) {
                    const { done, value } = await it.next()
                    if (done) break
                    let ev = value
                    if (typeof ev === "string") {
                        try {
                            ev = JSON.parse(ev)
                        } catch {
                            continue
                        }
                    }
                    for (const legacyEvent of translateEvent(ev)) {
                        try {
                            await hooks?.event?.({ event: legacyEvent })
                        } catch (e) {
                            console.error("[auto-resume-v2] event handling failed:", e)
                        }
                    }
                }
            } catch (e) {
                if (!abort.signal.aborted) console.error("[auto-resume-v2] event loop stopped:", e)
            }
        })()

        return () => {
            abort.abort()
        }
    },
}
