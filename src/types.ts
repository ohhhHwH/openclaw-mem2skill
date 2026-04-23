// types.ts

// 事件链结构
export interface EventChain {
  id: string;
  taskId: string;
  timestamp: number;
  userIntent: string;           // 用户意图摘要
  events: Event[];              // 事件序列
  outcome: 'success' | 'failure' | 'partial';
  feedback?: UserFeedback;      // 用户反馈
  embedding: number[];          // 整体向量表示
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

export interface UserFeedback {
  score: number;                // 0-10分
  comment?: string;
  timestamp: number;
}

// 技能结构
export interface Skill {
  id: string;
  name: string;
  description: string;
  level: 'short' | 'long' | 'fixed';
  
  // 技能模板
  template: {
    intent: string;              // 适用意图
    preconditions: string[];     // 前置条件
    steps: SkillStep[];          // 执行步骤
    postconditions: string[];    // 后置条件
  };
  
  // 统计信息
  stats: {
    totalUses: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgExecutionTime: number;
    lastUsed: number;
  };
  
  // 关联的事件链
  sourceChains: string[];
}

export interface SkillStep {
  action: string;               // 工具名称
  parameters: ParameterTemplate[];
  errorHandling?: string;
}

export interface ParameterTemplate {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: any;
}

// 对话上下文
export interface ConversationContext {
  messages: Message[];
  toolCalls: ToolCall[];
  userIntent: string;
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

// 意图分类
export enum IntentCategory {
  DATA_QUERY = 'data_query',           // 数据查询
  FILE_OPERATION = 'file_operation',   // 文件操作
  CODE_GENERATION = 'code_generation', // 代码生成
  DEBUGGING = 'debugging',             // 调试问题
  DEPLOYMENT = 'deployment',           // 部署相关
  ANALYSIS = 'analysis',               // 数据分析
}

// 失败分类
export enum FailureCategory {
  TOOL_ERROR = 'tool_error',           // 工具调用失败
  PARAMETER_ERROR = 'parameter_error', // 参数错误
  LOGIC_ERROR = 'logic_error',         // 逻辑错误
  TIMEOUT = 'timeout',                 // 超时
  PERMISSION_DENIED = 'permission_denied', // 权限不足
  RESOURCE_UNAVAILABLE = 'resource_unavailable', // 资源不可用
  UNEXPECTED_OUTPUT = 'unexpected_output' // 输出不符合预期
}

// 失败分析
export interface FailureAnalysis {
  chainId: string;
  category: FailureCategory;
  rootCause: string;              // 根本原因描述
  failedStep: number;             // 失败的步骤索引
  errorMessage: string;           // 错误信息
  suggestedFix: string;           // 建议修复方案
  relatedFailures: string[];      // 相关失败案例ID
}

// 技能组合
export interface CompositeSkill {
  id: string;
  name: string;
  description: string;
  subSkills: SkillReference[];     // 子技能引用
  compositionType: 'sequential' | 'parallel' | 'conditional';
}

export interface SkillReference {
  skillId: string;
  inputMapping: Record<string, string>;  // 输入参数映射
  outputMapping: Record<string, string>; // 输出参数映射
  condition?: string;                    // 执行条件 (可选)
}
