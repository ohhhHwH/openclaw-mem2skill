// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { Processor } from "./src/processor";
import { logger } from "./src/logger";

let processor: Processor | null = null;

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skills",
  description: "Automatically extracts and generates skills from conversation memory",
  register(api) {
    // 初始化处理器
    processor = new Processor({
      successThreshold: 0.8,
      shortMemoryThreshold: 3,
      longMemoryThreshold: 10,
      embeddingModel: "mock"
    });

    // 注册插件事件处理
    api.onTaskStart(async (task) => {
      await logger.info('plugin', `Task started: ${task.id}`);
    });

    api.onTaskEnd(async (task) => {
      await logger.info('plugin', `Task ended: ${task.id}`);
      if (processor) {
        await processor.processTask(task);
      }
    });

    api.onFeedback(async (feedback) => {
      await logger.info('plugin', `Feedback received: ${feedback.taskId}, score: ${feedback.score}`);
      if (processor) {
        await processor.processFeedback(feedback.taskId, feedback);
      }
    });

    // 注册技能检索工具
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
          return { 
            content: [{ 
              type: "text", 
              text: "Processor not initialized" 
            }] 
          };
        } catch (error: any) {
          await logger.error('plugin', 'Error retrieving skills', { query: params.query, error: error.message });
          return { 
            content: [{ 
              type: "text", 
              text: "Failed to retrieve skills" 
            }] 
          };
        }
      },
    });
  },
});