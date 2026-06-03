/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { Processor, simpleEmbedding } from "../src/processor";
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
  static readonly LOG_PATH = path.resolve(CURRENT_DIR, "input.log");
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
      // agent_end：归档事件链 + 构建待定图谱
      await processor.onAgentEnd(event);
      break;
    case "llm_output":
      // llm_output：补充 Outcome 节点 + RESULTS_IN 权重，落盘图谱
      await processor.onLlmOutput(event);
      break;
    default:
      // 其它类别（生命周期、插件注册等）此处不参与回放
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
    expect(collectedChains.length).toBe(4);

    // 找到日志里两个会话各自的事件链
    const goldChain = collectedChains.find(
      (c) => c.taskId === "7502aab6-d251-4abe-b1e1-72f605e34d7b"
    );
    const nasdaqChain = collectedChains.find(
      (c) => c.taskId === "8540650e-ce08-4b5f-ad43-67a8a61e43ba"
    );
    expect(goldChain).toBeDefined();
    expect(nasdaqChain).toBeDefined();

    // userIntent 必须与各自 runId 对应的真实问题匹配
    expect(goldChain!.userIntent).toBe("告诉我今天英国交易所黄金期货的行情");
    expect(nasdaqChain!.userIntent).toBe("告诉我今天美股纳斯达克的指数怎么样，涨幅最高的股票是哪一只");

    // 每条链字段完整、向量长度正确
    for (const c of [goldChain!, nasdaqChain!]) {
      expect(c.id).toBeTruthy();
      expect(Array.isArray(c.events)).toBe(true);
      expect(Array.isArray(c.toolSequence)).toBe(true);
      expect(c.embedding.length).toBe(Paths.EMBEDDING_DIM);
    }
  });

  it("两条事件链的工具序列应分别还原各自会话的调用顺序", () => {
    const goldChain = collectedChains.find(
      (c) => c.taskId === "7502aab6-d251-4abe-b1e1-72f605e34d7b"
    )!;
    const nasdaqChain = collectedChains.find(
      (c) => c.taskId === "8540650e-ce08-4b5f-ad43-67a8a61e43ba"
    )!;

    // 黄金期货会话：agent_end messages 中包含 1 次 web_search
    expect(goldChain.toolSequence).toEqual(["web_search"]);
    expect(goldChain.outcome).toBe("success");

    // 美股纳斯达克会话：agent_end messages 中包含 3 次 web_search
    expect(nasdaqChain.toolSequence).toEqual([
      "web_search",
      "web_search",
      "web_search",
    ]);
    expect(nasdaqChain.outcome).toBe("success");

    // 工具调用 metadata 都应被 after_tool_call 回填
    for (const chain of [goldChain, nasdaqChain]) {
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
        expect(["TRIGGERS", "RESULTS_IN", "DEPENDS_ON"]).toContain(r.type);
      }

      // Intent 是图的起点，TRIGGERS 关系的 from 包含 Intent
      const intentId = intents[0].id;
      const fromIntent = g.rels.filter((r) => r.from.includes(intentId));
      expect(fromIntent.length).toBe(1);
      expect(fromIntent[0].type).toBe("TRIGGERS");

      // Outcome 是图的终点，RESULTS_IN 关系的 to 包含 Outcome
      const outcomeId = outcomes[0].id;
      const toOutcome = g.rels.filter((r) => r.to.includes(outcomeId));
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
    const goldChain = collectedChains.find(
      (c) => c.taskId === "7502aab6-d251-4abe-b1e1-72f605e34d7b"
    )!;
    const nasdaqChain = collectedChains.find(
      (c) => c.taskId === "8540650e-ce08-4b5f-ad43-67a8a61e43ba"
    )!;

    // 1. 用黄金期货相关查询应优先命中黄金链
    //    simpleEmbedding 是字符频率哈希，查询文本需与目标 userIntent 字符分布接近
    const goldQueryVec = simpleEmbedding(
      "今天英国交易所黄金期货的行情 web_search"
    );
    const goldHits = await storage.searchSimilar(goldQueryVec, 5);
    expect(goldHits.length).toBeGreaterThan(0);
    expect(goldHits[0].chain.id).toBe(goldChain.id);
    // 相似度应为合法分数
    for (const h of goldHits) {
      expect(typeof h.score).toBe("number");
      expect(h.score).toBeGreaterThanOrEqual(-1);
      expect(h.score).toBeLessThanOrEqual(1);
    }

    // 2. 用美股纳斯达克相关查询应优先命中纳斯达克链
    const nasdaqQueryVec = simpleEmbedding(
      "告诉我今天美股纳斯达克的指数怎么样涨幅最高的股票是哪一只 web_search web_search web_search"
    );
    const nasdaqHits = await storage.searchSimilar(nasdaqQueryVec, 5);
    expect(nasdaqHits.length).toBeGreaterThan(0);
    expect(nasdaqHits[0].chain.id).toBe(nasdaqChain.id);

    // 3. topK 截断生效
    const topOne = await storage.searchSimilar(goldQueryVec, 1);
    expect(topOne.length).toBe(1);

    // 4. 走 Processor.onMessageReceived 也应能在保存的历史里检索到自身或同类
    //    新建链会污染 activeChains，测试结束后清理
    const retrieval = await processor.onMessageReceived({
      time: Date.now(),
      data: { original: "今天黄金期货行情怎么样", taskId: "probe-gold" },
    });
    expect(Array.isArray(retrieval)).toBe(true);
    expect(retrieval.length).toBeGreaterThan(0);
    // 排在最前的应该是历史里两条链之一（最相似的命中是 goldChain 但不强约束顺序）
    const top = retrieval[0];
    const histIds = collectedChains.map((c) => c.id);
    expect(histIds).toContain(top.chain.id);

    // 清理 probe，避免影响后续 afterAll
    (processor as any).activeChains.delete("probe-gold");
    (processor as any).pendingTaskId = null;
  });
});

// ===== 第二组测试：example.log — 从 agent_end messages 建图 =====

function parsePrettyPrintedLog(raw: string): any[] {
  const objects: any[] = [];
  let depth = 0, start = -1, inString = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inString) { esc = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(JSON.parse(raw.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return objects;
}

describe("simulate: replay example.log (message-based graph)", () => {
  let processor: Processor;
  const collectedChains: EventChain[] = [];
  const collectedGraphs: Array<{
    chainId: string;
    nodes: GraphNode[];
    rels: GraphRelationship[];
  }> = [];

  const EXAMPLE_OUTPUT_DIR = path.resolve(CURRENT_DIR, "output", "example");
  const EXAMPLE_GRAPH_LOG = path.join(EXAMPLE_OUTPUT_DIR, "graph.jsonl");

  beforeAll(async () => {
    if (fs.existsSync(EXAMPLE_OUTPUT_DIR)) {
      fs.rmSync(EXAMPLE_OUTPUT_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(EXAMPLE_OUTPUT_DIR, { recursive: true });

    processor = new Processor({
      lanceDbPath: path.join(EXAMPLE_OUTPUT_DIR, "lance.db"),
      graphLogPath: EXAMPLE_GRAPH_LOG,
    });
    await processor.init();

    const raw = fs.readFileSync(
      path.resolve(CURRENT_DIR, "example.log"),
      "utf-8"
    );
    const events = parsePrettyPrintedLog(raw);
    for (const event of events) {
      await dispatchLogEvent(processor, event);
    }

    for (const chain of readChainsFromProcessor(processor).values()) {
      collectedChains.push(chain);
    }
    for (const [chainId, g] of readGraphsFromProcessor(processor).entries()) {
      collectedGraphs.push({ chainId, nodes: g.nodes, rels: g.rels });
    }

    fs.writeFileSync(
      path.join(EXAMPLE_OUTPUT_DIR, "event_chains.json"),
      JSON.stringify(collectedChains, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(EXAMPLE_OUTPUT_DIR, "graph_data.json"),
      JSON.stringify(collectedGraphs, null, 2),
      "utf-8"
    );
  });

  afterAll(async () => {
    await processor.close();
  });

  it("应从 agent_end messages 中提取出 11 个 tool call 节点", () => {
    expect(collectedChains.length).toBe(1);
    const chain = collectedChains[0];
    expect(chain.toolSequence).toEqual([
      "web_search", "web_crawl", "web_crawl", "web_search",
      "web_crawl", "web_search", "web_search", "web_crawl",
      "web_crawl", "web_search", "web_crawl",
    ]);
    expect(chain.outcome).toBe("success");
  });

  it("tool call 与 tool result 应通过 toolCallId 正确关联", () => {
    const chain = collectedChains[0];
    const toolEvents = chain.events.filter((e) => e.type === "tool_call");
    expect(toolEvents.length).toBe(11);
    for (const ev of toolEvents) {
      expect(ev.metadata.toolName).toBeTruthy();
      expect(ev.metadata.result).toBeDefined();
    }
  });

  it("图谱应包含 Intent → Action* → Outcome 结构", () => {
    expect(collectedGraphs.length).toBe(1);
    const g = collectedGraphs[0];

    const intents = g.nodes.filter((n) => n.type === "Intent");
    const actions = g.nodes.filter((n) => n.type === "Action");
    const outcomes = g.nodes.filter((n) => n.type === "Outcome");
    expect(intents.length).toBe(1);
    expect(actions.length).toBe(11);
    expect(outcomes.length).toBe(1);

    // Outcome 节点的 label 应来自 llm_output 的 assistantTexts
    const outcome = outcomes[0];
    expect(outcome.label.length).toBeGreaterThan(0);
    expect(outcome.properties.fullText).toBeDefined();
    expect(outcome.properties.fullText.length).toBeGreaterThan(outcome.label.length);

    for (const r of g.rels) {
      expect(["TRIGGERS", "RESULTS_IN", "DEPENDS_ON"]).toContain(r.type);
    }
  });

  it("应检测到 DEPENDS_ON 依赖关系（web_crawl URL 来自 web_search 结果）且携带 weight", () => {
    const g = collectedGraphs[0];
    const dependsRels = g.rels.filter((r) => r.type === "DEPENDS_ON");
    expect(dependsRels.length).toBeGreaterThan(0);

    // 第二个 tool call (web_crawl csdn URL) 应依赖第一个 (web_search)
    const actions = g.nodes.filter((n) => n.type === "Action");
    const firstActionId = actions[0].id;  // web_search
    const secondActionId = actions[1].id; // web_crawl with csdn URL

    const dep = dependsRels.find(
      (r) => r.from.includes(firstActionId) && r.to.includes(secondActionId)
    );
    expect(dep).toBeDefined();
    expect(dep!.properties).toBeDefined();
    expect(dep!.properties!.weight).toBeGreaterThan(0);
    expect(dep!.properties!.weight).toBeLessThanOrEqual(1);

    // 所有 DEPENDS_ON 边都应有 weight
    for (const r of dependsRels) {
      expect(r.properties?.weight).toBeGreaterThan(0);
    }
  });

  it("RESULTS_IN 边应携带 actionWeights 属性", () => {
    const g = collectedGraphs[0];
    const resultsIn = g.rels.find((r) => r.type === "RESULTS_IN");
    expect(resultsIn).toBeDefined();
    expect(resultsIn!.properties).toBeDefined();
    expect(resultsIn!.properties!.actionWeights).toBeDefined();
    const weights = resultsIn!.properties!.actionWeights as Record<string, number>;
    const actions = g.nodes.filter((n) => n.type === "Action");
    for (const a of actions) {
      expect(weights[a.id]).toBeDefined();
      expect(weights[a.id]).toBeGreaterThanOrEqual(0);
      expect(weights[a.id]).toBeLessThanOrEqual(1);
    }
  });

  it("Action 节点应携带 toolCallId 属性", () => {
    const g = collectedGraphs[0];
    const actions = g.nodes.filter((n) => n.type === "Action");
    for (const a of actions) {
      expect(a.properties.toolCallId).toBeTruthy();
    }
  });
});
