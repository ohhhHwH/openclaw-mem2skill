export enum IntentCategory {
  DATA_QUERY = 'data_query',
  FILE_OPERATION = 'file_operation',
  CODE_GENERATION = 'code_generation',
  DEBUGGING = 'debugging',
  DEPLOYMENT = 'deployment',
  ANALYSIS = 'analysis',
}

export interface Event {
  type: 'user_query' | 'tool_call' | 'ai_response' | 'error';
  content: string;
  metadata: {
    toolName?: string;
    parameters?: any;
    result?: any;
    timestamp: number;
  };
}

export interface EventChain {
  id: string;
  taskId: string;
  timestamp: number;
  userIntent: string;
  events: Event[];
  toolSequence: string[];
  outcome: 'success' | 'failure' | 'partial';
  feedback?: UserFeedback;
  embedding?: number[];
  sourceChains?: string[];
  mergedAt?: number;
}

export interface SkillStep {
  action: string;
  parameters: {
    name: string;
    type: string;
    default?: any;
  }[];
  errorHandling?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  level: 'short' | 'long' | 'fixed';
  template: {
    intent: string;
    preconditions: string[];
    steps: SkillStep[];
    postconditions: string[];
  };
  stats: {
    totalUses: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    lastUsed: number;
  };
  sourceChains: string[];
}

export interface UserFeedback {
  score: number;
  comment?: string;
  timestamp?: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  parameters: any;
  result?: any;
  timestamp: number;
}

export interface ConversationContext {
  messages: Message[];
  toolCalls: ToolCall[];
  userIntent: string;
}

export interface PluginConfig {
  successThreshold: number;
  shortMemoryThreshold: number;
  longMemoryThreshold: number;
  embeddingModel: string;
  logDir?: string;
}

// --- 钩子事件类型 ---

export interface MessageEvent {
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface AgentPlanEvent {
  taskId: string;
  planId: string;
  steps: { description: string; toolName?: string; parameters?: any }[];
  reasoning?: string;
  timestamp: number;
}

export interface ToolCallEvent {
  taskId: string;
  callId: string;
  toolName: string;
  parameters: any;
  timestamp: number;
}

export interface ToolResultEvent {
  taskId: string;
  callId: string;
  toolName: string;
  result: any;
  success: boolean;
  duration: number;
  timestamp: number;
}

// --- 插件日志类型 ---

export type PluginLogCategory = 'user_input' | 'agent_plan' | 'tool_call' | 'tool_result';

export interface PluginLogEntry {
  timestamp: number;
  category: PluginLogCategory;
  taskId: string;
  payload: any;
}
