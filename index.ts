// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { Processor } from "./src/processor";
import { logger } from "./src/logger";
import { pluginLog } from "./src/plugin-log";

let processor: Processor | null = null;

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skills",
  description: "Automatically extracts and generates skills from conversation memory",
  register(api) {
    processor = new Processor({
      successThreshold: 0.8,
      shortMemoryThreshold: 3,
      longMemoryThreshold: 10,
      embeddingModel: "mock"
    });

    api.registerTool({
      name: "retrieve_skills",
      description: "Retrieves relevant skills based on user query",
      parameters: Type.Object({
        query: Type.String(),
        topK: Type.Optional(Type.Number({ default: 5 }))
      }),
      async execute(_id, params) {
        try {
          await logger.logUserQuery(params.query, _id);
          if (processor) {
            const skills = await processor.getRelevantSkills(params.query, params.topK || 5);
            await logger.logSkillRetrieval(params.query, skills, _id);
            return {
              content: [{
                type: "text",
                text: `Found ${skills.length} relevant skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`
              }]
            };
          }
          return { content: [{ type: "text", text: "Processor not initialized" }] };
        } catch (error: any) {
          await logger.error('plugin', 'Error retrieving skills', { query: params.query, error: error.message });
          return { content: [{ type: "text", text: "Failed to retrieve skills" }] };
        }
      },
    });

    api.registerTool({
      name: "process_task",
      description: "Processes a completed task to extract event chains and generate skills",
      parameters: Type.Object({
        taskId: Type.String(),
        messages: Type.Array(Type.Object({
          role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]),
          content: Type.String(),
          timestamp: Type.Number()
        })),
        toolCalls: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          name: Type.String(),
          parameters: Type.Any(),
          result: Type.Optional(Type.Any()),
          timestamp: Type.Number()
        }))),
        userIntent: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          if (!processor) {
            return { content: [{ type: "text", text: "Processor not initialized" }] };
          }
          const task = {
            id: params.taskId,
            messages: params.messages,
            toolCalls: params.toolCalls || [],
            userIntent: params.userIntent || ""
          };
          await logger.info('plugin', `Processing task: ${task.id}`);
          await processor.processTask(task);
          return { content: [{ type: "text", text: `Task ${task.id} processed successfully` }] };
        } catch (error: any) {
          await logger.error('plugin', 'Error processing task', { taskId: params.taskId, error: error.message });
          return { content: [{ type: "text", text: `Failed to process task: ${error.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "submit_feedback",
      description: "Submits feedback for a completed task to improve skill quality",
      parameters: Type.Object({
        taskId: Type.String(),
        score: Type.Number({ minimum: 0, maximum: 1 }),
        comment: Type.Optional(Type.String())
      }),
      async execute(_id, params) {
        try {
          if (!processor) {
            return { content: [{ type: "text", text: "Processor not initialized" }] };
          }
          await logger.info('plugin', `Feedback received: ${params.taskId}, score: ${params.score}`);
          await processor.processFeedback(params.taskId, { score: params.score, comment: params.comment });
          return { content: [{ type: "text", text: `Feedback for task ${params.taskId} recorded` }] };
        } catch (error: any) {
          await logger.error('plugin', 'Error processing feedback', { taskId: params.taskId, error: error.message });
          return { content: [{ type: "text", text: `Failed to record feedback: ${error.message}` }] };
        }
      },
    });

    api.registerTool({
      name: "log_plugin_event",
      description: "Logs a plugin event (user input, agent plan, tool call, or tool result)",
      parameters: Type.Object({
        category: Type.Union([
          Type.Literal("user_input"),
          Type.Literal("agent_plan"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result")
        ]),
        event: Type.Any()
      }),
      async execute(_id, params) {
        try {
          switch (params.category) {
            case 'user_input':
              await pluginLog.logUserInput(params.event);
              break;
            case 'agent_plan':
              await pluginLog.logAgentPlan(params.event);
              break;
            case 'tool_call':
              await pluginLog.logToolCall(params.event);
              break;
            case 'tool_result':
              await pluginLog.logToolResult(params.event);
              break;
          }
          return { content: [{ type: "text", text: `Event logged: ${params.category}` }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Failed to log event: ${error.message}` }] };
        }
      },
    });
  },
});