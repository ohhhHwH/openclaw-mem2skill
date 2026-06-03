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
import { simpleEmbedding } from "../src/processor";
import { cosineSimilarity } from "../src/storage";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const GRAPH_JSONL_PATH = path.resolve(
  CURRENT_DIR,
  "output",
  "simulate",
  "graph.jsonl"
);

const SCORE_THRESHOLD = 0.8;

interface GraphEntry {
  chainId: string;
  nodes: GraphNode[];
  rels: GraphRelationship[];
  timestamp: number;
}

function loadGraphEntries(): GraphEntry[] {
  const raw = fs.readFileSync(GRAPH_JSONL_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// 从 DEPENDS_ON 边构建拓扑排序，体现工具调用的因果顺序
function topoSortActions(
  actionNodes: GraphNode[],
  dependsRels: GraphRelationship[]
): GraphNode[] {
  const idToNode = new Map(actionNodes.map((n) => [n.id, n]));
  const inDegree = new Map(actionNodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(actionNodes.map((n) => [n.id, []]));

  for (const dep of dependsRels) {
    const fromId = dep.from.find((id) => idToNode.has(id));
    const toId = dep.to.find((id) => idToNode.has(id));
    if (fromId && toId) {
      adj.get(fromId)!.push(toId);
      inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1);
    }
  }

  const queue = actionNodes.filter((n) => inDegree.get(n.id) === 0);
  const sorted: GraphNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const nextId of adj.get(node.id) ?? []) {
      const deg = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) {
        const next = idToNode.get(nextId);
        if (next) queue.push(next);
      }
    }
  }

  // 追加未被拓扑排序覆盖的孤立节点
  for (const n of actionNodes) {
    if (!sorted.includes(n)) sorted.push(n);
  }
  return sorted;
}

function buildPrompt(entry: GraphEntry): string {
  const intentNode = entry.nodes.find((n) => n.type === "Intent")!;
  const outcomeNode = entry.nodes.find((n) => n.type === "Outcome");
  const actionNodes = entry.nodes.filter((n) => n.type === "Action");
  const dependsRels = entry.rels.filter((r) => r.type === "DEPENDS_ON");
  const resultsInRel = entry.rels.find((r) => r.type === "RESULTS_IN");
  const actionWeights = (resultsInRel?.properties?.actionWeights ?? {}) as Record<string, number>;

  // 按因果拓扑排序
  const sorted = topoSortActions(actionNodes, dependsRels);

  // 构建每个 action 的上游依赖映射 (toId -> fromIds[])
  const upstreamMap = new Map<string, { fromLabel: string; weight: number }[]>();
  for (const dep of dependsRels) {
    const fromNode = entry.nodes.find((n) => dep.from.includes(n.id));
    const toNode = entry.nodes.find((n) => dep.to.includes(n.id));
    if (fromNode && toNode) {
      if (!upstreamMap.has(toNode.id)) upstreamMap.set(toNode.id, []);
      upstreamMap.get(toNode.id)!.push({
        fromLabel: formatActionLabel(fromNode),
        weight: dep.properties?.weight ?? 0,
      });
    }
  }

  const lines: string[] = [];
  lines.push(`用户意图: ${intentNode.label}`);
  lines.push("");
  lines.push(`执行路径:`);

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const query = extractQuery(a);
    const rw = actionWeights[a.id];
    const rwTag = rw > 0.01 ? ` [贡献度=${rw}]` : "";

    const upstream = upstreamMap.get(a.id);
    let causeTag = "";
    if (upstream && upstream.length > 0) {
      // 取权重最高的上游作为因果说明
      const top = upstream.sort((a, b) => b.weight - a.weight)[0];
      causeTag = ` ← 基于 ${top.fromLabel} 的结果`;
    }

    lines.push(`  ${i + 1}. ${a.label}(${query})${causeTag}${rwTag}`);
  }

  if (outcomeNode) {
    lines.push("");
    lines.push(`结果: ${outcomeNode.label}`);
  }

  return lines.join("\n");
}

function formatActionLabel(node: GraphNode): string {
  const q = extractQuery(node);
  return `${node.label}(${q})`;
}

function extractQuery(node: GraphNode): string {
  const args = node.properties.arguments;
  if (!args) return "";
  if (typeof args === "string") return args;
  return args.query ?? args.url ?? Object.values(args)[0] ?? "";
}

function retrieveChains(
  query: string,
  entries: GraphEntry[]
): Array<{ prompt: string; score: number; intent: string }> {
  const queryEmbedding = simpleEmbedding(query);

  const results = entries.map((entry) => {
    const intentNode = entry.nodes.find((n) => n.type === "Intent")!;
    const actionNodes = entry.nodes.filter((n) => n.type === "Action");
    const embeddingText =
      intentNode.label + " " + actionNodes.map((a) => a.label).join(" ");
    const chainEmbedding = simpleEmbedding(embeddingText);
    const score = cosineSimilarity(queryEmbedding, chainEmbedding);
    return { prompt: buildPrompt(entry), score, intent: intentNode.label };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

describe("retrieval: 历史事件链检索测试", () => {
  let graphEntries: GraphEntry[];

  beforeAll(() => {
    graphEntries = loadGraphEntries();
  });

  it("应能加载 graph.jsonl", () => {
    expect(graphEntries.length).toBe(4);
    for (const entry of graphEntries) {
      expect(entry.nodes.find((n) => n.type === "Intent")).toBeDefined();
      expect(entry.nodes.filter((n) => n.type === "Action").length).toBeGreaterThan(0);
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
      const all = retrieveChains(query, graphEntries);
      const hits = all.filter((r) => r.score >= SCORE_THRESHOLD);

      console.log(`\n查询: ${query}`);
      console.log(`命中: ${hits.length}/${all.length} (阈值=${SCORE_THRESHOLD})`);

      if (hits.length === 0) {
        console.log(`无匹配的历史事件链 (最高置信度=${all[0]?.score.toFixed(4) ?? "N/A"})`);
      }

      for (let i = 0; i < hits.length; i++) {
        const { prompt, score } = hits[i];
        console.log(`\n#${i + 1} 置信度: ${score.toFixed(4)}`);
        console.log(prompt);
      }

      console.log("");

      // 分数合法性
      for (const r of all) {
        expect(r.score).toBeGreaterThanOrEqual(-1);
        expect(r.score).toBeLessThanOrEqual(1);
      }
      // 降序排列
      for (let i = 0; i < all.length - 1; i++) {
        expect(all[i].score).toBeGreaterThanOrEqual(all[i + 1].score);
      }
    });
  }
});
