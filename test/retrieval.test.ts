// npx vitest run test/retrieval.test.ts --reporter=verbose
/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type {
  GraphNode,
  GraphRelationship,
} from "../src/types";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const GRAPH_JSONL_PATH = path.resolve(
  CURRENT_DIR,
  "output",
  "simulate",
  "graph.jsonl"
);

const EMBEDDING_DIM = 64;

function simpleEmbedding(text: string, dim: number = EMBEDDING_DIM): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

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

interface GraphEntry {
  chainId: string;
  nodes: GraphNode[];
  rels: GraphRelationship[];
  timestamp: number;
}

interface ChainPrompt {
  chainId: string;
  intent: string;
  actions: string[];
  outcome: string;
  dependencyChain: string[];
  prompt: string;
}

function loadGraphEntries(): GraphEntry[] {
  const raw = fs.readFileSync(GRAPH_JSONL_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function buildChainPrompt(entry: GraphEntry): ChainPrompt {
  const intentNode = entry.nodes.find((n) => n.type === "Intent")!;
  const outcomeNode = entry.nodes.find((n) => n.type === "Outcome");
  const actionNodes = entry.nodes.filter((n) => n.type === "Action");

  const dependsRels = entry.rels.filter((r) => r.type === "DEPENDS_ON");
  const resultsInRel = entry.rels.find((r) => r.type === "RESULTS_IN");

  const depChain: string[] = [];
  for (const dep of dependsRels) {
    const fromNode = entry.nodes.find((n) => dep.from.includes(n.id));
    const toNode = entry.nodes.find((n) => dep.to.includes(n.id));
    if (fromNode && toNode) {
      const w = dep.properties?.weight ?? 0;
      depChain.push(
        `${fromNode.label}(${fromNode.properties.toolCallId ?? fromNode.id}) → ${toNode.label}(${toNode.properties.toolCallId ?? toNode.id}) [weight=${w}]`
      );
    }
  }

  const actionWeights = resultsInRel?.properties?.actionWeights as
    | Record<string, number>
    | undefined;
  const actionDescs = actionNodes.map((a) => {
    const w = actionWeights?.[a.id] ?? 0;
    const args = a.properties.arguments
      ? JSON.stringify(a.properties.arguments)
      : "";
    return `  - ${a.label}(${a.properties.toolCallId ?? a.id}): args=${args}, resultWeight=${w}`;
  });

  const outcomeText = outcomeNode?.label ?? "(无)";

  const prompt = [
    `[历史事件链] chainId=${entry.chainId}`,
    `意图: ${intentNode.label}`,
    `动作序列(${actionNodes.length}步):`,
    ...actionDescs,
    depChain.length > 0
      ? `依赖关系:\n${depChain.map((d) => `  ${d}`).join("\n")}`
      : "依赖关系: 无",
    `结果: ${outcomeText}`,
  ].join("\n");

  return {
    chainId: entry.chainId,
    intent: intentNode.label,
    actions: actionNodes.map((a) => a.label),
    outcome: outcomeText,
    dependencyChain: depChain,
    prompt,
  };
}

function retrieveChains(
  query: string,
  entries: GraphEntry[],
  chainPrompts: ChainPrompt[]
): Array<{ chainPrompt: ChainPrompt; score: number }> {
  const queryEmbedding = simpleEmbedding(query);

  const results = entries.map((entry, idx) => {
    const intentNode = entry.nodes.find((n) => n.type === "Intent")!;
    const actionNodes = entry.nodes.filter((n) => n.type === "Action");
    const embeddingText =
      intentNode.label + " " + actionNodes.map((a) => a.label).join(" ");
    const chainEmbedding = simpleEmbedding(embeddingText);
    const score = cosineSimilarity(queryEmbedding, chainEmbedding);
    return { chainPrompt: chainPrompts[idx], score };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

describe("retrieval: 历史事件链检索测试", () => {
  let graphEntries: GraphEntry[];
  let chainPrompts: ChainPrompt[];

  beforeAll(() => {
    graphEntries = loadGraphEntries();
    chainPrompts = graphEntries.map(buildChainPrompt);
  });

  it("应能加载 graph.jsonl 并构建事件链 prompt", () => {
    expect(graphEntries.length).toBe(4);
    expect(chainPrompts.length).toBe(4);

    for (const cp of chainPrompts) {
      expect(cp.chainId).toBeTruthy();
      expect(cp.intent).toBeTruthy();
      expect(cp.actions.length).toBeGreaterThan(0);
      expect(cp.prompt.length).toBeGreaterThan(0);
    }
  });

  const queries = [
    "今天上证指数收盘多少点？",
    "比特币当前价格是多少？",
    "明天北京天气怎么样？",
    "今天leetcode 每日一题是什么",
  ];

  for (const query of queries) {
    it(`检索: "${query}"`, () => {
      const results = retrieveChains(query, graphEntries, chainPrompts);

      expect(results.length).toBe(graphEntries.length);

      console.log(`\n${"=".repeat(60)}`);
      console.log(`查询: ${query}`);
      console.log(`${"=".repeat(60)}`);

      for (let i = 0; i < results.length; i++) {
        const { chainPrompt, score } = results[i];
        console.log(`\n--- 排名 #${i + 1} | 置信度: ${score.toFixed(4)} ---`);
        console.log(chainPrompt.prompt);
      }

      console.log(`\n${"=".repeat(60)}\n`);

      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(-1);
        expect(r.score).toBeLessThanOrEqual(1);
      }

      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
      }
    });
  }
});
