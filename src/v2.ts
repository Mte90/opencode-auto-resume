/**
 * V2 shim for opencode-auto-resume (Mte90) — the upstream plugin exports a V1
 * function that OpenCode 2 rejects ("must export a default definition with an
 * id and a setup function").
 *
 * This shim default-exports a V2 { id, setup } plugin, instantiates the V1
 * implementation with a synthesized OpenCodeClient (V2 Context has no
 * `client` field), and bridges the returned V1 hooks onto V2 APIs:
 *   - tool.execute.before/after -> ctx.tool.hook("execute.before"/"execute.after")
 *   - event + chat.message      -> ctx.event.subscribe() pump
 *   - tool.task_complete        -> ctx.tool.transform (direct tool)
 *   - config                    -> V1-only, skipped
 */
import { AutoResumePlugin } from "./index";

let clientPromise: Promise<any> | undefined;

async function getClient(): Promise<any> {
	if (!clientPromise) {
		clientPromise = (async () => {
			try {
				const mod: any = await import("@opencode/client");
				const create =
					mod.createOpencodeClient ?? mod.default?.createOpencodeClient;
				if (typeof create === "function") {
					// The client performs local service discovery on its own.
					return await create();
				}
			} catch {}
			return undefined;
		})();
	}
	return clientPromise;
}

export async function setup(ctx: any) {
		const client = (ctx as any).client ?? (await getClient());
		const hooks: any = await AutoResumePlugin({ ...(ctx as any), client }, undefined);

		await ctx.tool.hook("execute.before", (ev: any) =>
			hooks["tool.execute.before"]?.(
				{ sessionID: ev.sessionID, tool: ev.tool, args: ev.input },
				{ args: ev.input },
			),
		);

		await ctx.tool.hook("execute.after", (ev: any) =>
			hooks["tool.execute.after"]?.({ sessionID: ev.sessionID, tool: ev.tool }),
		);

		const tc = hooks.tool?.task_complete;
		if (tc) {
			await ctx.tool.transform((editor: any) => {
				editor.add({
					name: "task_complete",
					description:
						tc.description ??
						"Signal that the current task is fully complete.",
					input: { type: "object", properties: {}, additionalProperties: false },
					async execute(input: any) {
						try {
							const out = await tc.execute(input ?? {});
							return {
								content:
									typeof out === "string" ? out : JSON.stringify(out ?? ""),
							};
						} catch (e) {
							return { content: `task_complete error: ${String(e)}` };
						}
					},
				});
			});
		}

		const consume = async () => {
			try {
				for await (const ev of ctx.event.subscribe() as any) {
					try {
						if (ev?.type === "chat.message") {
							const sid =
								ev.properties?.info?.sessionID ??
								ev.properties?.sessionID ??
								ev.properties?.message?.sessionID;
							if (sid) await hooks["chat.message"]?.({ sessionID: sid });
						}
						// V1 event hook receives the raw bus event; V1/V2 share the
						// { type, properties } shape.
						await hooks.event?.({ event: ev });
					} catch {}
				}
			} catch (e) {
				try {
					await client?.app?.log?.({
						body: {
							service: "auto-resume-shim",
							level: "error",
							message: `event pump died: ${String(e)}`,
						},
					});
				} catch {}
			}
		};
		consume();

		// V1-only: config hook and command.execute.before have no V2 equivalent.
		return () => {};
}
