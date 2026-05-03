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
export type { GraphNode };

export function simpleEmbedding(text: string, dim: number = 64): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
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
  // 保存最近一次 onMessageReceived 创建的、尚未绑定到 runId 的事件链 taskId
  private pendingTaskId: string | null = null;
  // 当前活跃会话的 runId，工具事件与 agent_end 在缺少 runId 时按它定位
  private currentRunId: string | null = null;
  // onAgentEnd 构建的待定图谱数据，等 onLlmOutput 补充 Outcome 后落盘
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

  constructor(config: StorageConfig) {
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
      return;
    }

    // 优先把待绑定的 onMessageReceived 链改名挂到真实 runId 上，避免重复建链
    if (this.pendingTaskId && this.activeChains.has(this.pendingTaskId)) {
      const existing = this.activeChains.get(this.pendingTaskId)!;
      this.activeChains.delete(this.pendingTaskId);
      existing.taskId = runId;
      this.activeChains.set(runId, existing);
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
    };
    this.activeChains.set(runId, chain);
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

    // --- 构建知识图谱（不含 Outcome 和 RESULTS_IN，等 onLlmOutput 补充） ---
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

    // 暂存图谱数据，等 onLlmOutput 补充 Outcome 节点后落盘
    this.pendingGraphData.set(chain.taskId, {
      chain,
      toolNodes,
      nodes,
      actionNodes,
      rels,
      intentNode,
    });
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

  private findChainForToolEvent(event: any): EventChain | undefined {
    const taskId = event?.data?.taskId;
    if (taskId && this.activeChains.has(taskId)) {
      return this.activeChains.get(taskId);
    }
    if (this.currentRunId && this.activeChains.has(this.currentRunId)) {
      return this.activeChains.get(this.currentRunId);
    }
    if (this.activeChains.size === 1) {
      return this.activeChains.values().next().value;
    }
    return this.activeChains.values().next().value;
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
