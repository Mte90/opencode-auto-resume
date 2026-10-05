// V2 wrapper for opencode-auto-resume
// This provides OpenCode v2 compatibility by adapting the V1 plugin factory
// to the V2 { id, setup } plugin schema.

import { Database } from "bun:sqlite";
import { AutoResumePlugin } from "./index.js";

const V1_OPTIONS_DEFAULTS = {
  chunkTimeoutMs: 180_000,
  gracePeriodMs: 3_000,
  maxRetries: 3,
  debug: false,
  subagentWaitMs: 60_000,
  loopMaxContinues: 3,
  loopWindowMs: 10 * 60_000,
  contextSaturationThreshold: 0.85,
  subagentNativeCompactionEnabled: false,
  activeUserWindowMs: 5 * 60_000,
  continuePrompt: "continue",
  streamingFailureErrorNames: [
    "ProviderError",
    "APIError",
    "StreamError",
    "ConnectionError",
    "TimeoutError",
  ],
  streamingFailureMessagePatterns: [
    "streaming response failed",
    "stream.*fail",
    "connection.*reset",
    "connection.*closed",
    "aborted due to timeout",
  ],
  resumeOnActionIntent: true,
  actionIntentPrompt: "continue",
  toolTextRecoveryPrompt:
    "Your last message contained a raw tool call printed as text instead of being executed. " +
    "Please use the proper tool calling mechanism to execute it.",
  thinkingToolRecoveryPrompt:
    "I noticed you have a tool call generated in your thinking/reasoning. " +
    "Please execute it using the proper tool calling mechanism instead of keeping it in reasoning.",
  doneWithoutWorkPrompt:
    "I need you to verify more carefully that you have actually completed all the required tasks. " +
    "Your response indicated you're done, but no work was detected. Please check your todo list " +
    "and complete any remaining work.",
  doneWithoutDetailsPrompt:
    "Your last response claimed the task is complete but contained no work description. This is not acceptable. " +
    "You MUST respond now with a full, detailed report of everything you did: " +
    "for each file you modified, state the full path and the exact changes; " +
    "list every command you ran to verify and its result; state the final outcome. " +
    "Do NOT reply with 'done', 'task completed', or any short acknowledgment — " +
    "your ONLY acceptable response right now is this detailed report. Write it now.",
  silentDeadStreamMinTokens: 200,
  busyStallStrategy: "continue",
  toolTextCheckDelayMs: 3_000,
  maxRecoveryRetries: 2,
  minActivityGapMs: 1_000,
  warmupMs: 15_000,
  discoveryDelayMs: 5_000,
};

function makeV1Context(ctx, options) {
  const { session, tool, event, provider, command, model, storage, location, app, generate, rpc, permission, skill, shell, websearch, vcs, worktree, integration, mcp, aisdk, agent, experimental } = ctx;

  const log = async (level, message) => {
    const msg = `[auto-resume] ${message}`;
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](msg);
    try { if (rpc && typeof rpc.call === "function") { await rpc.call({ rpcID: "opencode", method: "log", input: { level, message: msg } }); } } catch {}
    return;
  };

  const dbg = options.debug ? log.bind(null, "debug") : () => {};
  const short = (sid) => sid && typeof sid === "string" ? sid.slice(0, 12) : String(sid);

  async function getSessionMessages(sid) {
    try {
      const msgs = await session.context({ sessionID: sid });
      return Array.isArray(msgs) ? msgs : [];
    } catch (e) {
      await log("warn", `Failed to fetch messages for ${short(sid)}: ${e.message}`);
      return [];
    }
  }

  async function promptSession(sid, text, agent, model) {
    try {
      return await session.prompt({
        sessionID: sid,
        text: String(text),
        agent,
        model,
      });
    } catch (e) {
      await log("warn", `prompt failed for ${short(sid)}: ${e.message}`);
      throw e;
    }
  }

  async function abortSession(sid) {
    try {
      return await session.interrupt({ sessionID: sid, resume: false });
    } catch (e) {
      await log("warn", `interrupt failed for ${short(sid)}: ${e.message}`);
      throw e;
    }
  }

  async function getSessionStatusMap() {
    try {
      return {};
    } catch (e) {
      await log("warn", `session status map error: ${e.message}`);
      return {};
    }
  }

  async function getSessionTodos(sid) {
    return [];
  }

  async function summarizeSession(sid) {
    try {
      return await session.command({ sessionID: sid, name: "compact" });
    } catch (e) {
      await log("warn", `compact failed for ${short(sid)}: ${e.message}`);
      throw e;
    }
  }

  async function discoverSessions() {
    try {
      const db = new Database("/data/data/com.termux/files/home/.local/share/opencode/opencode.db", { readonly: true });
      const rows = db.query("SELECT id, directory, project_id as project, '' as status, time_created as created_at FROM session_v2 ORDER BY time_created DESC LIMIT 100").all();
      db.close();
      return rows.map(r => ({ id: r.id, directory: r.directory, project: r.project, status: r.status, created_at: r.created_at }));
    } catch (e) {
      await log("warn", `session list via sqlite error: ${e.message}`);
      return [];
    }
  }

  async function getAvailableToolIds() {
    try {
      const tools = await tool.list();
      return Array.isArray(tools) ? tools.map(t => t.id).filter(Boolean) : [];
    } catch (e) {
      await log("warn", `tool.list error: ${e.message}`);
      return [];
    }
  }

  const appLog = async (input) => {
    const { body } = input || {};
    if (body && body.message) {
      await log(body.level || "info", body.message);
    }
  };

  async function getProviderInfo(providerID) {
    try {
      const providers = await provider.list();
      const data = Array.isArray(providers) ? providers : (providers?.data || []);
      return data.find(p => p.id === providerID) || null;
    } catch (e) {
      await log("warn", `provider.get error: ${e.message}`);
      return null;
    }
  }

  async function getConfig() {
    return {
      plugin: [],
      agent: [],
      model: [],
      provider: [],
      mcp: [],
      experimental: {},
    };
  }

  const eventSubscribe = (opts = {}) => {
    try {
      const iterable = event.subscribe(opts.signal ? { signal: opts.signal } : {});
      return iterable;
    } catch (e) {
      dbg(`event.subscribe error: ${e.message}`);
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true, value: null })
          };
        }
      };
    }
  };

  const v1ctx = {
    direction: "incoming",
    sessionID: null,
    async: (p) => p,

    client: {
      app: { log: appLog },
      session: {
        prompt: ({ path, body }) => promptSession(path?.id, body?.parts?.[0]?.text || body?.text, body?.agent, body?.model),
        messages: ({ path }) => getSessionMessages(path?.id),
        abort: ({ path }) => abortSession(path?.id),
        status: () => getSessionStatusMap(),
        todo: ({ path }) => getSessionTodos(path?.id),
        summarize: ({ path }) => summarizeSession(path?.id),
        list: discoverSessions,
        command: ({ path, body }) => session.command({ sessionID: path?.id, name: body?.command, text: body?.arguments }),
      },
      tool: {
        ids: getAvailableToolIds,
      },
      provider: {
        get: () => ({ data: getProviderInfo() }),
      },
      config: {
        get: getConfig,
      },
    },

    event: {
      subscribe: (opts) => eventSubscribe(opts),
    },

    directory: location?.directory,
    skipChecks: false,
    seen: new Set(),
    jitless: false,
  };

  return v1ctx;
}

export default {
  id: "opencode-auto-resume",
  async setup(ctx) {
    const options = { ...V1_OPTIONS_DEFAULTS, ...(ctx.options || {}) };
    console.log(`[auto-resume] V2 wrapper starting with options:`, JSON.stringify(options));

    const v1ctx = makeV1Context(ctx, options);
    let hooks;
    try {
      hooks = await AutoResumePlugin(v1ctx, options);
      console.log("[auto-resume] V1 plugin initialized, hooks:", Object.keys(hooks || {}));
    } catch (e) {
      console.error("[auto-resume] V1 plugin initialization failed:", e.message);
      return;
    }

    if (!hooks || typeof hooks !== "object") {
      console.warn("[auto-resume] V1 plugin returned no hooks object");
      return;
    }

    const registrations = [];

    if (typeof hooks["tool.execute.before"] === "function") {
      try {
        const reg = await ctx.tool.hook("execute.before", async (ev) => {
          const input = {
            tool: ev.tool,
            args: ev.input,
            sessionID: ev.sessionID,
          };
          return hooks["tool.execute.before"](input, undefined);
        });
        registrations.push(reg);
        console.log("[auto-resume] registered tool.execute.before");
      } catch (e) {
        console.error("[auto-resume] tool.execute.before hook failed:", e.message);
      }
    }

    if (typeof hooks["tool.execute.after"] === "function") {
      try {
        const reg = await ctx.tool.hook("execute.after", async (ev) => {
          const input = {
            tool: ev.tool,
            args: ev.input,
            sessionID: ev.sessionID,
          };
          return hooks["tool.execute.after"](input);
        });
        registrations.push(reg);
        console.log("[auto-resume] registered tool.execute.after");
      } catch (e) {
        console.error("[auto-resume] tool.execute.after hook failed:", e.message);
      }
    }

    if (typeof hooks["chat.message"] === "function") {
      try {
        const reg = await ctx.session.hook("prompt", async (ev) => {
          const input = { sessionID: ev.sessionID };
          return hooks["chat.message"](input);
        });
        registrations.push(reg);
        console.log("[auto-resume] registered chat.message (as session.hook prompt)");
      } catch (e) {
        console.error("[auto-resume] chat.message hook failed:", e.message);
      }
    }

    if (typeof hooks["command.execute.before"] === "function") {
      console.log("[auto-resume] command.execute.before skipped (no V2 equivalent)");
    }

    if (typeof hooks.event === "function") {
      try {
        const iterable = ctx.event.subscribe();
        (async () => {
          try {
            for await (const event of iterable) {
              await hooks.event({ event });
            }
          } catch (e) {
            console.error("[auto-resume] event loop error:", e.message);
          }
        })();
        console.log("[auto-resume] event subscription started");
      } catch (e) {
        console.error("[auto-resume] event subscribe failed:", e.message);
      }
    }

    if (typeof hooks.config === "function") {
      try {
        await hooks.config();
        console.log("[auto-resume] config handler executed");
      } catch (e) {
        console.error("[auto-resume] config handler error:", e.message);
      }
    }

    return async () => {
      console.log("[auto-resume] cleaning up...");
      for (const reg of registrations) {
        try { await reg.dispose(); } catch {}
      }
    };
  },
};