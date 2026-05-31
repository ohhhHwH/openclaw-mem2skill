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
