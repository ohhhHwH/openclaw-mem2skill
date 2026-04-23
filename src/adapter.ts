// adapter.ts
import { ConversationContext, Message, ToolCall } from "./types";

export const adapter = {
  /**
   * 提取对话上下文
   * @param task 任务对象
   * @returns 对话上下文
   */
  async extractConversation(task: any): Promise<ConversationContext> {
    try {
      // 1. 提取消息
      const messages = this.extractMessages(task);
      
      // 2. 提取工具调用
      const toolCalls = this.extractToolCalls(task);
      
      // 3. 提取用户意图
      const userIntent = this.extractUserIntent(messages);
      
      return {
        messages,
        toolCalls,
        userIntent
      };
    } catch (error) {
      console.error("Error extracting conversation:", error);
      // 返回默认值
      return {
        messages: [],
        toolCalls: [],
        userIntent: "Unknown intent"
      };
    }
  },

  /**
   * 提取消息
   * @param task 任务对象
   * @returns 消息数组
   */
  extractMessages(task: any): Message[] {
    const messages: Message[] = [];
    
    // 从task中提取消息，这里根据实际的飞书API结构进行调整
    if (task.messages && Array.isArray(task.messages)) {
      task.messages.forEach((msg: any) => {
        messages.push({
          role: msg.role || 'user',
          content: msg.content || '',
          timestamp: msg.timestamp || Date.now()
        });
      });
    }
    
    return messages;
  },

  /**
   * 提取工具调用
   * @param task 任务对象
   * @returns 工具调用数组
   */
  extractToolCalls(task: any): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    
    // 从task中提取工具调用，这里根据实际的飞书API结构进行调整
    if (task.toolCalls && Array.isArray(task.toolCalls)) {
      task.toolCalls.forEach((call: any) => {
        toolCalls.push({
          id: call.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: call.name || '',
          parameters: call.parameters || {},
          result: call.result,
          timestamp: call.timestamp || Date.now()
        });
      });
    }
    
    return toolCalls;
  },

  /**
   * 提取用户意图
   * @param messages 消息数组
   * @returns 用户意图
   */
  extractUserIntent(messages: Message[]): string {
    // 提取用户消息
    const userMessages = messages.filter(msg => msg.role === 'user');
    
    if (userMessages.length === 0) {
      return "Unknown intent";
    }
    
    // 取最后一条用户消息作为意图
    const lastUserMessage = userMessages[userMessages.length - 1];
    
    // 简单的意图提取，实际项目中可以使用LLM进行更复杂的意图识别
    return lastUserMessage.content.substring(0, 100) + (lastUserMessage.content.length > 100 ? '...' : '');
  },

  /**
   * 提取工具调用序列
   * @param toolCalls 工具调用数组
   * @returns 工具调用序列字符串
   */
  extractToolSequence(toolCalls: ToolCall[]): string {
    return toolCalls.map(call => call.name).join(' -> ');
  }
};
