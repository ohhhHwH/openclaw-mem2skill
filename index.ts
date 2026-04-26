import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";
const PLUGIN_VERSION = "1.4";

function safeStr(val: any): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val.slice(0, 1000);
  try {
    return JSON.stringify(val).slice(0, 1000);
  } catch {
    return String(val).slice(0, 1000);
  }
}

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skill",
  description:
    "Captures user input, agent plans, skill invocations and tool calls into logs",

  register(api) {
    log("plugin", `memory2skill v${PLUGIN_VERSION} registered`, {
      mode: api.registrationMode,
    });

    // --- Probe: api.runtime.events members ---
    try {
      const evKeys: Record<string, string> = {};
      const ev = (api.runtime as any).events;
      if (ev) {
        for (const k of Object.getOwnPropertyNames(ev)) {
          evKeys[k] = typeof ev[k];
        }
        const proto = Object.getPrototypeOf(ev);
        if (proto && proto !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(proto)) {
            evKeys[`proto.${k}`] = typeof proto[k];
          }
        }
      }
      log("probe_events_obj", "api.runtime.events members", evKeys);
    } catch (e: any) {
      log("probe_events_obj_err", e.message);
    }

    // --- Hook: message_received (user input) ---
    try {
      api.on("message_received", (event: any) => {
        const content =
          typeof event === "string"
            ? event
            : event?.text ?? event?.content ?? event?.message ?? safeStr(event);
        const transformed = `${DEFAULT_PREFIX} ${content}`;
        log("user_input", "message_received", {
          original: content,
          transformed,
          taskId: event?.taskId,
          threadId: event?.threadId,
          role: event?.role,
        });
      });
      log("hook_reg", "api.on('message_received') OK");
    } catch (e: any) {
      log("hook_reg_err", `message_received: ${e.message}`);
    }

    // --- Hook: message_sending (assistant output) ---
    try {
      api.on("message_sending", (event: any) => {
        log("assistant_msg", "message_sending", {
          content: safeStr(event?.text ?? event?.content ?? event?.message ?? event),
          taskId: event?.taskId,
          threadId: event?.threadId,
        });
      });
      log("hook_reg", "api.on('message_sending') OK");
    } catch (e: any) {
      log("hook_reg_err", `message_sending: ${e.message}`);
    }

    // --- Hook: before_tool_call ---
    try {
      api.on("before_tool_call", (event: any) => {
        log("tool_call", `before_tool_call: ${event?.name ?? event?.toolName ?? "?"}`, {
          toolName: event?.name ?? event?.toolName,
          parameters: safeStr(event?.parameters ?? event?.params ?? event?.input),
          taskId: event?.taskId,
        });
      });
      log("hook_reg", "api.on('before_tool_call') OK");
    } catch (e: any) {
      log("hook_reg_err", `before_tool_call: ${e.message}`);
    }

    // --- Hook: after_tool_call ---
    try {
      api.on("after_tool_call", (event: any) => {
        log("tool_result", `after_tool_call: ${event?.name ?? event?.toolName ?? "?"}`, {
          toolName: event?.name ?? event?.toolName,
          result: safeStr(event?.result),
          success: event?.success,
          duration: event?.duration,
          taskId: event?.taskId,
        });
      });
      log("hook_reg", "api.on('after_tool_call') OK");
    } catch (e: any) {
      log("hook_reg_err", `after_tool_call: ${e.message}`);
    }

    // --- Hook: reply_dispatch (agent plan / skill) ---
    try {
      api.on("reply_dispatch", (event: any) => {
        log("agent_plan", "reply_dispatch", {
          content: safeStr(event),
        });
      });
      log("hook_reg", "api.on('reply_dispatch') OK");
    } catch (e: any) {
      log("hook_reg_err", `reply_dispatch: ${e.message}`);
    }

    // --- Hook: gateway_start ---
    try {
      api.on("gateway_start", (event: any) => {
        log("lifecycle", "gateway_start", {
          content: safeStr(event),
        });
      });
      log("hook_reg", "api.on('gateway_start') OK");
    } catch (e: any) {
      log("hook_reg_err", `gateway_start: ${e.message}`);
    }

    // --- Also try registerHook with string event name ---
    const hookEvents = [
      "message_received",
      "message_sending",
      "before_tool_call",
      "after_tool_call",
      "reply_dispatch",
    ];
    for (const evt of hookEvents) {
      try {
        api.registerHook(evt, (...args: any[]) => {
          log(`rh_${evt}`, `registerHook '${evt}' fired`, {
            argCount: args.length,
            preview: args.map((a) =>
              typeof a === "function" ? "[fn]" : safeStr(a)
            ),
          });
        });
        log("rh_reg", `registerHook('${evt}') OK`);
      } catch (e: any) {
        log("rh_reg_err", `registerHook('${evt}'): ${e.message}`);
      }
    }

    // --- Probe: try runtime.events.on / emit ---
    try {
      const ev = (api.runtime as any).events;
      if (ev && typeof ev.on === "function") {
        const rtEvents = [
          "message", "message_received", "tool_call", "tool_result",
          "plan", "skill", "userMessage", "assistantMessage",
        ];
        for (const name of rtEvents) {
          ev.on(name, (...args: any[]) => {
            log(`rt_event_${name}`, `runtime.events '${name}' fired`, {
              argCount: args.length,
              preview: args.map((a: any) =>
                typeof a === "function" ? "[fn]" : safeStr(a)
              ),
            });
          });
        }
        log("probe_rt_events", "Registered runtime.events listeners");
      } else {
        log("probe_rt_events", "runtime.events has no .on()", {
          type: typeof ev?.on,
        });
      }
    } catch (e: any) {
      log("probe_rt_events_err", e.message);
    }
  },
});
