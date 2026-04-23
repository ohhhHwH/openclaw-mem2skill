// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { adapter } from "./src/adapter";
import { processor } from "./src/processor";
import { storage } from "./src/storage";

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skills",
  description: "Automatically extracts and generates skills from conversation memory",
  register(api) {
    // 注册插件事件处理
    api.onTaskStart(async (task) => {
      console.log("Task started:", task.id);
      // 可以在这里初始化任务相关的资源
    });

    api.onTaskEnd(async (task) => {
      console.log("Task ended:", task.id);
      try {
        // 1. 提取对话上下文
        const context = await adapter.extractConversation(task);
        
        // 2. 处理记忆，构建事件链
        const eventChain = await processor.processTaskEnd(context, task);
        
        // 3. 存储事件链
        await storage.storeEventChain(eventChain);
        
        console.log("Task memory processed and stored successfully");
      } catch (error) {
        console.error("Error processing task memory:", error);
      }
    });

    api.onFeedback(async (feedback) => {
      console.log("Feedback received:", feedback.taskId, feedback.score);
      try {
        // 1. 更新事件链的反馈信息
        await storage.updateEventChainFeedback(feedback.taskId, feedback);
        
        // 2. 检查是否需要生成或升级技能
        await processor.checkSkillGeneration(feedback.taskId);
        
        console.log("Feedback processed successfully");
      } catch (error) {
        console.error("Error processing feedback:", error);
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
          const skills = await processor.retrieveSkills(params.query, params.topK || 5);
          return { 
            content: [{ 
              type: "text", 
              text: `Found ${skills.length} relevant skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}` 
            }] 
          };
        } catch (error) {
          console.error("Error retrieving skills:", error);
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