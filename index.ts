import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";
const PLUGIN_VERSION = "1.2";

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skill",
  description:
    "Captures user input, agent plans, skill invocations and tool calls into logs",

  register(api) {
    log("plugin", `memory2skill registered v${PLUGIN_VERSION}`, {
      mode: api.registrationMode,
    });

    // --- Text transform: prepend default greeting to user input ---
    api.registerTextTransforms({
      name: "mem2skill_prefix",
      description: "Prepends 'hello openclaw,' to user input",
      transformUserMessage(text: string) {
        const transformed = `${DEFAULT_PREFIX} ${text}`;
        log("user_input", "User message transformed", {
          original: text,
          transformed,
        });
        return transformed;
      },
    });

    // --- Event listeners via api.on ---
    api.on("userMessage", (event: any) => {
      log("user_input", "User message received", {
        taskId: event?.taskId,
        content:
          typeof event === "string"
            ? event
            : event?.content ?? event?.text ?? event,
      });
    });

    api.on("toolCall", (event: any) => {
      log("tool_call", `Tool called: ${event?.name ?? event?.toolName ?? "unknown"}`, {
        taskId: event?.taskId,
        toolName: event?.name ?? event?.toolName,
        parameters: event?.parameters ?? event?.params ?? event?.input,
      });
    });

    api.on("toolResult", (event: any) => {
      log("tool_result", `Tool result: ${event?.name ?? event?.toolName ?? "unknown"}`, {
        taskId: event?.taskId,
        toolName: event?.name ?? event?.toolName,
        success: event?.success,
        result: event?.result,
        duration: event?.duration,
      });
    });

    api.on("agentPlan", (event: any) => {
      log("agent_plan", "Agent plan created", {
        taskId: event?.taskId,
        planId: event?.planId,
        steps: event?.steps,
        reasoning: event?.reasoning,
      });
    });

    api.on("skillInvoke", (event: any) => {
      log("skill_invoke", `Skill invoked: ${event?.name ?? event?.skillName ?? "unknown"}`, {
        taskId: event?.taskId,
        skillName: event?.name ?? event?.skillName,
        args: event?.args,
      });
    });

    api.on("assistantMessage", (event: any) => {
      log("assistant_msg", "Assistant response", {
        taskId: event?.taskId,
        content:
          typeof event === "string"
            ? event
            : event?.content ?? event?.text ?? event,
      });
    });
  },
});
