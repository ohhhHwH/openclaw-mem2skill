declare module "openclaw/plugin-sdk/plugin-entry" {
  import { TSchema } from "@sinclair/typebox";

  interface ToolDefinition {
    name: string;
    description: string;
    parameters: TSchema;
    execute(id: string, params: any): Promise<{
      content: { type: string; text: string }[];
    }>;
  }

  interface MessageEvent {
    taskId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
  }

  interface AgentPlanEvent {
    taskId: string;
    planId: string;
    steps: { description: string; toolName?: string; parameters?: any }[];
    reasoning?: string;
    timestamp: number;
  }

  interface ToolCallEvent {
    taskId: string;
    callId: string;
    toolName: string;
    parameters: any;
    timestamp: number;
  }

  interface ToolResultEvent {
    taskId: string;
    callId: string;
    toolName: string;
    result: any;
    success: boolean;
    duration: number;
    timestamp: number;
  }

  interface PluginApi {
    onTaskStart(handler: (task: any) => Promise<void>): void;
    onTaskEnd(handler: (task: any) => Promise<void>): void;
    onFeedback(handler: (feedback: { taskId: string; score: number; comment?: string }) => Promise<void>): void;
    onMessage(handler: (message: MessageEvent) => Promise<MessageEvent>): void;
    onAgentPlan(handler: (plan: AgentPlanEvent) => Promise<void>): void;
    onToolCall(handler: (toolCall: ToolCallEvent) => Promise<void>): void;
    onToolResult(handler: (toolResult: ToolResultEvent) => Promise<void>): void;
    registerTool(tool: ToolDefinition): void;
  }

  interface PluginEntry {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
