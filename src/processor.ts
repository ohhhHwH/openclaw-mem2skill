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

function simpleEmbedding(text: string, dim: number = 64): number[] {
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
    // agent_end 自身不带 runId 时，回退到当前会话的 currentRunId
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

    chain.embedding = simpleEmbedding(
      chain.userIntent + " " + chain.toolSequence.join(" ")
    );

    await this.storage.saveEventChain(chain);

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

    if (actionNodes.length > 0) {
      // Intent -> all Actions (one-to-many TRIGGERS)
      rels.push({
        from: [intentNode.id],
        to: actionNodes.map((n) => n.id),
        type: "TRIGGERS",
      });

      // Sequential LEADS_TO between adjacent actions
      for (let i = 0; i < actionNodes.length - 1; i++) {
        rels.push({
          from: [actionNodes[i].id],
          to: [actionNodes[i + 1].id],
          type: "LEADS_TO",
        });
      }
    }

    const outcomeNode: GraphNode = {
      id: `outcome-${chain.id}`,
      type: "Outcome",
      label: chain.outcome,
      properties: {},
    };
    nodes.push(outcomeNode);

    // All Actions -> Outcome (many-to-one RESULTS_IN)
    const resultFromIds =
      actionNodes.length > 0
        ? actionNodes.map((n) => n.id)
        : [intentNode.id];
    rels.push({
      from: resultFromIds,
      to: [outcomeNode.id],
      type: "RESULTS_IN",
    });

    await this.storage.saveGraph(chain.id, nodes, rels);
    this.activeChains.delete(chain.taskId);
    if (this.currentRunId === chain.taskId) {
      this.currentRunId = null;
    }
  }

  private findChainForToolEvent(event: any): EventChain | undefined {
    // 1. 事件自带 taskId 直接命中
    const taskId = event?.data?.taskId;
    if (taskId && this.activeChains.has(taskId)) {
      return this.activeChains.get(taskId);
    }
    // 2. 退而使用最近一次 reply_dispatch 绑定的 runId 对应的链
    if (this.currentRunId && this.activeChains.has(this.currentRunId)) {
      return this.activeChains.get(this.currentRunId);
    }
    // 3. 仍未命中时，取唯一活跃链作兜底
    if (this.activeChains.size === 1) {
      return this.activeChains.values().next().value;
    }
    return this.activeChains.values().next().value;
  }
}
