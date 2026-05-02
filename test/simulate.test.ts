/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Processor } from "../src/processor";
import type {
  EventChain,
  GraphNode,
  GraphRelationship,
} from "../src/types";

// 解析当前测试文件所在目录；避免与 Node 注入的 __dirname/__filename 变量冲突
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 集中放置所有路径与配置的静态变量，便于后续维护
 * - LOG_PATH：被回放的日志源（按行读取）
 * - OUTPUT_DIR：所有产物的输出目录
 * - 其余四个 *_PATH 与本测试需要持久化的产物一一对应
 */
class Paths {
  static readonly LOG_PATH = path.resolve(CURRENT_DIR, "v1.7.log");
  static readonly OUTPUT_DIR = path.resolve(CURRENT_DIR, "output", "simulate");
  static readonly EVENT_CHAINS_PATH = path.join(
    Paths.OUTPUT_DIR,
    "event_chains.json"
  );
  static readonly EVENT_CHAINS_RAW_PATH = path.join(
    Paths.OUTPUT_DIR,
    "event_chains_raw.json"
  );
  static readonly EVENT_CHAINS_VECTOR_PATH = path.join(
    Paths.OUTPUT_DIR,
    "event_chains_vector.json"
  );
  static readonly GRAPH_DATA_PATH = path.join(
    Paths.OUTPUT_DIR,
    "graph_data.json"
  );
  static readonly GRAPH_DATA_RAW_PATH = path.join(
    Paths.OUTPUT_DIR,
    "graph_data_raw.json"
  );
  static readonly GRAPH_DATA_VECTOR_PATH = path.join(
    Paths.OUTPUT_DIR,
    "graph_data_vector.json"
  );
  // Storage 在 init 时会按需创建目录；这两个文件由 Storage 内部维护
  static readonly LANCE_DB_PATH = path.join(Paths.OUTPUT_DIR, "lance.db");
  static readonly GRAPH_LOG_PATH = path.join(Paths.OUTPUT_DIR, "graph.jsonl");

  // 嵌入维度需与 processor.ts 中保持一致，便于跨文件复用
  static readonly EMBEDDING_DIM = 64;
}

// 与 processor.ts 中的实现保持一致的字符级嵌入函数
// 用于把图谱节点 label 单独再做一次向量化保存
function simpleEmbedding(text: string, dim: number = Paths.EMBEDDING_DIM): number[] {
  const vec = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// 把日志的 category 映射到 Processor 的具体处理函数
// 没有匹配到的 category（如 lifecycle/plugin/llm_output）跳过
async function dispatchLogEvent(processor: Processor, event: any): Promise<void> {
  switch (event?.category) {
    case "user_input":
      // 用户消息进入：触发用户意图记录与相似度检索
      await processor.onMessageReceived(event);
      break;
    case "agent_plan":
      // reply_dispatch：根据 runId 建立/补全事件链
      processor.onReplyDispatch(event);
      break;
    case "tool_call":
      // before_tool_call：把工具调用追加到当前活跃链
      processor.onBeforeToolCall(event);
      break;
    case "tool_result":
      // after_tool_call：回填上一条工具调用的结果
      processor.onAfterToolCall(event);
      break;
    case "agent_end":
      // agent_end：归档事件链 + 写入图谱
      await processor.onAgentEnd(event);
      break;
    default:
      // 其它类别（生命周期、插件注册、LLM 输出等）此处不参与回放
      break;
  }
}

// 把 Storage 内部聚合后的图谱再写入到独立的 JSON 文件
// Storage 的 graphs 是私有字段，仅在测试内通过类型断言访问
function readGraphsFromProcessor(processor: Processor): Map<
  string,
  { nodes: GraphNode[]; rels: GraphRelationship[] }
> {
  const storage: any = (processor as any).storage;
  return storage.graphs as Map<
    string,
    { nodes: GraphNode[]; rels: GraphRelationship[] }
  >;
}

function readChainsFromProcessor(processor: Processor): Map<string, EventChain> {
  const storage: any = (processor as any).storage;
  return storage.chains as Map<string, EventChain>;
}

// 准备一个干净的输出目录，避免历史数据污染断言
function resetOutputDir(): void {
  if (fs.existsSync(Paths.OUTPUT_DIR)) {
    fs.rmSync(Paths.OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(Paths.OUTPUT_DIR, { recursive: true });
}

describe("simulate: replay v1.7.log via Processor", () => {
  let processor: Processor;
  // 收集回放过程中得到的事件链与图谱，方便后续断言与导出
  const collectedChains: EventChain[] = [];
  const collectedGraphs: Array<{
    chainId: string;
    nodes: GraphNode[];
    rels: GraphRelationship[];
  }> = [];

  beforeAll(async () => {
    // 1. 初始化输出目录与 Processor
    resetOutputDir();
    processor = new Processor({
      lanceDbPath: Paths.LANCE_DB_PATH,
      graphLogPath: Paths.GRAPH_LOG_PATH,
    });
    await processor.init();

    // 2. 按行读取日志，逐条 parse 后转发到对应的处理函数
    const raw = fs.readFileSync(Paths.LOG_PATH, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l: string) => l.trim());
    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // 单行格式错误时不阻断回放，跳过即可
        continue;
      }
      await dispatchLogEvent(processor, event);
    }

    // 3. 从 Processor 内部聚合事件链与图谱，作为断言/导出来源
    for (const chain of readChainsFromProcessor(processor).values()) {
      collectedChains.push(chain);
    }
    for (const [chainId, g] of readGraphsFromProcessor(processor).entries()) {
      collectedGraphs.push({ chainId, nodes: g.nodes, rels: g.rels });
    }

    // 4. 持久化结果，供后续分析与调试使用
    //    4.1 事件链（完整结构，含 events / toolSequence / embedding）
    fs.writeFileSync(
      Paths.EVENT_CHAINS_PATH,
      JSON.stringify(collectedChains, null, 2),
      "utf-8"
    );
    //    4.1.1 事件链原始文本视图：剥掉向量，只留人可读字段，方便人工审阅
    const chainsRaw = collectedChains.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      timestamp: c.timestamp,
      userIntent: c.userIntent,
      toolSequence: c.toolSequence,
      outcome: c.outcome,
      events: c.events,
    }));
    //    4.1.2 事件链向量视图：只留检索所需的键字段 + embedding，对齐 graph_data_vector
    const chainsVector = collectedChains.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      userIntent: c.userIntent,
      toolSequence: c.toolSequence,
      outcome: c.outcome,
      embedding: c.embedding,
    }));
    fs.writeFileSync(
      Paths.EVENT_CHAINS_RAW_PATH,
      JSON.stringify(chainsRaw, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      Paths.EVENT_CHAINS_VECTOR_PATH,
      JSON.stringify(chainsVector, null, 2),
      "utf-8"
    );
    //    4.2 图谱数据（原始结构，含节点与关系）
    fs.writeFileSync(
      Paths.GRAPH_DATA_PATH,
      JSON.stringify(collectedGraphs, null, 2),
      "utf-8"
    );

    // 5. 把图谱拆分为两种形态：原始文本 + 向量化
    const graphRaw = collectedGraphs.map((g) => ({
      chainId: g.chainId,
      nodes: g.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label, // 仅保留可读文本，便于人工检查
        properties: n.properties,
      })),
      rels: g.rels,
    }));
    const graphVector = collectedGraphs.map((g) => ({
      chainId: g.chainId,
      nodes: g.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        // 用文本 label 生成节点向量，与 processor.ts 中的策略保持一致
        embedding: simpleEmbedding(n.label),
        properties: n.properties,
      })),
      rels: g.rels,
    }));
    fs.writeFileSync(
      Paths.GRAPH_DATA_RAW_PATH,
      JSON.stringify(graphRaw, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      Paths.GRAPH_DATA_VECTOR_PATH,
      JSON.stringify(graphVector, null, 2),
      "utf-8"
    );
  });

  afterAll(async () => {
    await processor.close();
  });

  // ===== 断言：日志解析与基本回放 =====
  it("应能完整读取并解析 v1.7.log 中的所有事件", () => {
    const raw = fs.readFileSync(Paths.LOG_PATH, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l: string) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // 每行都必须是合法 JSON，否则属于日志本身的问题
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // ===== 断言：事件链构建 =====
  it("应基于日志中的两个会话构建出两条 runId 与 userIntent 正确配对的事件链", () => {
    expect(collectedChains.length).toBe(2);

    // 找到日志里两个会话各自的事件链
    const stockChain = collectedChains.find(
      (c) => c.taskId === "76fb1627-5283-4dcc-8433-33181ba33a25"
    );
    const leetcodeChain = collectedChains.find(
      (c) => c.taskId === "481aa500-3213-49ed-841e-f42d64af6f7b"
    );
    expect(stockChain).toBeDefined();
    expect(leetcodeChain).toBeDefined();

    // userIntent 必须与各自 runId 对应的真实问题匹配
    expect(stockChain!.userIntent).toBe("给出今天美股涨的最高的股票");
    expect(leetcodeChain!.userIntent).toBe("今天leetcode每日一题是什么");

    // 每条链字段完整、向量长度正确
    for (const c of [stockChain!, leetcodeChain!]) {
      expect(c.id).toBeTruthy();
      expect(Array.isArray(c.events)).toBe(true);
      expect(Array.isArray(c.toolSequence)).toBe(true);
      expect(c.embedding.length).toBe(Paths.EMBEDDING_DIM);
    }
  });

  it("两条事件链的工具序列应分别还原各自会话的调用顺序", () => {
    const stockChain = collectedChains.find(
      (c) => c.taskId === "76fb1627-5283-4dcc-8433-33181ba33a25"
    )!;
    const leetcodeChain = collectedChains.find(
      (c) => c.taskId === "481aa500-3213-49ed-841e-f42d64af6f7b"
    )!;

    // 美股会话：日志依次出现 exec, exec, web_crawl
    expect(stockChain.toolSequence).toEqual(["exec", "exec", "web_crawl"]);
    expect(stockChain.outcome).toBe("success");

    // LeetCode 会话：依次出现 exec, web_crawl, exec, web_crawl
    expect(leetcodeChain.toolSequence).toEqual([
      "exec",
      "web_crawl",
      "exec",
      "web_crawl",
    ]);
    expect(leetcodeChain.outcome).toBe("success");

    // 工具调用 metadata 都应被 after_tool_call 回填
    for (const chain of [stockChain, leetcodeChain]) {
      const toolEvents = chain.events.filter((e) => e.type === "tool_call");
      expect(toolEvents.length).toBe(chain.toolSequence.length);
      for (const ev of toolEvents) {
        expect(ev.metadata.toolName).toBeTruthy();
        expect(ev.metadata.result).toBeDefined();
        expect(ev.metadata.success).toBe(true);
      }
    }
  });

  // ===== 断言：图谱构建 =====
  it("每条事件链都应生成对应的 Intent → Action* → Outcome 图谱", () => {
    expect(collectedGraphs.length).toBeGreaterThanOrEqual(2);

    for (const g of collectedGraphs) {
      // 至少包含一个 Intent 与一个 Outcome
      const intents = g.nodes.filter((n) => n.type === "Intent");
      const outcomes = g.nodes.filter((n) => n.type === "Outcome");
      expect(intents.length).toBe(1);
      expect(outcomes.length).toBe(1);

      // 关系类型应限定在 Processor 实际产出的几种之内
      for (const r of g.rels) {
        expect(["TRIGGERS", "LEADS_TO", "RESULTS_IN"]).toContain(r.type);
      }

      // Intent 是图的起点，与第一个 Action（或直接到 Outcome）通过 TRIGGERS 连接
      const intentId = intents[0].id;
      const fromIntent = g.rels.filter((r) => r.from === intentId);
      expect(fromIntent.length).toBe(1);
      expect(fromIntent[0].type).toBe("TRIGGERS");

      // Outcome 是图的终点，最后一条关系应该指向它且为 RESULTS_IN
      const outcomeId = outcomes[0].id;
      const toOutcome = g.rels.filter((r) => r.to === outcomeId);
      expect(toOutcome.length).toBe(1);
      expect(toOutcome[0].type).toBe("RESULTS_IN");
    }
  });

  // ===== 断言：产物落盘 =====
  it("应落盘六份产物：event_chains(+raw/vector) / graph_data(+raw/vector)", () => {
    for (const p of [
      Paths.EVENT_CHAINS_PATH,
      Paths.EVENT_CHAINS_RAW_PATH,
      Paths.EVENT_CHAINS_VECTOR_PATH,
      Paths.GRAPH_DATA_PATH,
      Paths.GRAPH_DATA_RAW_PATH,
      Paths.GRAPH_DATA_VECTOR_PATH,
    ]) {
      expect(fs.existsSync(p)).toBe(true);
    }

    // event_chains.json：内容能反序列化，并保留必要字段
    const chains = JSON.parse(
      fs.readFileSync(Paths.EVENT_CHAINS_PATH, "utf-8")
    ) as EventChain[];
    expect(Array.isArray(chains)).toBe(true);
    expect(chains.length).toBe(collectedChains.length);
    for (const c of chains) {
      expect(c.id).toBeTruthy();
      expect(c.taskId).toBeTruthy();
      expect(Array.isArray(c.events)).toBe(true);
      expect(Array.isArray(c.toolSequence)).toBe(true);
      expect(Array.isArray(c.embedding)).toBe(true);
    }

    // event_chains_raw.json：人工审阅用，必须保留 userIntent 文本，且不含 embedding
    const rawChains = JSON.parse(
      fs.readFileSync(Paths.EVENT_CHAINS_RAW_PATH, "utf-8")
    );
    expect(rawChains.length).toBe(collectedChains.length);
    for (const c of rawChains) {
      expect(typeof c.userIntent).toBe("string");
      expect(c.embedding).toBeUndefined();
    }

    // event_chains_vector.json：每条链都必须挂着等长 embedding
    const vecChains = JSON.parse(
      fs.readFileSync(Paths.EVENT_CHAINS_VECTOR_PATH, "utf-8")
    );
    expect(vecChains.length).toBe(collectedChains.length);
    for (const c of vecChains) {
      expect(Array.isArray(c.embedding)).toBe(true);
      expect(c.embedding.length).toBe(Paths.EMBEDDING_DIM);
    }

    // 原始与向量两份事件链应在 id 顺序与 toolSequence 上保持一致，便于后续对齐
    for (let i = 0; i < rawChains.length; i++) {
      expect(vecChains[i].id).toBe(rawChains[i].id);
      expect(vecChains[i].toolSequence).toEqual(rawChains[i].toolSequence);
    }

    // graph_data_raw.json：节点必须保留可读 label
    const rawGraphs = JSON.parse(
      fs.readFileSync(Paths.GRAPH_DATA_RAW_PATH, "utf-8")
    );
    expect(rawGraphs.length).toBe(collectedGraphs.length);
    for (const g of rawGraphs) {
      for (const n of g.nodes) {
        expect(typeof n.label).toBe("string");
      }
    }

    // graph_data_vector.json：节点必须有等长向量
    const vecGraphs = JSON.parse(
      fs.readFileSync(Paths.GRAPH_DATA_VECTOR_PATH, "utf-8")
    );
    expect(vecGraphs.length).toBe(collectedGraphs.length);
    for (const g of vecGraphs) {
      for (const n of g.nodes) {
        expect(Array.isArray(n.embedding)).toBe(true);
        expect(n.embedding.length).toBe(Paths.EMBEDDING_DIM);
      }
    }

    // 原始与向量两份图谱应在节点数量与关系上保持一致，便于后续对齐
    for (let i = 0; i < rawGraphs.length; i++) {
      expect(vecGraphs[i].chainId).toBe(rawGraphs[i].chainId);
      expect(vecGraphs[i].nodes.length).toBe(rawGraphs[i].nodes.length);
      expect(vecGraphs[i].rels.length).toBe(rawGraphs[i].rels.length);
    }
  });

  // ===== 断言：历史事件链检索 =====
  it("基于向量的历史事件链检索应能按语义命中对应会话", async () => {
    // 直接用 Storage.searchSimilar，避免 onMessageReceived 的副作用污染 activeChains
    const storage: any = (processor as any).storage;

    // 构造与历史链同源的查询向量：用 userIntent + toolSequence，与 onAgentEnd 中保持一致
    const stockChain = collectedChains.find(
      (c) => c.taskId === "76fb1627-5283-4dcc-8433-33181ba33a25"
    )!;
    const leetcodeChain = collectedChains.find(
      (c) => c.taskId === "481aa500-3213-49ed-841e-f42d64af6f7b"
    )!;

    // 1. 用美股相关查询应优先命中美股链
    //    simpleEmbedding 是字符频率哈希，查询文本需与目标 userIntent 字符分布接近
    const stockQueryVec = simpleEmbedding(
      "今天美股涨的最多的股票是哪只 exec web_crawl"
    );
    const stockHits = await storage.searchSimilar(stockQueryVec, 5);
    expect(stockHits.length).toBeGreaterThan(0);
    expect(stockHits[0].chain.id).toBe(stockChain.id);
    // 相似度应为合法分数
    for (const h of stockHits) {
      expect(typeof h.score).toBe("number");
      expect(h.score).toBeGreaterThanOrEqual(-1);
      expect(h.score).toBeLessThanOrEqual(1);
    }

    // 2. 用 LeetCode 相关查询应优先命中 LeetCode 链
    const leetcodeQueryVec = simpleEmbedding(
      "今天leetcode每日一题的题目 exec web_crawl"
    );
    const leetcodeHits = await storage.searchSimilar(leetcodeQueryVec, 5);
    expect(leetcodeHits.length).toBeGreaterThan(0);
    expect(leetcodeHits[0].chain.id).toBe(leetcodeChain.id);

    // 3. topK 截断生效
    const topOne = await storage.searchSimilar(stockQueryVec, 1);
    expect(topOne.length).toBe(1);

    // 4. 走 Processor.onMessageReceived 也应能在保存的历史里检索到自身或同类
    //    新建链会污染 activeChains，测试结束后清理
    const retrieval = await processor.onMessageReceived({
      time: Date.now(),
      data: { original: "今天美股表现最好的股票", taskId: "probe-stock" },
    });
    expect(Array.isArray(retrieval)).toBe(true);
    expect(retrieval.length).toBeGreaterThan(0);
    // 排在最前的应该是历史里两条链之一（最相似的命中是 stockChain 但不强约束顺序）
    const top = retrieval[0];
    const histIds = collectedChains.map((c) => c.id);
    expect(histIds).toContain(top.chain.id);

    // 清理 probe，避免影响后续 afterAll
    (processor as any).activeChains.delete("probe-stock");
    (processor as any).pendingTaskId = null;
  });
});
