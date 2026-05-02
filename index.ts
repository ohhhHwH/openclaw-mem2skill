import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";
const PLUGIN_VERSION = "1.10";

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
        event,
      });
    });

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
          event,
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
          event,
        }
      );
    });

    api.on("reply_dispatch", (event: any) => {
      log("agent_plan", "reply_dispatch", {
        content: safeStr(event),
        event,
      });
    });

    api.on("gateway_start", (event: any) => {
      log("lifecycle", "gateway_start", {
        content: safeStr(event),
        event,
      });
    });

    // --- llm_output: raw model response ---
    api.on("llm_output", (event: any) => {
      log("llm_output", "llm_output", {
        content: safeStr(
          event?.text ?? event?.content ?? event?.response ?? event
        ),
        model: event?.model,
        provider: event?.provider,
        taskId: event?.taskId,
        event,
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
        event,
      });
    });

    // --- before agent: final message + run status ---
    api.on("before_agent_reply", (event: any) => {
      log("before_agent_reply", "before_agent_reply", {
        event,
      });
    });

    api.on("llm_input", (event: any) => {
      log("llm_input", "llm_input", {
        event,
      });
    });
  },
});
