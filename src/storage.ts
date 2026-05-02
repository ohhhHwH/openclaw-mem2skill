import fs from "fs";
import path from "path";
import type {
  EventChain,
  GraphNode,
  GraphRelationship,
  RetrievalResult,
  StorageConfig,
} from "./types";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

interface GraphLogEntry {
  chainId: string;
  nodes: GraphNode[];
  rels: GraphRelationship[];
  timestamp: number;
}

export class Storage {
  private config: StorageConfig;
  private chains: Map<string, EventChain> = new Map();
  private graphs: Map<
    string,
    { nodes: GraphNode[]; rels: GraphRelationship[] }
  > = new Map();

  constructor(config: StorageConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    ensureDir(path.dirname(this.config.graphLogPath));
    this.loadGraphLog();
  }

  async close(): Promise<void> {}

  async saveEventChain(chain: EventChain): Promise<void> {
    this.chains.set(chain.id, chain);
  }

  async searchSimilar(
    embedding: number[],
    topK: number = 5
  ): Promise<RetrievalResult[]> {
    const results: RetrievalResult[] = [];
    for (const chain of this.chains.values()) {
      const score = cosineSimilarity(embedding, chain.embedding);
      results.push({ chain, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async saveGraph(
    chainId: string,
    nodes: GraphNode[],
    rels: GraphRelationship[]
  ): Promise<void> {
    this.graphs.set(chainId, { nodes, rels });

    const entry: GraphLogEntry = {
      chainId,
      nodes,
      rels,
      timestamp: Date.now(),
    };
    fs.appendFileSync(
      this.config.graphLogPath,
      JSON.stringify(entry) + "\n",
      "utf-8"
    );
  }

  async queryByIntent(intentLabel: string): Promise<GraphNode[]> {
    const results: GraphNode[] = [];
    for (const { nodes } of this.graphs.values()) {
      for (const node of nodes) {
        if (
          node.type === "Intent" &&
          node.label.includes(intentLabel)
        ) {
          results.push(node);
        }
      }
    }
    return results;
  }

  getGraphLogPath(): string {
    return this.config.graphLogPath;
  }

  private loadGraphLog(): void {
    if (!fs.existsSync(this.config.graphLogPath)) return;
    const raw = fs.readFileSync(this.config.graphLogPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry: GraphLogEntry = JSON.parse(line);
        this.graphs.set(entry.chainId, {
          nodes: entry.nodes,
          rels: entry.rels,
        });
      } catch {
        // skip malformed lines
      }
    }
  }
}
