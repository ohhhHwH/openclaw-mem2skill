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
}
