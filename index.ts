import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";
const PLUGIN_VERSION = "1.7";

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

    if (api.registrationMode !== "full") return;

    // // --- Probe: api.runtime.events members ---
    // try {
    //   const evKeys: Record<string, string> = {};
    //   const ev = (api.runtime as any).events;
    //   if (ev) {
    //     for (const k of Object.getOwnPropertyNames(ev)) {
    //       evKeys[k] = typeof ev[k];
    //     }
    //     const proto = Object.getPrototypeOf(ev);
    //     if (proto && proto !== Object.prototype) {
    //       for (const k of Object.getOwnPropertyNames(proto)) {
    //         evKeys[`proto.${k}`] = typeof proto[k];
    //       }
    //     }
    //   }
    //   log("probe_events_obj", "api.runtime.events members", evKeys);
    // } catch (e: any) {
    //   log("probe_events_obj_err", e.message);
    // }

    // --- api.on hooks ---

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

    // api.on("message_sending", (event: any) => {
    //   log("assistant_msg", "message_sending", {
    //     content: safeStr(
    //       event?.text ?? event?.content ?? event?.message ?? event
    //     ),
    //     taskId: event?.taskId,
    //     threadId: event?.threadId,
    //   });
    // });

    api.on("before_tool_call", (event: any) => {
      log(
        "tool_call",
        `before_tool_call: ${event?.name ?? event?.toolName ?? "?"}`,
        {
          toolName: event?.name ?? event?.toolName,
          parameters: safeStr(
            event?.parameters ?? event?.params ?? event?.input
          ),
          taskId: event?.taskId,
        }
      );
    });

    api.on("after_tool_call", (event: any) => {
      log(
        "tool_result",
        `after_tool_call: ${event?.name ?? event?.toolName ?? "?"}`,
        {
          toolName: event?.name ?? event?.toolName,
          result: safeStr(event?.result),
          success: event?.success,
          duration: event?.duration,
          taskId: event?.taskId,
        }
      );
    });

    api.on("reply_dispatch", (event: any) => {
      log("agent_plan", "reply_dispatch", {
        content: safeStr(event),
      });
    });

    api.on("gateway_start", (event: any) => {
      log("lifecycle", "gateway_start", {
        content: safeStr(event),
      });
    });

    // // --- message_sent: final reply delivered to user ---
    // api.on("message_sent", (event: any) => {
    //   log("final_reply", "message_sent", {
    //     content: safeStr(
    //       event?.text ?? event?.content ?? event?.message ?? event
    //     ),
    //     success: event?.success,
    //     error: event?.error ? safeStr(event.error) : undefined,
    //     taskId: event?.taskId,
    //     threadId: event?.threadId,
    //     messageId: event?.messageId,
    //   });
    // });

    // --- llm_output: raw model response ---
    api.on("llm_output", (event: any) => {
      log("llm_output", "llm_output", {
        content: safeStr(
          event?.text ?? event?.content ?? event?.response ?? event
        ),
        model: event?.model,
        provider: event?.provider,
        taskId: event?.taskId,
      });
    });

    // --- agent_end: final message + run status ---
    api.on("agent_end", (event: any) => {
      log("agent_end", "agent_end", {
        finalMessage: safeStr(
          event?.finalMessage ?? event?.message ?? event?.content
        ),
        success: event?.success,
        duration: event?.duration,
        runId: event?.runId,
        taskId: event?.taskId,
      });
    });

    // log("hook_reg", "All api.on hooks registered");

    // // --- registerHook with string event names ---
    // const hookEvents = [
    //   "message_received",
    //   "message_sending",
    //   "message_sent",
    //   "before_tool_call",
    //   "after_tool_call",
    //   "reply_dispatch",
    //   "llm_output",
    //   "agent_end",
    // ];
    // for (const evt of hookEvents) {
    //   try {
    //     api.registerHook(evt, (...args: any[]) => {
    //       log(`rh_${evt}`, `registerHook '${evt}' fired`, {
    //         argCount: args.length,
    //         preview: args.map((a) =>
    //           typeof a === "function" ? "[fn]" : safeStr(a)
    //         ),
    //       });
    //     });
    //   } catch (e: any) {
    //     log("rh_reg_err", `registerHook('${evt}'): ${e.message}`);
    //   }
    // }
    // log("hook_reg", "All registerHook hooks registered");

    // // --- Probe: runtime.events ---
    // try {
    //   const ev = (api.runtime as any).events;
    //   if (ev && typeof ev.on === "function") {
    //     const rtEvents = [
    //       "message",
    //       "message_received",
    //       "tool_call",
    //       "tool_result",
    //       "plan",
    //       "skill",
    //       "userMessage",
    //       "assistantMessage",
    //     ];
    //     for (const name of rtEvents) {
    //       ev.on(name, (...args: any[]) => {
    //         log(`rt_event_${name}`, `runtime.events '${name}' fired`, {
    //           argCount: args.length,
    //           preview: args.map((a: any) =>
    //             typeof a === "function" ? "[fn]" : safeStr(a)
    //           ),
    //         });
    //       });
    //     }
    //     log("probe_rt_events", "Registered runtime.events listeners");
    //   } else {
    //     log("probe_rt_events", "runtime.events has no .on()", {
    //       type: typeof ev?.on,
    //     });
    //   }
    // } catch (e: any) {
    //   log("probe_rt_events_err", e.message);
    // }
  },
});
