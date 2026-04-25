import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { log } from "./src/logger";

const DEFAULT_PREFIX = "hello openclaw,";

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skill",
  description:
    "Captures user input, agent plans, skill invocations and tool calls into logs",

  register(api) {
    // Probe: dump all api keys and their types to discover available hooks
    const apiKeys: Record<string, string> = {};
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(api))) {
      apiKeys[key] = typeof (api as any)[key];
    }
    for (const key of Object.getOwnPropertyNames(api)) {
      apiKeys[key] = typeof (api as any)[key];
    }
    log("api_probe", "Available api members", apiKeys);
    log("plugin", "memory2skill registered");

    // Tool: transform user input (prepend default prefix)
    api.registerTool({
      name: "mem2skill_transform_input",
      description:
        "Transforms user input by prepending a default greeting. Returns the modified text.",
      parameters: Type.Object({
        input: Type.String({ description: "Original user input" }),
        prefix: Type.Optional(
          Type.String({
            description: "Custom prefix (default: hello openclaw,)",
          })
        ),
      }),
      async execute(_id, params) {
        const prefix = params.prefix ?? DEFAULT_PREFIX;
        const transformed = `${prefix} ${params.input}`;
        log("user_input", "Input transformed", {
          original: params.input,
          transformed,
        });
        return {
          content: [{ type: "text", text: transformed }],
        };
      },
    });

    // Tool: log user input
    api.registerTool({
      name: "mem2skill_log_input",
      description: "Logs a user input message",
      parameters: Type.Object({
        content: Type.String(),
        taskId: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        log("user_input", params.content, { taskId: params.taskId });
        return {
          content: [{ type: "text", text: "logged" }],
        };
      },
    });

    // Tool: log agent plan
    api.registerTool({
      name: "mem2skill_log_plan",
      description: "Logs an agent planning event",
      parameters: Type.Object({
        planId: Type.String(),
        steps: Type.Array(Type.String()),
        reasoning: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        log("agent_plan", `Plan ${params.planId}`, {
          steps: params.steps,
          reasoning: params.reasoning,
        });
        return {
          content: [{ type: "text", text: "plan logged" }],
        };
      },
    });

    // Tool: log skill invocation
    api.registerTool({
      name: "mem2skill_log_skill",
      description: "Logs a skill invocation event",
      parameters: Type.Object({
        skillName: Type.String(),
        args: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        log("skill_invoke", `Skill: ${params.skillName}`, {
          args: params.args,
        });
        return {
          content: [{ type: "text", text: "skill logged" }],
        };
      },
    });

    // Tool: log tool call
    api.registerTool({
      name: "mem2skill_log_tool",
      description: "Logs a tool call and its result",
      parameters: Type.Object({
        toolName: Type.String(),
        parameters: Type.Optional(Type.String()),
        result: Type.Optional(Type.String()),
        success: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        log("tool_call", `Tool: ${params.toolName}`, {
          parameters: params.parameters,
          result: params.result,
          success: params.success,
        });
        return {
          content: [{ type: "text", text: "tool call logged" }],
        };
      },
    });
  },
});
