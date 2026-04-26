import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";
const PLUGIN_VERSION = "1.3-probe";

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skill",
  description:
    "Captures user input, agent plans, skill invocations and tool calls into logs",

  register(api) {
    log("plugin", `memory2skill registered v${PLUGIN_VERSION}`, {
      mode: api.registrationMode,
    });

    // Probe 1: inspect api.runtime
    try {
      const rtKeys: Record<string, string> = {};
      if (api.runtime) {
        for (const key of Object.getOwnPropertyNames(api.runtime)) {
          rtKeys[key] = typeof (api.runtime as any)[key];
        }
        const proto = Object.getPrototypeOf(api.runtime);
        if (proto && proto !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            rtKeys[`proto.${key}`] = typeof (proto as any)[key];
          }
        }
      }
      log("probe_runtime", "api.runtime members", rtKeys);
    } catch (e: any) {
      log("probe_runtime_err", e.message);
    }

    // Probe 2: inspect api.logger
    try {
      const loggerKeys: Record<string, string> = {};
      if (api.logger) {
        for (const key of Object.getOwnPropertyNames(api.logger)) {
          loggerKeys[key] = typeof (api.logger as any)[key];
        }
        const proto = Object.getPrototypeOf(api.logger);
        if (proto && proto !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            loggerKeys[`proto.${key}`] = typeof (proto as any)[key];
          }
        }
      }
      log("probe_logger", "api.logger members", loggerKeys);
    } catch (e: any) {
      log("probe_logger_err", e.message);
    }

    // Probe 3: wrap api.on with a proxy to see if anything calls it internally
    const origOn = api.on.bind(api);
    (api as any).on = (...args: any[]) => {
      log("probe_on_called", "api.on was called", {
        args: args.map((a) => (typeof a === "function" ? "[fn]" : a)),
      });
      return origOn(...args);
    };

    // Probe 4: try registerHook with various shapes
    try {
      api.registerHook({
        name: "mem2skill_hook",
        event: "message",
        handler: (...args: any[]) => {
          log("hook_message", "registerHook message fired", {
            args: args.map((a) =>
              typeof a === "function" ? "[fn]" : JSON.stringify(a)?.slice(0, 500)
            ),
          });
        },
      });
      log("probe_hook", "registerHook({event:'message'}) accepted");
    } catch (e: any) {
      log("probe_hook_err", `registerHook message failed: ${e.message}`);
    }

    try {
      api.registerHook({
        name: "mem2skill_hook_tool",
        event: "tool_call",
        handler: (...args: any[]) => {
          log("hook_tool", "registerHook tool_call fired", {
            args: args.map((a) =>
              typeof a === "function" ? "[fn]" : JSON.stringify(a)?.slice(0, 500)
            ),
          });
        },
      });
      log("probe_hook", "registerHook({event:'tool_call'}) accepted");
    } catch (e: any) {
      log("probe_hook_err", `registerHook tool_call failed: ${e.message}`);
    }

    // Probe 5: try registerTextTransforms
    try {
      api.registerTextTransforms({
        name: "mem2skill_prefix",
        description: "Prepends greeting to user input",
        transformUserMessage(text: string) {
          const transformed = `${DEFAULT_PREFIX} ${text}`;
          log("text_transform", "transformUserMessage fired", {
            original: text,
            transformed,
          });
          return transformed;
        },
      });
      log("probe_textTransforms", "registerTextTransforms accepted");
    } catch (e: any) {
      log("probe_textTransforms_err", `registerTextTransforms failed: ${e.message}`);
    }

    // Probe 6: try api.on with many possible event names
    const eventNames = [
      "message", "userMessage", "user_message", "user-message",
      "tool", "toolCall", "tool_call", "tool-call",
      "toolResult", "tool_result", "tool-result",
      "plan", "agentPlan", "agent_plan", "agent-plan",
      "skill", "skillInvoke", "skill_invoke", "skill-invoke",
      "response", "assistantMessage", "assistant_message",
      "task", "taskStart", "task_start", "taskEnd", "task_end",
      "conversation", "turn", "request", "completion",
    ];
    for (const name of eventNames) {
      try {
        origOn(name, (...args: any[]) => {
          log(`event_${name}`, `Event '${name}' fired`, {
            argTypes: args.map((a) => typeof a),
            preview: args.map((a) =>
              typeof a === "function"
                ? "[fn]"
                : JSON.stringify(a)?.slice(0, 300)
            ),
          });
        });
      } catch (e: any) {
        log("probe_on_err", `api.on('${name}') failed: ${e.message}`);
      }
    }
    log("probe_events", "Registered listeners for all candidate event names");
  },
});
