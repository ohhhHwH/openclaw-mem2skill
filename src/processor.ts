import { randomUUID } from "crypto";
import { Storage } from "./storage";
import type {
  EventChain,
  GraphNode,
  GraphRelationship,
  MEvent,
  RetrievalResult,
  StorageConfig,
} from "./types";

// ---- 类型重导出，方便外部统一 import ----
export type { EventChain, GraphNode, GraphRelationship, MEvent, RetrievalResult, StorageConfig };

// ---- 统一的处理结果类型 ----
export interface QueryResult {
  /** 新建或匹配到的事件链 */
  chain: EventChain;
  /** 相似历史事件链列表（已按分数降序排序） */
  similar: RetrievalResult[];
}

export interface GraphBuildResult {
  chain: EventChain;
  nodes: GraphNode[];
  rels: GraphRelationship[];
}

/**
 * 字符频率向量 embedding（改进版：bigram 加权）。
 * 单字符 + 双字符 bigram 混合编码，提升语义区分度。
 * 对于中文文本，bigram 能捕捉词汇级别的特征。
 */
export function simpleEmbedding(text: string, dim: number = 64): number[] {
  const vec = new Array(dim).fill(0);

  // 单字符编码
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i) * 0.6;
  }

  // bigram 编码（加权更高，捕捉局部语义）
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.charCodeAt(i) * 31 + text.charCodeAt(i + 1);
    vec[bigram % dim] += 1.0;
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/**
 * 用语义标签增强 embedding。
 * 标签维度权重更高，使标签化的语义特征在检索中占主导。
 */
export function enhanceEmbeddingWithLabels(
  baseEmbedding: number[],
  labels: string[],
): number[] {
  if (labels.length === 0) return baseEmbedding;

  const dim = baseEmbedding.length;
  const enhanced = [...baseEmbedding];

  for (const label of labels) {
    // 标签直接编码到向量中，权重较高
    for (let i = 0; i < label.length; i++) {
      enhanced[i % dim] += label.charCodeAt(i) * 1.5;
    }
    // bigram 权重
    for (let i = 0; i < label.length - 1; i++) {
      const bigram = label.charCodeAt(i) * 31 + label.charCodeAt(i + 1);
      enhanced[bigram % dim] += 2.0;
    }
  }

  const norm = Math.sqrt(enhanced.reduce((s, v) => s + v * v, 0)) || 1;
  return enhanced.map((v) => v / norm);
}

// ---- 语义标签标准化（LLM 辅助） ----

/**
 * 构建用于语义标签拆解的 LLM prompt。
 * 将用户自然语言问题拆解为离散的标准化标签。
 */
export function buildLabelDecompositionPrompt(userIntent: string): string {
  return [
    "你是一个查询意图分析器。请将用户的自然语言问题拆解为若干个离散的标准化语义标签。",
    "标签应捕获问题的：领域（如 leetcode/股市/天气）、操作（如 查询/计算/对比）、实体关键词。",
    "每个标签应简洁（2-8个字），避免冗余，总数控制在3-6个。",
    "",
    `用户问题: ${userIntent}`,
    "",
    "请以 JSON 数组格式回复，不要包含其他文字：",
    '["标签1", "标签2", "标签3"]',
  ].join("\n");
}

/**
 * 解析 LLM 返回的标签拆解结果。
 * @returns 标签数组，失败返回空数组
 */
export function parseLabelDecompositionResponse(text: string): string[] {
  if (!text) return [];

  // 尝试匹配 JSON 数组
  const arrMatch = text.match(/\[[\s\S]*?\]/);
  if (!arrMatch) return [];

  try {
    const parsed = JSON.parse(arrMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map((s) => s.trim())
        .filter((s) => s.length >= 1 && s.length <= 20)
        .slice(0, 8);
    }
  } catch {
    // 尝试按行解析
    const lines = text
      .split("\n")
      .map((l) => l.replace(/^[\d\.\-\s]+/, "").trim())
      .filter((l) => l.length >= 2 && l.length <= 20);
    if (lines.length > 0) return lines.slice(0, 6);
  }

  return [];
}

// ---- 用户反馈检测（启发式） ----

import type { UserFeedback } from "./types";

/** 正面评价关键词 */
const POSITIVE_KEYWORDS = [
  "不错", "很好", "非常好", "很棒", "准确", "正确", "谢谢", "感谢", "厉害",
  "good", "great", "thanks", "excellent", "perfect", "correct",
];

/** 负面评价关键词 */
const NEGATIVE_KEYWORDS = [
  "不对", "错了", "错误", "不行", "太慢", "不好", "没用", "无效", "不准",
  "wrong", "incorrect", "bad", "slow", "useless", "invalid",
];

/** 速度相关关键词 */
const SPEED_KEYWORDS = ["太快", "太慢", "速度", "慢", "快", "slow", "fast", "speed"];

/** 格式相关关键词 */
const FORMAT_KEYWORDS = ["格式", "排版", "清晰", "混乱", "format", "layout", "readable"];

/**
 * 从用户消息中检测对上一次回答的反馈。
 * 使用关键词匹配 + 启发式规则，不依赖 LLM。
 */
export function detectUserFeedback(userMessage: string): UserFeedback | null {
  const lower = userMessage.toLowerCase();

  let polarity: "positive" | "negative" | "neutral" = "neutral";
  let posHits = 0;
  let negHits = 0;

  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) posHits++;
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) negHits++;
  }

  if (posHits > negHits) polarity = "positive";
  else if (negHits > posHits) polarity = "negative";
  else if (posHits === 0 && negHits === 0) return null; // 无评价信号

  const dimensions: Array<"accuracy" | "speed" | "format"> = [];

  // 准确性：默认维度（正面/负面评价通常指准确性）
  if (negHits > 0 || posHits > 0) dimensions.push("accuracy");

  // 速度维度
  for (const kw of SPEED_KEYWORDS) {
    if (lower.includes(kw)) {
      dimensions.push("speed");
      break;
    }
  }

  // 格式维度
  for (const kw of FORMAT_KEYWORDS) {
    if (lower.includes(kw)) {
      dimensions.push("format");
      break;
    }
  }

  return {
    polarity,
    dimensions: dimensions.length > 0 ? dimensions : ["accuracy"],
    confidence: Math.min((posHits + negHits) * 0.3, 1.0),
  };
}

/**
 * 根据用户反馈更新已有链的评分。
 */
export function applyFeedbackToScores(
  existingScores: Partial<Record<"accuracy" | "speed" | "format", number>>,
  feedback: UserFeedback,
): Record<string, number> {
  const scores: Record<string, number> = { ...existingScores } as Record<string, number>;
  const delta = feedback.polarity === "positive" ? 0.2 : -0.2;

  for (const dim of feedback.dimensions) {
    const current = scores[dim] ?? 0.5;
    scores[dim] = Math.round(Math.min(Math.max(current + delta, 0), 1) * 1000) / 1000;
  }

  // 综合分 = 各维度加权平均
  const dims = Object.keys(scores).filter((k) => k !== "overall");
  if (dims.length > 0) {
    scores.overall =
      Math.round(
        (dims.reduce((s, k) => s + (scores[k] ?? 0.5), 0) / dims.length) * 1000,
      ) / 1000;
  }

  return scores;
}

function parseDataContent(event: any): any {
  if (!event?.data?.content) return null;
  try {
    return JSON.parse(event.data.content);
  } catch {
    return null;
  }
}

export class Processor {
  private storage: Storage;
  private activeChains: Map<string, EventChain> = new Map();
  private pendingTaskId: string | null = null;
  private currentRunId: string | null = null;
  // 兼容旧流程：onAgentEnd 构建的待定图谱数据，等 onLlmOutput 补充 Outcome 后落盘
  private pendingGraphData: Map<
    string,
    {
      chain: EventChain;
      toolNodes: ToolNode[];
      nodes: GraphNode[];
      actionNodes: GraphNode[];
      rels: GraphRelationship[];
      intentNode: GraphNode;
    }
  > = new Map();
  private lastSavedGraph: {
    chainId: string;
    chain: EventChain;
    nodes: GraphNode[];
    rels: GraphRelationship[];
  } | null = null;

  constructor(config: StorageConfig & { debug?: boolean }) {
    this.storage = new Storage(config);
  }

  async init(): Promise<void> {
    await this.storage.init();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  getActiveChain(taskId: string): EventChain | undefined {
    return this.activeChains.get(taskId);
  }

  getActiveChainCount(): number {
    return this.activeChains.size;
  }

  async queryByIntent(intentLabel: string): Promise<GraphNode[]> {
    return this.storage.queryByIntent(intentLabel);
  }

  getLastSavedGraph() {
    return this.lastSavedGraph;
  }

  getGraphs(): Map<string, { nodes: GraphNode[]; rels: GraphRelationship[] }> {
    return (this.storage as any).graphs;
  }

  getChains(): Map<string, EventChain> {
    return (this.storage as any).chains;
  }

  async searchSimilar(text: string, topK?: number): Promise<RetrievalResult[]> {
    const embedding = simpleEmbedding(text);
    return this.storage.searchSimilar(embedding, topK);
  }

  async removeGraph(chainId: string): Promise<void> {
    return this.storage.removeGraph(chainId);
  }

  async saveGraph(chainId: string, nodes: GraphNode[], rels: GraphRelationship[]): Promise<void> {
    return this.storage.saveGraph(chainId, nodes, rels);
  }

  async saveChain(chain: EventChain): Promise<void> {
    return this.storage.saveEventChain(chain);
  }

  // ============================================================
  // 统一对外 API
  // ============================================================

  /**
   * 统一入口：处理用户查询
   * 1) 创建事件链（记录 userIntent）
   * 2) 检索相似历史事件链
   * 3) 返回完整结果
   *
   * 供外部测试和扩展调用，不依赖事件系统。
   */
  async processQuery(
    text: string,
    taskId?: string,
  ): Promise<QueryResult> {
    const embedding = simpleEmbedding(text);
    const similar = await this.storage.searchSimilar(embedding);

    const resolvedTaskId = taskId ?? randomUUID();
    const chain: EventChain = {
      id: randomUUID(),
      taskId: resolvedTaskId,
      timestamp: Date.now(),
      userIntent: text,
      events: [
        {
          type: "user_query",
          content: text,
          metadata: { timestamp: Date.now() },
        },
      ],
      toolSequence: [],
      outcome: "partial",
      embedding,
      accessCount: 0,
      lastAccessTime: 0,
    };
    this.activeChains.set(resolvedTaskId, chain);

    return { chain, similar };
  }

  /**
   * 统一入口：从 Agent messages 构建知识图谱
   *
   * 封装了 tool node 提取 → 建图 → 落盘 的完整流程，
   * 供外部测试和扩展调用。
   */
  async buildKnowledgeGraph(
    messages: any[],
    options?: {
      chainId?: string;
      taskId?: string;
      userIntent?: string;
      toolSequence?: string[];
      outcome?: "success" | "failure" | "partial";
    },
  ): Promise<GraphBuildResult> {
    const chainId = options?.chainId ?? randomUUID();
    const taskId = options?.taskId ?? chainId;
    const userIntent = options?.userIntent ?? "";
    const outcome = options?.outcome ?? "success";

    const toolNodes = this.extractToolNodes(messages);
    const toolSequence =
      options?.toolSequence ?? toolNodes.map((t) => t.toolName);

    const combinedText = userIntent + " " + toolSequence.join(" ");
    const embedding = simpleEmbedding(combinedText);

    const chain: EventChain = {
      id: chainId,
      taskId,
      timestamp: Date.now(),
      userIntent,
      events: [],
      toolSequence,
      outcome,
      embedding,
      accessCount: 0,
      lastAccessTime: 0,
    };

    // 重建 events（简化版）
    chain.events.push({
      type: "user_query",
      content: userIntent,
      metadata: { timestamp: Date.now() },
    });
    for (const tn of toolNodes) {
      chain.events.push({
        type: "tool_call",
        content: `${tn.toolName}: ${tn.toolCallId}`,
        metadata: {
          toolName: tn.toolName,
          parameters: tn.arguments,
          result: tn.resultText,
          success: !tn.isError,
          timestamp: tn.timestamp ?? Date.now(),
        },
      });
    }

    // 构建图谱节点
    const nodes: GraphNode[] = [];
    const rels: GraphRelationship[] = [];

    const intentNode: GraphNode = {
      id: `intent-${chainId}`,
      type: "Intent",
      label: userIntent,
      properties: { taskId },
    };
    nodes.push(intentNode);

    const actionNodes: GraphNode[] = [];
    for (const tn of toolNodes) {
      const actionNode: GraphNode = {
        id: `action-${chainId}-${tn.toolCallId}`,
        type: "Action",
        label: tn.toolName,
        properties: {
          toolCallId: tn.toolCallId,
          arguments: tn.arguments,
          isError: tn.isError,
        },
      };
      nodes.push(actionNode);
      actionNodes.push(actionNode);
    }

    if (actionNodes.length > 0) {
      rels.push({
        from: [intentNode.id],
        to: actionNodes.map((n) => n.id),
        type: "TRIGGERS",
      });

      if (toolNodes.length > 0) {
        const dependsRels = this.detectDependencies(toolNodes, actionNodes);
        rels.push(...dependsRels);
      }
    }

    // Outcome 节点 + RESULTS_IN 权重
    const assistantTexts = this.extractAssistantTexts(messages);
    const answerText = assistantTexts.join("\n");
    const outcomeLabel =
      answerText.length <= 80 ? answerText : answerText.slice(0, 78) + "…";
    const outcomeNode: GraphNode = {
      id: `outcome-${chainId}`,
      type: "Outcome",
      label: outcomeLabel,
      properties: {
        fullText: answerText,
        success: outcome === "success",
      },
    };
    nodes.push(outcomeNode);

    if (actionNodes.length > 0) {
      const actionWeights: Record<string, number> = {};
      for (let i = 0; i < actionNodes.length; i++) {
        const tn = toolNodes[i];
        const resultText = tn ? this.getToolResultFullText(tn) : "";
        if (resultText.length > 0 && answerText.length > 0) {
          const lcs = this.longestCommonSubstringLen(resultText, answerText);
          actionWeights[actionNodes[i].id] =
            Math.round(Math.min(lcs / resultText.length, 1) * 1000) / 1000;
        } else {
          actionWeights[actionNodes[i].id] = 0;
        }
      }
      rels.push({
        from: actionNodes.map((n) => n.id),
        to: [outcomeNode.id],
        type: "RESULTS_IN",
        properties: { actionWeights },
      });
    }

    // 落盘
    await this.storage.saveEventChain(chain);
    await this.storage.saveGraph(chainId, nodes, rels);

    return { chain, nodes, rels };
  }

  // ============================================================
  // 事件回调方法（供 hook handler 调用）
  // ============================================================

  async onMessageReceived(event: any): Promise<RetrievalResult[]> {
    const text =
      event?.data?.original ??
      event?.data?.text ??
      event?.data?.content ??
      "";
    const embedding = simpleEmbedding(text);
    const results = await this.storage.searchSimilar(embedding);

    const taskId = event?.data?.taskId ?? randomUUID();
    const chain: EventChain = {
      id: randomUUID(),
      taskId,
      timestamp: event?.time ? new Date(event.time).getTime() : Date.now(),
      userIntent: text,
      events: [
        {
          type: "user_query",
          content: text,
          metadata: {
            timestamp: event?.time
              ? new Date(event.time).getTime()
              : Date.now(),
          },
        },
      ],
      toolSequence: [],
      outcome: "partial",
      embedding,
      accessCount: 0,
      lastAccessTime: 0,
    };
    this.activeChains.set(taskId, chain);
    // 暂存为待绑定链，等下一条 reply_dispatch 把 runId 补上
    this.pendingTaskId = taskId;

    return results;
  }

  onReplyDispatch(event: any): void {
    const parsed = parseDataContent(event);
    if (!parsed) return;

    const runId = parsed.runId ?? parsed.ctx?.MessageSid;
    if (!runId) return;

    // 已经存在以 runId 为 key 的链则直接复用
    if (this.activeChains.has(runId)) {
      this.currentRunId = runId;
      this.registerRunId(runId, runId);
      return;
    }

    // 优先把待绑定的 onMessageReceived 链改名挂到真实 runId 上，避免重复建链
    if (this.pendingTaskId && this.activeChains.has(this.pendingTaskId)) {
      const existing = this.activeChains.get(this.pendingTaskId)!;
      this.activeChains.delete(this.pendingTaskId);
      existing.taskId = runId;
      this.activeChains.set(runId, existing);
      this.registerRunId(runId, runId);
      this.pendingTaskId = null;
      this.currentRunId = runId;
      return;
    }

    // 没有待绑定链时（例如缺失 user_input 日志），按 reply_dispatch 自身建链
    const userText = parsed.ctx?.Body ?? parsed.ctx?.RawBody ?? "";
    const chain: EventChain = {
      id: randomUUID(),
      taskId: runId,
      timestamp: event?.time ? new Date(event.time).getTime() : Date.now(),
      userIntent: userText,
      events: [
        {
          type: "user_query",
          content: userText,
          metadata: {
            timestamp: event?.time
              ? new Date(event.time).getTime()
              : Date.now(),
          },
        },
      ],
      toolSequence: [],
      outcome: "partial",
      embedding: simpleEmbedding(userText),
      accessCount: 0,
      lastAccessTime: 0,
    };
    this.activeChains.set(runId, chain);
    this.registerRunId(runId, runId);
    this.currentRunId = runId;
  }

  onBeforeToolCall(event: any): void {
    const toolName =
      event?.data?.toolName ?? event?.data?.name ?? "unknown";
    const parameters = event?.data?.parameters;

    const chain = this.findChainForToolEvent(event);
    if (!chain) return;

    const mEvent: MEvent = {
      type: "tool_call",
      content: `before_tool_call: ${toolName}`,
      metadata: {
        toolName,
        parameters,
        timestamp: event?.time
          ? new Date(event.time).getTime()
          : Date.now(),
      },
    };
    chain.events.push(mEvent);
    chain.toolSequence.push(toolName);
  }

  onAfterToolCall(event: any): void {
    const toolName =
      event?.data?.toolName ?? event?.data?.name ?? "unknown";
    const result = event?.data?.result;

    const chain = this.findChainForToolEvent(event);
    if (!chain) return;

    for (let i = chain.events.length - 1; i >= 0; i--) {
      const ev = chain.events[i];
      if (
        ev.type === "tool_call" &&
        ev.metadata.toolName === toolName &&
        ev.metadata.result === undefined
      ) {
        ev.metadata.result = result;
        ev.metadata.success = true;
        if (ev.metadata.timestamp && event?.time) {
          ev.metadata.duration =
            new Date(event.time).getTime() - ev.metadata.timestamp;
        }
        break;
      }
    }
  }

  async onAgentEnd(event: any): Promise<void> {
    const taskId =
      event?.data?.runId ?? event?.data?.taskId ?? this.currentRunId;

    let chain: EventChain | undefined;
    if (taskId) {
      chain = this.activeChains.get(taskId);
    }
    if (!chain) {
      chain = this.activeChains.values().next().value;
    }
    if (!chain) return;

    chain.outcome =
      event?.data?.success === false ? "failure" : "success";

    // --- 从 agent_end 的 messages 数组中提取 tool call 节点 ---
    const messages: any[] = event?.data?.messages ?? [];
    const toolNodes = this.extractToolNodes(messages);

    if (toolNodes.length > 0) {
      chain.toolSequence = toolNodes.map((t) => t.toolName);
      chain.events = [
        {
          type: "user_query",
          content: chain.userIntent,
          metadata: { timestamp: chain.timestamp },
        },
      ];
      for (const tn of toolNodes) {
        chain.events.push({
          type: "tool_call",
          content: `${tn.toolName}: ${tn.toolCallId}`,
          metadata: {
            toolName: tn.toolName,
            parameters: tn.arguments,
            result: tn.resultText,
            success: !tn.isError,
            timestamp: tn.timestamp ?? chain.timestamp,
          },
        });
      }
    }

    chain.embedding = simpleEmbedding(
      chain.userIntent + " " + chain.toolSequence.join(" ")
    );

    await this.storage.saveEventChain(chain);
    // --- 从 messages 中提取最终回复文本 ---
    const assistantTexts = this.extractAssistantTexts(messages);
    const answerText = assistantTexts.join("\n");

    // --- 构建完整知识图谱（含 Outcome 和 RESULTS_IN） ---
    const nodes: GraphNode[] = [];
    const rels: GraphRelationship[] = [];

    const intentNode: GraphNode = {
      id: `intent-${chain.id}`,
      type: "Intent",
      label: chain.userIntent,
      properties: { taskId: chain.taskId },
    };
    nodes.push(intentNode);

    const actionNodes: GraphNode[] = [];
    if (toolNodes.length > 0) {
      for (const tn of toolNodes) {
        const actionNode: GraphNode = {
          id: `action-${chain.id}-${tn.toolCallId}`,
          type: "Action",
          label: tn.toolName,
          properties: {
            toolCallId: tn.toolCallId,
            arguments: tn.arguments,
            isError: tn.isError,
            qualityScore: scoreToolCallQuality(tn),
          },
        };
        nodes.push(actionNode);
        actionNodes.push(actionNode);
      }
    } else {
      for (const toolName of chain.toolSequence) {
        const actionNode: GraphNode = {
          id: `action-${chain.id}-${toolName}-${nodes.length}`,
          type: "Action",
          label: toolName,
          properties: {},
        };
        nodes.push(actionNode);
        actionNodes.push(actionNode);
      }
    }

    if (actionNodes.length > 0) {
      rels.push({
        from: [intentNode.id],
        to: actionNodes.map((n) => n.id),
        type: "TRIGGERS",
      });

      if (toolNodes.length > 0) {
        const dependsRels = this.detectDependencies(toolNodes, actionNodes);
        rels.push(...dependsRels);
      }
    }

    // --- Outcome 节点 + RESULTS_IN 权重 ---
    const outcomeLabel =
      answerText.length <= 80 ? answerText : answerText.slice(0, 78) + "…";
    const outcomeNode: GraphNode = {
      id: `outcome-${chain.id}`,
      type: "Outcome",
      label: outcomeLabel,
      properties: {
        fullText: answerText,
        success: chain.outcome === "success",
      },
    };
    nodes.push(outcomeNode);

    if (actionNodes.length > 0) {
      const actionWeights: Record<string, number> = {};
      for (let i = 0; i < actionNodes.length; i++) {
        const tn = toolNodes[i];
        const resultText = tn ? this.getToolResultFullText(tn) : "";
        if (resultText.length > 0 && answerText.length > 0) {
          const lcs = this.longestCommonSubstringLen(resultText, answerText);
          actionWeights[actionNodes[i].id] =
            Math.round(Math.min(lcs / resultText.length, 1) * 1000) / 1000;
        } else {
          actionWeights[actionNodes[i].id] = 0;
        }
      }
      rels.push({
        from: actionNodes.map((n) => n.id),
        to: [outcomeNode.id],
        type: "RESULTS_IN",
        properties: { actionWeights },
      });
    }

    await this.storage.saveGraph(chain.id, nodes, rels);

    this.lastSavedGraph = { chainId: chain.id, chain, nodes, rels };
    this.activeChains.delete(chain.taskId);
    if (this.currentRunId === chain.taskId) {
      this.currentRunId = null;
    }
  }

  async onLlmOutput(event: any): Promise<void> {
    const runId =
      event?.data?.event?.runId ??
      (() => {
        try {
          return JSON.parse(event?.data?.content)?.runId;
        } catch {
          return undefined;
        }
      })();

    let pending = runId ? this.pendingGraphData.get(runId) : undefined;
    if (!pending && this.pendingGraphData.size === 1) {
      pending = this.pendingGraphData.values().next().value;
    }
    if (!pending) return;

    const assistantTexts: string[] =
      event?.data?.event?.assistantTexts ??
      (() => {
        try {
          return JSON.parse(event?.data?.content)?.assistantTexts;
        } catch {
          return [];
        }
      })();
    const answerText = assistantTexts.join("\n");

    const { chain, toolNodes, nodes, actionNodes, rels, intentNode } = pending;

    const outcomeLabel =
      answerText.length <= 80 ? answerText : answerText.slice(0, 78) + "…";
    const outcomeNode: GraphNode = {
      id: `outcome-${chain.id}`,
      type: "Outcome",
      label: outcomeLabel,
      properties: {
        fullText: answerText,
        success: chain.outcome === "success",
      },
    };
    nodes.push(outcomeNode);

    if (actionNodes.length > 0) {
      const actionWeights: Record<string, number> = {};
      for (let i = 0; i < actionNodes.length; i++) {
        const tn = toolNodes[i];
        const resultText = tn ? this.getToolResultFullText(tn) : "";
        if (resultText.length > 0 && answerText.length > 0) {
          const lcs = this.longestCommonSubstringLen(resultText, answerText);
          actionWeights[actionNodes[i].id] =
            Math.round(Math.min(lcs / resultText.length, 1) * 1000) / 1000;
        } else {
          actionWeights[actionNodes[i].id] = 0;
        }
      }
      rels.push({
        from: actionNodes.map((n) => n.id),
        to: [outcomeNode.id],
        type: "RESULTS_IN",
        properties: { actionWeights },
      });
    }

    await this.storage.saveGraph(chain.id, nodes, rels);
    this.pendingGraphData.delete(chain.taskId);
  }

  private extractAssistantTexts(messages: any[]): string[] {
    const texts: string[] = [];
    for (const msg of messages) {
      if (msg?.role !== "assistant" || !Array.isArray(msg?.content)) continue;
      for (const block of msg.content) {
        if (block?.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    }
    return texts;
  }

  private extractToolNodes(messages: any[]): ToolNode[] {
    const toolCalls = new Map<string, { name: string; arguments: any }>();
    const toolResults = new Map<
      string,
      { text: string; details: any; isError: boolean; timestamp?: number }
    >();

    for (const msg of messages) {
      if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block?.type === "toolCall" && block.id) {
            toolCalls.set(block.id, {
              name: block.name ?? "unknown",
              arguments: block.arguments,
            });
          }
        }
      }
      if (msg?.role === "toolResult" && msg?.toolCallId) {
        const textParts: string[] = [];
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "text" && block.text) {
              textParts.push(block.text);
            }
          }
        }
        toolResults.set(msg.toolCallId, {
          text: textParts.join("\n"),
          details: msg.details,
          isError: msg.isError === true,
          timestamp: msg.timestamp,
        });
      }
    }

    const nodes: ToolNode[] = [];
    for (const [callId, call] of toolCalls) {
      const result = toolResults.get(callId);
      nodes.push({
        toolCallId: callId,
        toolName: call.name,
        arguments: call.arguments,
        resultText: result?.text ?? "",
        resultDetails: result?.details,
        isError: result?.isError ?? false,
        timestamp: result?.timestamp,
      });
    }
    return nodes;
  }

  private detectDependencies(
    toolNodes: ToolNode[],
    actionNodes: GraphNode[]
  ): GraphRelationship[] {
    const rels: GraphRelationship[] = [];
    const MIN_LCS_LEN = 8;
    const MIN_WEIGHT = 0.3;

    for (let i = 1; i < toolNodes.length; i++) {
      const current = toolNodes[i];
      const argValues = this.extractStringValues(current.arguments);
      if (argValues.length === 0) continue;

      const totalArgLen = argValues.reduce((s, v) => s + v.length, 0);

      for (let j = 0; j < i; j++) {
        const prior = toolNodes[j];
        const priorText = this.getToolResultFullText(prior);
        if (!priorText) continue;

        let matchedLen = 0;
        for (const val of argValues) {
          if (val.length < 4) continue;
          const lcs = this.longestCommonSubstringLen(val, priorText);
          if (lcs >= MIN_LCS_LEN) {
            matchedLen += lcs;
          }
        }
        if (matchedLen > 0) {
          const raw = matchedLen / totalArgLen;
          const weight = Math.round(Math.min(raw, 1) * 1000) / 1000;
          if (weight >= MIN_WEIGHT) {
            rels.push({
              from: [actionNodes[j].id],
              to: [actionNodes[i].id],
              type: "DEPENDS_ON",
              properties: { weight },
            });
          }
        }
      }
    }
    return rels;
  }

  /**
   * 将 LLM 返回的依赖检测结果转换为 DEPENDS_ON 关系。
   * 可与 LCS 检测结果合并使用（去重）。
   */
  applyLlmDependencies(
    result: LlmDependencyResult,
    toolNodes: ToolNode[],
    actionNodes: GraphNode[],
  ): GraphRelationship[] {
    const rels: GraphRelationship[] = [];
    const existing = new Set<string>();

    for (const dep of result.dependencies) {
      const fromIdx = dep.from - 1;
      const toIdx = dep.to - 1;
      if (fromIdx < 0 || toIdx >= actionNodes.length) continue;

      const key = `${actionNodes[fromIdx].id}->${actionNodes[toIdx].id}`;
      if (existing.has(key)) continue;
      existing.add(key);

      // 用工具节点信息计算补充权重
      const current = toolNodes[toIdx];
      const prior = toolNodes[fromIdx];
      const argValues = this.extractStringValues(current.arguments);
      const totalArgLen = argValues.reduce((s, v) => s + v.length, 0);
      let matchedLen = 0;
      if (totalArgLen > 0 && prior) {
        const priorText = this.getToolResultFullText(prior);
        for (const val of argValues) {
          if (val.length < 4) continue;
          matchedLen += this.longestCommonSubstringLen(val, priorText);
        }
      }
      const weight =
        totalArgLen > 0
          ? Math.round(Math.min(matchedLen / totalArgLen, 1) * 1000) / 1000
          : 0.5;

      rels.push({
        from: [actionNodes[fromIdx].id],
        to: [actionNodes[toIdx].id],
        type: "DEPENDS_ON",
        properties: { weight, reason: dep.reason ?? "LLM detected" },
      });
    }

    // 将 LLM 分数写入对应 Action 节点
    for (let i = 0; i < actionNodes.length; i++) {
      const key = String(i + 1);
      if (result.scores[key] !== undefined) {
        actionNodes[i].properties.llmQualityScore = result.scores[key];
      }
    }

    return rels;
  }

  private extractStringValues(obj: any): string[] {
    const values: string[] = [];
    if (!obj) return values;
    if (typeof obj === "string") {
      values.push(obj);
      return values;
    }
    if (typeof obj === "object") {
      for (const val of Object.values(obj)) {
        if (typeof val === "string" && val.length > 0) {
          values.push(val);
        }
      }
    }
    return values;
  }

  private getToolResultFullText(node: ToolNode): string {
    const parts: string[] = [];
    if (node.resultText) parts.push(node.resultText);
    if (node.resultDetails) {
      try {
        parts.push(
          typeof node.resultDetails === "string"
            ? node.resultDetails
            : JSON.stringify(node.resultDetails)
        );
      } catch {
        // skip
      }
    }
    return parts.join("\n");
  }

  private longestCommonSubstringLen(short: string, long: string): number {
    if (!short || !long) return 0;
    const a = short;
    const b = long;
    const m = a.length;
    const n = b.length;
    let best = 0;
    const prev = new Uint16Array(n + 1);
    const curr = new Uint16Array(n + 1);
    for (let i = 1; i <= m; i++) {
      curr.fill(0);
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          curr[j] = prev[j - 1] + 1;
          if (curr[j] > best) best = curr[j];
        }
      }
      prev.set(curr);
    }
    return best;
  }

  // runId → taskId 反向索引，用于快速定位 tool_call 所属链
  private runIdToChainKey: Map<string, string> = new Map();

  private findChainForToolEvent(event: any): EventChain | undefined {
    // 1. 优先通过 taskId 精确匹配
    const taskId = event?.data?.taskId;
    if (taskId && this.activeChains.has(taskId)) {
      return this.activeChains.get(taskId);
    }

    // 2. 通过 runId 匹配（tool_call 通常携带 runId）
    const runId = event?.data?.runId ?? event?.runId;
    if (runId) {
      const chainKey = this.runIdToChainKey.get(runId);
      if (chainKey && this.activeChains.has(chainKey)) {
        return this.activeChains.get(chainKey);
      }
      // 直接查找以 runId 为 key 的链
      if (this.activeChains.has(runId)) {
        return this.activeChains.get(runId);
      }
    }

    // 3. 通过 currentRunId 匹配
    if (this.currentRunId) {
      if (this.activeChains.has(this.currentRunId)) {
        return this.activeChains.get(this.currentRunId);
      }
      const chainKey = this.runIdToChainKey.get(this.currentRunId);
      if (chainKey && this.activeChains.has(chainKey)) {
        return this.activeChains.get(chainKey);
      }
    }

    // 4. 单链回退
    if (this.activeChains.size === 1) {
      return this.activeChains.values().next().value;
    }

    // 5. 最后回退（多链且无法匹配时取第一个，实际多用户场景由 sessionState 隔离避免）
    return this.activeChains.values().next().value;
  }

  /** 注册 runId → chain key 的映射，在 reply_dispatch 时调用 */
  private registerRunId(runId: string, chainKey: string): void {
    this.runIdToChainKey.set(runId, chainKey);
  }
}

interface ToolNode {
  toolCallId: string;
  toolName: string;
  arguments: any;
  resultText: string;
  resultDetails: any;
  isError: boolean;
  timestamp?: number;
}

// ---- LLM 依赖检测 prompt 构建与结果解析 ----

export interface LlmDependencyResult {
  dependencies: Array<{ from: number; to: number; reason?: string }>;
  scores: Record<string, number>;
}

/**
 * 构建用于 LLM 依赖检测的 prompt。
 * 外部可在 agent_end 中调用此方法生成 prompt，再通过 evaluateViaRuntime/evaluateViaFetch 获取结果。
 */
export function buildLlmDependencyPrompt(
  toolNodes: ToolNode[],
  userIntent: string,
): string {
  if (toolNodes.length === 0) return "";

  const callDescriptions: string[] = [];
  for (let i = 0; i < toolNodes.length; i++) {
    const tn = toolNodes[i];
    const argsStr =
      typeof tn.arguments === "string"
        ? tn.arguments.slice(0, 200)
        : JSON.stringify(tn.arguments).slice(0, 200);
    const resultStr = (tn.resultText || (tn.resultDetails
      ? JSON.stringify(tn.resultDetails)
      : "")).slice(0, 300);
    const errTag = tn.isError ? " [调用失败]" : "";

    callDescriptions.push(
      `工具调用 #${i + 1}: ${tn.toolName}(${argsStr})${errTag}` +
      (resultStr ? `\n  结果摘要: ${resultStr}` : ""),
    );
  }

  return [
    "你正在分析一个 AI Agent 为回答用户问题而执行的一系列工具调用。",
    "",
    `用户问题: ${userIntent}`,
    "",
    "工具调用序列（按时间顺序）:",
    ...callDescriptions,
    "",
    "请完成以下分析任务：",
    "1. 识别工具调用之间的依赖关系。如果某个工具调用的参数值来源于前一个工具调用的返回结果，则标记为依赖。",
    "2. 对每个工具调用的有效性打分（0-1），基于其返回结果是否对回答用户问题有帮助。调用失败则为 0。",
    "",
    "请以 JSON 格式回复，不要包含其他文字：",
    '{',
    '  "dependencies": [',
    '    {"from": 1, "to": 2, "reason": "参数 URL 来自 #1 的返回结果"},',
    '    ...',
    '  ],',
    '  "scores": {',
    '    "1": 0.9,',
    '    "2": 0.6,',
    '    ...',
    '  }',
    '}',
  ].join("\n");
}

/**
 * 解析 LLM 返回的依赖检测结果。
 * @returns 解析后的结构化结果，失败返回 null
 */
export function parseLlmDependencyResponse(
  text: string,
  toolCount: number,
): LlmDependencyResult | null {
  if (!text) return null;

  // 尝试提取 JSON 块
  const jsonMatch = text.match(/\{[\s\S]*"dependencies"[\s\S]*"scores"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const deps: Array<{ from: number; to: number; reason?: string }> = [];
    const scores: Record<string, number> = {};

    if (Array.isArray(parsed.dependencies)) {
      for (const dep of parsed.dependencies) {
        const from = typeof dep.from === "number" ? dep.from : parseInt(String(dep.from), 10);
        const to = typeof dep.to === "number" ? dep.to : parseInt(String(dep.to), 10);
        if (from >= 1 && from <= toolCount && to >= 1 && to <= toolCount && from < to) {
          deps.push({ from, to, reason: dep.reason });
        }
      }
    }

    if (parsed.scores && typeof parsed.scores === "object") {
      for (const [key, val] of Object.entries(parsed.scores)) {
        const num = typeof val === "number" ? val : parseFloat(String(val));
        if (!isNaN(num) && num >= 0 && num <= 1) {
          scores[key] = Math.round(num * 1000) / 1000;
        }
      }
    }

    return { dependencies: deps, scores };
  } catch {
    return null;
  }
}

/**
 * 计算单个工具调用的质量分数（无 LLM 时的回退方案）。
 * 基于 isError、结果长度等启发式指标。
 */
export function scoreToolCallQuality(node: ToolNode): number {
  if (node.isError) return 0;
  let score = 0.5;
  const textLen = (node.resultText ?? "").length;
  if (textLen > 500) score += 0.3;
  else if (textLen > 100) score += 0.2;
  else if (textLen > 0) score += 0.1;
  if (node.resultDetails) score += 0.1;
  return Math.round(Math.min(score, 1.0) * 1000) / 1000;
}
