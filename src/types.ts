export interface MEvent {
  type: "user_query" | "tool_call" | "ai_response" | "error";
  content: string;
  metadata: {
    toolName?: string;
    parameters?: any;
    result?: any;
    success?: boolean;
    duration?: number;
    timestamp: number;
  };
}

export interface EventChain {
  id: string;
  taskId: string;
  timestamp: number;
  userIntent: string;
  events: MEvent[];
  toolSequence: string[];
  outcome: "success" | "failure" | "partial";
  embedding: number[];
  accessCount: number;
  lastAccessTime: number;
}

export type GraphNodeType = "Intent" | "Action" | "Context" | "Outcome";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  properties: Record<string, any>;
}

export type GraphRelType = "TRIGGERS" | "REQUIRES" | "RESULTS_IN" | "DEPENDS_ON";

export interface GraphRelationship {
  from: string[];
  to: string[];
  type: GraphRelType;
  properties?: Record<string, any>;
}

export interface RetrievalResult {
  chain: EventChain;
  score: number;
}

export interface StorageConfig {
  lanceDbPath: string;
  graphLogPath: string;
}

/** 多维度评分：准确性、速度、回答格式 */
export interface EvalDimensions {
  /** 准确性 0-1 */
  accuracy: number;
  /** 响应速度满意度 0-1 */
  speed: number;
  /** 回答格式/可读性 0-1 */
  format: number;
  /** 综合评分 0-1 */
  overall: number;
}

/** 用户反馈解析结果 */
export interface UserFeedback {
  /** 反馈极性：positive/negative/neutral */
  polarity: "positive" | "negative" | "neutral";
  /** 反馈涉及维度 */
  dimensions: Array<keyof EvalDimensions>;
  /** 置信度 0-1 */
  confidence: number;
}
