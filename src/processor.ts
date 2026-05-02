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

    return results;
  }

  onReplyDispatch(event: any): void {
    const parsed = parseDataContent(event);
    if (!parsed) return;

    const taskId = parsed.runId ?? parsed.ctx?.MessageSid;
    if (!taskId) return;

    let chain = this.activeChains.get(taskId);
    if (!chain) {
      const userText =
        parsed.ctx?.Body ?? parsed.ctx?.RawBody ?? "";
      chain = {
        id: randomUUID(),
        taskId,
        timestamp: event?.time
          ? new Date(event.time).getTime()
          : Date.now(),
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
      this.activeChains.set(taskId, chain);
    }
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
      event?.data?.runId ?? event?.data?.taskId;

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

    let prevNodeId = intentNode.id;
    for (const toolName of chain.toolSequence) {
      const actionNode: GraphNode = {
        id: `action-${chain.id}-${toolName}-${nodes.length}`,
        type: "Action",
        label: toolName,
        properties: {},
      };
      nodes.push(actionNode);

      const relType =
        prevNodeId === intentNode.id ? "TRIGGERS" : "LEADS_TO";
      rels.push({
        from: prevNodeId,
        to: actionNode.id,
        type: relType,
      });
      prevNodeId = actionNode.id;
    }

    const outcomeNode: GraphNode = {
      id: `outcome-${chain.id}`,
      type: "Outcome",
      label: chain.outcome,
      properties: {},
    };
    nodes.push(outcomeNode);
    rels.push({
      from: prevNodeId,
      to: outcomeNode.id,
      type: "RESULTS_IN",
    });

    await this.storage.saveGraph(chain.id, nodes, rels);
    this.activeChains.delete(chain.taskId);
  }

  private findChainForToolEvent(event: any): EventChain | undefined {
    const taskId = event?.data?.taskId;
    if (taskId && this.activeChains.has(taskId)) {
      return this.activeChains.get(taskId);
    }
    if (this.activeChains.size === 1) {
      return this.activeChains.values().next().value;
    }
    return this.activeChains.values().next().value;
  }
}
