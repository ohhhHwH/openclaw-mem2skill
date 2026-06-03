import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "fs";
import path from "path";
import { log, setLogPath } from "./src/logger";
import {
  Processor,
  simpleEmbedding,
  buildLlmDependencyPrompt,
  parseLlmDependencyResponse,
  buildLabelDecompositionPrompt,
  parseLabelDecompositionResponse,
  enhanceEmbeddingWithLabels,
  detectUserFeedback,
  applyFeedbackToScores,
} from "./src/processor";
import type { LlmDependencyResult } from "./src/processor";
import { resolveConfig } from "./src/config";
import type { PluginConfig } from "./src/config";
import type {
  EventChain,
  GraphNode,
  GraphRelationship,
  RetrievalResult,
} from "./src/types";

const PLUGIN_VERSION = "1.18.6";
const DEFAULT_PREFIX = "hello openclaw,";
const questionTimestampByKey = new Map<string, number>();
let latestQuestionTimestamp: number | null = null;

let processor: Processor | null = null;
let pluginConfig: PluginConfig | null = null;

// 多用户隔离：用 sessionKey/threadId 隔离每个会话的状态
const sessionState = new Map<string, {
  lastRunId: string | null;
  pendingRetrievalPrompt: string | null;
  pendingRetrievalPromise: Promise<void> | null;
  isEvaluating: boolean;
}>();

let lastLlmProvider: string | null = null;
let lastLlmModel: string | null = null;

/** 从事件中提取会话隔离 key */
function getSessionKey(event: any): string {
  return event?.sessionKey ?? event?.threadId ?? event?.taskId ?? "__default__";
}

/** 获取或创建会话状态 */
function getOrCreateSessionState(event: any) {
  const key = getSessionKey(event);
  let state = sessionState.get(key);
  if (!state) {
    state = {
      lastRunId: null,
      pendingRetrievalPrompt: null,
      pendingRetrievalPromise: null,
      isEvaluating: false,
    };
    sessionState.set(key, state);
  }
  return state;
}

function safeStr(val: any): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val.slice(0, 1000);
  try {
    return JSON.stringify(val).slice(0, 1000);
  } catch {
    return String(val).slice(0, 1000);
  }
}

function collectEventKeys(event: any): string[] {
  const keys = [
    event?.taskId,
    event?.threadId,
    event?.runId,
    event?.sessionKey,
    event?.messageId,
    event?.metadata?.messageId,
    event?.event?.messageId,
    event?.event?.metadata?.messageId,
    event?.ctx?.MessageSid,
    event?.ctx?.SessionKey,
  ];
  return [...new Set(keys.filter((key): key is string => Boolean(key)))];
}

function rememberQuestionTimestamp(event: any, timestamp: number): void {
  latestQuestionTimestamp = timestamp;
  for (const key of collectEventKeys(event)) {
    questionTimestampByKey.set(key, timestamp);
  }
}

function rememberLatestQuestionForEvent(event: any): void {
  if (latestQuestionTimestamp === null) return;
  for (const key of collectEventKeys(event)) {
    questionTimestampByKey.set(key, latestQuestionTimestamp);
  }
}

function resolveQuestionTimestamp(event: any, messages: any[]): number | null {
  for (const key of collectEventKeys(event)) {
    const timestamp = questionTimestampByKey.get(key);
    if (typeof timestamp === "number") return timestamp;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && typeof message?.timestamp === "number") {
      return message.timestamp;
    }
  }
  return latestQuestionTimestamp;
}

function cleanMessagesSinceQuestion(event: any): {
  messages: any[] | undefined;
  questionTimestamp: number | null;
} {
  const rawMessages = event?.messages ?? event?.event?.messages;
  if (!Array.isArray(rawMessages)) {
    return { messages: rawMessages, questionTimestamp: latestQuestionTimestamp };
  }
  const questionTimestamp = resolveQuestionTimestamp(event, rawMessages);
  if (typeof questionTimestamp !== "number") {
    return { messages: rawMessages, questionTimestamp: null };
  }
  let startIndex = -1;
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const message = rawMessages[i];
    if (
      message?.role === "user" &&
      typeof message?.timestamp === "number" &&
      message.timestamp >= questionTimestamp
    ) {
      startIndex = i;
      break;
    }
  }
  if (startIndex !== -1) {
    return { messages: rawMessages.slice(startIndex), questionTimestamp };
  }
  return {
    messages: rawMessages.filter(
      (message: any) =>
        typeof message?.timestamp !== "number" ||
        message.timestamp >= questionTimestamp
    ),
    questionTimestamp,
  };
}

// ---- 检索结果 → prompt 文本 ----

function extractQuery(node: GraphNode): string {
  const args = node.properties.arguments;
  if (!args) return "";
  if (typeof args === "string") return args;
  return args.query ?? args.url ?? Object.values(args)[0] ?? "";
}

function formatActionLabel(node: GraphNode): string {
  return `${node.label}(${extractQuery(node)})`;
}

interface GraphEntry {
  chainId: string;
  nodes: GraphNode[];
  rels: GraphRelationship[];
}

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
  for (const n of actionNodes) {
    if (!sorted.includes(n)) sorted.push(n);
  }
  return sorted;
}

function buildToolPathFromGraph(entry: GraphEntry): string {
  const actionNodes = entry.nodes.filter((n) => n.type === "Action");
  const dependsRels = entry.rels.filter((r) => r.type === "DEPENDS_ON");
  const resultsInRel = entry.rels.find((r) => r.type === "RESULTS_IN");
  const actionWeights = (resultsInRel?.properties?.actionWeights ?? {}) as Record<string, number>;

  const sorted = topoSortActions(actionNodes, dependsRels);

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
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const query = extractQuery(a);
    const rw = actionWeights[a.id];
    const rwTag = rw > 0.01 ? ` [贡献度=${rw}]` : "";

    const upstream = upstreamMap.get(a.id);
    let causeTag = "";
    if (upstream && upstream.length > 0) {
      const top = upstream.sort((x, y) => y.weight - x.weight)[0];
      causeTag = ` ← 基于 ${top.fromLabel} 的结果`;
    }

    lines.push(`${i + 1}. ${a.label}(${query})${causeTag}${rwTag}`);
  }

  return lines.join("\n");
}

function getEvalScoreFromGraph(entry: GraphEntry): number {
  const outcomeNode = entry.nodes.find((n) => n.type === "Outcome");
  return outcomeNode?.properties?.evalScore ?? 1;
}

function selectBestHit(
  hits: Array<{ result: RetrievalResult; graphEntry?: GraphEntry }>,
): { result: RetrievalResult; graphEntry?: GraphEntry } | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  let best = hits[0];
  let bestScore = -1;
  for (const hit of hits) {
    const similarity = hit.result.score;
    const evalScore = hit.graphEntry ? getEvalScoreFromGraph(hit.graphEntry) : 1;
    const combined = similarity * evalScore;
    if (combined > bestScore) {
      bestScore = combined;
      best = hit;
    }
  }
  return best;
}

function buildRetrievalPrompt(
  hits: Array<{ result: RetrievalResult; graphEntry?: GraphEntry }>,
): string {
  if (hits.length === 0) return "";

  const sections: string[] = [];

  for (let i = 0; i < hits.length; i++) {
    const { result, graphEntry } = hits[i];
    const similarity = parseFloat(result.score.toFixed(4));
    const confidence = graphEntry ? getEvalScoreFromGraph(graphEntry) : 1;
    const historyQuestion = result.chain.userIntent;

    let toolPath: string;
    if (graphEntry) {
      toolPath = buildToolPathFromGraph(graphEntry);
    } else {
      toolPath = result.chain.toolSequence.join(" → ");
    }

    // 关键指标百分比化，便于 Agent 快速解读
    const simPct = (similarity * 100).toFixed(0);
    const confPct = (confidence * 100).toFixed(0);

    sections.push("[历史经验参考]");
    sections.push(`问题语义相似度: ${simPct}% | 历史回答质量: ${confPct}%`);
    sections.push(`相似历史问题: "${historyQuestion}"`);
    sections.push("");
    sections.push("历史工具调用路径（含依赖关系与贡献度）:");
    sections.push(toolPath);
    sections.push("");

    // 基于相似度 + 置信度的分层决策建议
    sections.push("[分层决策建议]");
    if (similarity >= 0.8 && confidence >= 0.8) {
      sections.push("→ 高匹配: 可优先复用上述工具路径，根据当前问题的具体参数进行调整。");
    } else if (similarity >= 0.5 && confidence >= 0.5) {
      sections.push("→ 中等匹配: 参考上述工具选择和调用顺序，但需根据当前问题灵活调整参数与步骤。");
    } else {
      sections.push("→ 低匹配: 仅作思路参考，不必严格遵循上述路径，以当前问题的实际需求为主。");
    }
    sections.push("");

    if (i < hits.length - 1) {
      sections.push("---");
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ---- LLM 评估：对用户问题和最终回答进行评分 ----

function buildEvalPrompt(userQuestion: string, finalAnswer: string): string {
  return [
    "请从以下三个维度对 AI 助手的回答质量进行评分（每项 0-1 分）：",
    "1. accuracy（准确性）：回答内容是否准确、正确回答了用户问题",
    "2. speed（速度满意度）：基于回答长度和复杂度，是否在合理时间内给出了有效回答",
    "3. format（格式可读性）：回答的排版、结构是否清晰易读",
    "",
    `用户问题: ${userQuestion}`,
    `AI 回答: ${finalAnswer}`,
    "",
    "请以 JSON 格式回复，只包含评分，不要其他内容：",
    '{"accuracy": 0.X, "speed": 0.X, "format": 0.X, "overall": 0.X}',
  ].join("\n");
}

function parseEvalScore(text: string): number | null {
  // 优先尝试 JSON 解析（多维度评分）
  const jsonMatch = text.match(/\{[\s\S]*"accuracy"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const scores: number[] = [];
      if (typeof parsed.accuracy === "number") scores.push(parsed.accuracy);
      if (typeof parsed.speed === "number") scores.push(parsed.speed);
      if (typeof parsed.format === "number") scores.push(parsed.format);
      if (typeof parsed.overall === "number") scores.push(parsed.overall);
      if (scores.length > 0) {
        return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000;
      }
    } catch { /* fall through */ }
  }
  // 回退：匹配单个数字
  const match = text.match(/([01](?:\.\d+)?)/);
  if (!match) return null;
  const score = parseFloat(match[1]);
  if (isNaN(score) || score < 0 || score > 1) return null;
  return score;
}

async function evaluateViaRuntime(
  prompt: string,
  api: any,
  ctx: any,
): Promise<number | null> {
  if (typeof api?.runtime?.agent?.runEmbeddedPiAgent !== "function") return null;

  try {
    const sessionId = `llm-eval-${Date.now()}`;
    const config = api.config ?? {};
    const agentId = ctx?.agentId ?? "main";
    const agentsConfig = config?.agents?.defaults ?? {};

    const workspaceDir =
      ctx?.workspaceDir ??
      agentsConfig?.workspace ??
      config?.workspaceDir ??
      process.cwd();

    let agentDir: string | undefined;
    try {
      agentDir = api.runtime.agent.resolveAgentDir?.(config, agentId);
    } catch { }
    if (!agentDir) {
      agentDir = path.join(path.dirname(workspaceDir), "agents", agentId, "agent");
    }

    const sessionFile = path.join(agentDir, `llm-eval-${sessionId}.json`);

    const provider =
      ctx?.modelProviderId ?? lastLlmProvider ?? "miaoda";
    const model =
      ctx?.modelId ?? lastLlmModel ?? "miaoda-model-flash";

    log("llm_eval", "runEmbeddedPiAgent params", {
      sessionId,
      agentId,
      workspaceDir,
      agentDir,
      sessionFile,
      provider,
      model,
    });

    const result = await api.runtime.agent.runEmbeddedPiAgent({
      sessionId,
      sessionKey: ctx?.sessionKey ?? "llm-eval",
      agentId,
      messageProvider: ctx?.messageProvider,
      messageChannel: ctx?.channelId,
      sessionFile,
      workspaceDir,
      agentDir,
      config,
      prompt,
      provider,
      model,
      timeoutMs: 30000,
      runId: sessionId,
      trigger: "manual",
      toolsAllow: [],
      disableTools: true,
      disableMessageTool: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      reasoningLevel: "off",
      silentExpected: true,
    });

    const text = (result?.payloads ?? [])
      .map((p: any) => p?.text?.trim?.() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) {
      log("llm_eval", "runEmbeddedPiAgent returned empty text", {
        rawResult: safeStr(result),
      });
      return null;
    }
    return parseEvalScore(text);
  } catch (err: any) {
    log("llm_eval", "runEmbeddedPiAgent error", { error: String(err) });
    return null;
  }
}

async function evaluateViaFetch(
  prompt: string,
  config: PluginConfig,
): Promise<number | null> {
  if (!config.llmApiUrl || !config.llmApiKey) return null;

  try {
    const response = await fetch(config.llmApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 16,
      }),
    });

    if (!response.ok) {
      log("llm_eval", "LLM API request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const data = (await response.json()) as any;
    const text: string =
      data?.choices?.[0]?.message?.content?.trim() ?? "";
    return parseEvalScore(text);
  } catch (err: any) {
    log("llm_eval", "fetch error", { error: String(err) });
    return null;
  }
}

async function evaluateWithLlm(
  userQuestion: string,
  finalAnswer: string,
  config: PluginConfig,
  api: any,
  ctx?: any,
): Promise<number | null> {
  if (!userQuestion || !finalAnswer) {
    log("llm_eval", "skipped: empty question or answer", {});
    return null;
  }

  const prompt = buildEvalPrompt(userQuestion, finalAnswer);

  // 优先使用 OpenClaw runtime 内置 LLM 调用
  let score = await evaluateViaRuntime(prompt, api, ctx);
  if (typeof score === "number") {
    log("llm_eval", "evaluation complete (runtime)", {
      score,
      userQuestion: userQuestion.slice(0, 200),
      finalAnswer: finalAnswer.slice(0, 200),
    });
    return score;
  }

  // 回退到直接 fetch 外部 LLM API
  score = await evaluateViaFetch(prompt, config);
  if (typeof score === "number") {
    log("llm_eval", "evaluation complete (fetch)", {
      score,
      userQuestion: userQuestion.slice(0, 200),
      finalAnswer: finalAnswer.slice(0, 200),
    });
    return score;
  }

  log("llm_eval", "skipped: neither runtime nor fetch available", {
    hasRuntime: typeof api?.runtime?.agent?.runEmbeddedPiAgent === "function",
    hasApiUrl: !!config.llmApiUrl,
    hasApiKey: !!config.llmApiKey,
  });
  return null;
}

// ---- LLM 依赖检测：用 LLM 分析 tool call 间依赖关系及每个 tool call 的质量 ----

async function detectDependenciesWithLlm(
  toolNodes: any[],
  userQuestion: string,
  pluginConfig: PluginConfig,
  api: any,
  ctx?: any,
): Promise<LlmDependencyResult | null> {
  if (toolNodes.length < 2) return null;

  const prompt = buildLlmDependencyPrompt(toolNodes, userQuestion);
  if (!prompt) return null;

  let text: string | null = null;

  // 优先使用 OpenClaw runtime 内置 LLM 调用
  if (typeof api?.runtime?.agent?.runEmbeddedPiAgent === "function") {
    try {
      const sessionId = `llm-dep-${Date.now()}`;
      const rawConfig = api.config ?? {};
      const agentId = ctx?.agentId ?? "main";
      const agentsConfig = rawConfig?.agents?.defaults ?? {};

      const workspaceDir =
        ctx?.workspaceDir ?? agentsConfig?.workspace ?? rawConfig?.workspaceDir ?? process.cwd();

      let agentDir: string | undefined;
      try {
        agentDir = api.runtime.agent.resolveAgentDir?.(rawConfig, agentId);
      } catch {}
      if (!agentDir) {
        agentDir = path.join(path.dirname(workspaceDir), "agents", agentId, "agent");
      }

      const provider = ctx?.modelProviderId ?? lastLlmProvider ?? "miaoda";
      const model = ctx?.modelId ?? lastLlmModel ?? "miaoda-model-flash";

      const result = await api.runtime.agent.runEmbeddedPiAgent({
        sessionId,
        sessionKey: ctx?.sessionKey ?? "llm-dep",
        agentId,
        messageProvider: ctx?.messageProvider,
        messageChannel: ctx?.channelId,
        sessionFile: path.join(agentDir, `llm-dep-${sessionId}.json`),
        workspaceDir,
        agentDir,
        config: rawConfig,
        prompt,
        provider,
        model,
        timeoutMs: 30000,
        runId: sessionId,
        trigger: "manual",
        toolsAllow: [],
        disableTools: true,
        disableMessageTool: true,
        bootstrapContextMode: "lightweight",
        verboseLevel: "off",
        reasoningLevel: "off",
        silentExpected: true,
      });

      text = (result?.payloads ?? [])
        .map((p: any) => p?.text?.trim?.() ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
    } catch (err: any) {
      log("llm_dep", "runtime detection error", { error: String(err) });
    }
  }

  // 回退到 fetch
  if (!text && pluginConfig.llmApiUrl && pluginConfig.llmApiKey) {
    try {
      const response = await fetch(pluginConfig.llmApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pluginConfig.llmApiKey}`,
        },
        body: JSON.stringify({
          model: pluginConfig.llmModel ?? "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
          temperature: 0.1,
        }),
      });
      const data: any = await response.json();
      text =
        data?.choices?.[0]?.message?.content?.trim?.() ??
        data?.response?.trim?.() ??
        "";
    } catch (err: any) {
      log("llm_dep", "fetch detection error", { error: String(err) });
    }
  }

  if (!text) {
    log("llm_dep", "skipped: no LLM available", {
      hasRuntime: typeof api?.runtime?.agent?.runEmbeddedPiAgent === "function",
      hasApiUrl: !!pluginConfig.llmApiUrl,
    });
    return null;
  }

  const parsed = parseLlmDependencyResponse(text, toolNodes.length);
  if (parsed) {
    log("llm_dep", "LLM dependency detection complete", {
      userQuestion: userQuestion.slice(0, 100),
      depCount: parsed.dependencies.length,
      scores: parsed.scores,
    });
  }
  return parsed;
}

// ---- 图谱数据导出 ----

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function exportGraphData(
  chainId: string,
  nodes: GraphNode[],
  rels: GraphRelationship[],
  config: PluginConfig,
): void {
  ensureDir(config.graphDataDir);
  const timestamp = Date.now();

  const rawData = {
    chainId,
    timestamp,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      properties: n.properties,
    })),
    rels,
  };
  const rawPath = path.join(config.graphDataDir, `${chainId}_raw.json`);
  fs.writeFileSync(rawPath, JSON.stringify(rawData, null, 2), "utf-8");

  const vectorData = {
    chainId,
    timestamp,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      embedding: simpleEmbedding(n.label, config.embeddingDim),
      properties: n.properties,
    })),
    rels,
  };
  const vectorPath = path.join(config.graphDataDir, `${chainId}_vector.json`);
  fs.writeFileSync(vectorPath, JSON.stringify(vectorData, null, 2), "utf-8");

  log("graph_export", `graph data exported: ${rawPath}, ${vectorPath}`, { chainId });
}

function exportEventChainData(
  chain: EventChain,
  config: PluginConfig,
): void {
  ensureDir(config.graphDataDir);

  const rawData = {
    id: chain.id,
    taskId: chain.taskId,
    timestamp: chain.timestamp,
    userIntent: chain.userIntent,
    toolSequence: chain.toolSequence,
    outcome: chain.outcome,
    events: chain.events,
  };
  const rawPath = path.join(config.graphDataDir, `chain_${chain.id}_raw.json`);
  fs.writeFileSync(rawPath, JSON.stringify(rawData, null, 2), "utf-8");

  const vectorData = {
    id: chain.id,
    taskId: chain.taskId,
    userIntent: chain.userIntent,
    toolSequence: chain.toolSequence,
    outcome: chain.outcome,
    embedding: chain.embedding,
  };
  const vectorPath = path.join(config.graphDataDir, `chain_${chain.id}_vector.json`);
  fs.writeFileSync(vectorPath, JSON.stringify(vectorData, null, 2), "utf-8");

  log("chain_export", `event chain exported: ${rawPath}, ${vectorPath}`, { chainId: chain.id });
}

export default definePluginEntry({
  id: "memory2skill",
  name: "Memory to Skill",
  description:
    "Captures user input, agent plans, skill invocations and tool calls; retrieves similar historical chains and builds knowledge graphs",

  register(api) {
    log("lifecycle", `memory2skill v${PLUGIN_VERSION} registered`, {
      mode: api.registrationMode,
    });

    if (api.registrationMode !== "full") return;

    const userConfig = (api as any).config ?? {};
    pluginConfig = resolveConfig(userConfig);
    setLogPath(pluginConfig.logPath);

    if (!processor) {
      processor = new Processor({
        lanceDbPath: pluginConfig.lanceDbPath,
        graphLogPath: pluginConfig.graphLogPath,
      });

      processor.init().catch((err: any) => {
        log("error", "processor init failed", { error: String(err) });
      });
    }

    // ---- message_received: 检索历史事件链，构建 prompt 注入 ----
    api.on("message_received", async (event: any) => {
      const session = getOrCreateSessionState(event);
      const content =
        typeof event === "string"
          ? event
          : event?.text ?? event?.content ?? event?.message ?? safeStr(event);
      const transformed = `${DEFAULT_PREFIX} ${content}`;
      const questionTimestamp = Date.now();
      rememberQuestionTimestamp(event, questionTimestamp);

      log("user_input", "message_received", {
        original: content,
        transformed,
        taskId: event?.taskId,
        threadId: event?.threadId,
        role: event?.role,
        questionTimestamp,
        event,
      });

      if (content.startsWith("/")) return;
      if (!processor || !pluginConfig) return;

      // 检测用户反馈：如果本次消息包含对上一次回答的评价，更新对应 chain 的评分
      const feedback = detectUserFeedback(content);
      if (feedback) {
        const lastSaved = processor.getLastSavedGraph();
        if (lastSaved) {
          const outcomeNode = lastSaved.nodes.find((n) => n.type === "Outcome");
          const existingScores = (outcomeNode?.properties?.evalDimensions ?? {}) as Record<string, number>;
          const updatedScores = applyFeedbackToScores(existingScores, feedback);
          if (outcomeNode) {
            outcomeNode.properties.evalDimensions = updatedScores;
            outcomeNode.properties.userFeedback = {
              polarity: feedback.polarity,
              source: content.slice(0, 200),
              timestamp: questionTimestamp,
            };
            // 异步更新已保存的图谱
            processor.saveGraph(lastSaved.chainId, lastSaved.nodes, lastSaved.rels).catch(() => {});
          }
          log("user_feedback", "user feedback detected", {
            polarity: feedback.polarity,
            dimensions: feedback.dimensions,
            confidence: feedback.confidence,
            updatedScores,
            chainId: lastSaved.chainId,
          });
        }
      }

      const retrievalWork = (async () => {
        try {
          const results = await processor!.onMessageReceived({
            time: Date.now(),
            data: {
              original: content,
              taskId: event?.taskId ?? `task-${Date.now()}`,
            },
          });

          const threshold = pluginConfig!.scoreThreshold;
          const filtered = results.filter((r) => r.score >= threshold);

          if (filtered.length === 0) {
            log("retrieval", "no hits above threshold", {
              total: results.length,
              threshold,
              topScore: results[0]?.score,
              topQuestion: results[0]?.chain.userIntent,
            });
            return;
          }

          const graphsMap = processor!.getGraphs();

          const hits = filtered.map((result) => {
            let graphEntry: GraphEntry | undefined;
            for (const [chainId, g] of graphsMap.entries()) {
              const intentNode = g.nodes.find((n: GraphNode) => n.type === "Intent");
              if (intentNode?.properties?.taskId === result.chain.taskId) {
                graphEntry = { chainId, nodes: g.nodes, rels: g.rels };
                break;
              }
            }
            return { result, graphEntry };
          });

          const bestHit = selectBestHit(hits);
          const prompt = bestHit ? buildRetrievalPrompt([bestHit]) : "";

          log("retrieval", "hits found", {
            query: content,
            hitCount: filtered.length,
            total: results.length,
            threshold,
            prompt,
          });

          if (prompt) {
            session.pendingRetrievalPrompt = prompt;
          }
        } catch (err: any) {
          log("error", "retrieval failed", { error: String(err) });
        }
      })();

      session.pendingRetrievalPromise = retrievalWork;
    });

    // ---- before_prompt_build: 将检索到的事件链注入 agent 上下文 ----
    api.on("before_prompt_build", async (_event: any) => {
      const session = getOrCreateSessionState(_event);
      if (session.pendingRetrievalPromise) {
        await session.pendingRetrievalPromise;
        session.pendingRetrievalPromise = null;
      }
      if (session.pendingRetrievalPrompt) {
        const prompt = session.pendingRetrievalPrompt;
        session.pendingRetrievalPrompt = null;
        log("retrieval", "injecting prompt via before_prompt_build", {
          length: prompt.length,
        });
        return { prependContext: prompt };
      }
      return undefined;
    });


    // ---- reply_dispatch ----
    api.on("reply_dispatch", (event: any) => {
      rememberLatestQuestionForEvent(event);

      let runId: string | undefined;
      try {
        const parsed = JSON.parse(
          typeof event === "string" ? event : event?.content ?? "{}"
        );
        runId = parsed.runId ?? parsed.ctx?.MessageSid;
      } catch { }
      if (runId) {
        const session = getOrCreateSessionState(event);
        session.lastRunId = runId;
      }

      // 将 event 中 BodyForAgent 末尾加上 Prompt 注入的内容，方便后续分析
      /*
        "event": {
            "ctx": {
                "Body": "今天的leetcode每日一题是什么？leetcode官网的",
                "BodyForAgent": "[Wed 2026-05-06 14:27 UTC] 今天的leetcode每日一题是什么？leetcode官网的",
                "BodyForCommands": "今天的leetcode每日一题是什么？leetcode官网的",
                "RawBody": "今天的leetcode每日一题是什么？leetcode官网的",
          }
      */

      log("agent_plan", "reply_dispatch", {
        content: safeStr(event),
        event,
      });

      if (processor) {
        processor.onReplyDispatch(event);
      }
    });

    api.on("gateway_start", (event: any) => {
      log("lifecycle", "gateway_start", {
        content: safeStr(event),
        event,
      });
    });

    // ---- llm_output: 纯日志记录 + 捕获 provider/model ----
    api.on("llm_output", (event: any) => {
      const session = getOrCreateSessionState(event);
      if (session.isEvaluating) return;
      if (event?.provider) lastLlmProvider = event.provider;
      if (event?.model) lastLlmModel = event.model;

      log("llm_output", "llm_output", {
        content: safeStr(
          event?.text ?? event?.content ?? event?.response ?? event
        ),
        model: event?.model,
        provider: event?.provider,
        taskId: event?.taskId,
        event,
      });
    });

    // ---- agent_end: 建图 + 后台导出/评估（不阻塞主流程） ----
    api.on("agent_end", async (event: any, ctx: any) => {
      const agentSession = getOrCreateSessionState(event);
      if (agentSession.isEvaluating) return;
      rememberLatestQuestionForEvent(event);
      const rawMessages = event?.messages ?? event?.event?.messages;
      const { messages: cleanedMessages, questionTimestamp } =
        cleanMessagesSinceQuestion(event);

      log("agent_end", "agent_end", {
        finalMessage: safeStr(
          event?.finalMessage ?? event?.message ?? event?.content
        ),
        success: event?.success,
        duration: event?.duration,
        runId: event?.runId,
        taskId: event?.taskId,
        questionTimestamp,
        messageCount: Array.isArray(rawMessages) ? rawMessages.length : undefined,
        cleanedMessageCount: Array.isArray(cleanedMessages)
          ? cleanedMessages.length
          : undefined,
        messages: cleanedMessages,
      });

      if (!processor || !pluginConfig) return;

      try {
        const resolvedRunId = event?.runId ?? event?.taskId ?? agentSession.lastRunId;

        const agentEndEvent = {
          time: Date.now(),
          data: {
            runId: resolvedRunId,
            taskId: resolvedRunId,
            success: event?.success,
            messages: cleanedMessages,
          },
        };

        await processor.onAgentEnd(agentEndEvent);

        const saved = processor.getLastSavedGraph();
        log("graph_build", "agent_end graph built", {
          taskId: resolvedRunId,
          chainId: saved?.chainId,
        });

        agentSession.lastRunId = null;

        // 后台执行：导出 + LLM 评估，不阻塞 agent_end 返回
        if (saved) {
          const capturedConfig = pluginConfig!;
          const capturedProcessor = processor;
          const capturedSession = agentSession;
          setImmediate(async () => {
            try {
              exportEventChainData(saved.chain, capturedConfig);
              exportGraphData(saved.chainId, saved.nodes, saved.rels, capturedConfig);

              const outcomeNode = saved.nodes.find((n) => n.type === "Outcome");
              const userQuestion = saved.chain.userIntent;
              const finalAnswer = outcomeNode?.properties?.fullText ?? "";

              // 并行运行 LLM 评估、LLM 依赖检测、语义标签拆解
              capturedSession.isEvaluating = true;
              let evalScore: number | null = null;
              let llmDepResult: LlmDependencyResult | null = null;
              let semanticLabels: string[] = [];
              try {
                const evalPromise = evaluateWithLlm(
                  userQuestion,
                  finalAnswer,
                  capturedConfig,
                  api,
                  ctx,
                );
                // LLM 依赖检测（需要 toolNodes，从 cleanedMessages 提取）
                const depPromise = (async () => {
                  try {
                    // 复用 Processor 暴露的工具节点提取（通过 onAgentEnd 的副作用访问）
                    // 直接从 saved 图谱中重建 toolNodes 的简化表示
                    const toolCount = saved.chain.toolSequence.length;
                    if (toolCount >= 2) {
                      const nodesForDep = saved.nodes
                        .filter((n) => n.type === "Action")
                        .map((a) => ({
                          toolName: a.label,
                          arguments: a.properties.arguments ?? {},
                          resultText: "",
                          resultDetails: null,
                          isError: a.properties.isError ?? false,
                        }));
                      return await detectDependenciesWithLlm(
                        nodesForDep,
                        userQuestion,
                        capturedConfig,
                        api,
                        ctx,
                      );
                    }
                    return null;
                  } catch {
                    return null;
                  }
                })();

                // 语义标签拆解（并行，用于增强 embedding）
                const labelPromise = (async () => {
                  try {
                    const labelPrompt = buildLabelDecompositionPrompt(userQuestion);
                    // 复用 evaluateViaFetch / evaluateViaRuntime 的调用模式
                    let labelText: string | null = null;
                    // 尝试 runtime
                    if (typeof api?.runtime?.agent?.runEmbeddedPiAgent === "function") {
                      const rawConfig = api.config ?? {};
                      const agentId = ctx?.agentId ?? "main";
                      const agentsConfig = rawConfig?.agents?.defaults ?? {};
                      const wsDir = ctx?.workspaceDir ?? agentsConfig?.workspace ?? rawConfig?.workspaceDir ?? process.cwd();
                      let aDir: string | undefined;
                      try { aDir = api.runtime.agent.resolveAgentDir?.(rawConfig, agentId); } catch {}
                      if (!aDir) aDir = path.join(path.dirname(wsDir), "agents", agentId, "agent");
                      const sid = `llm-label-${Date.now()}`;
                      try {
                        const res = await api.runtime.agent.runEmbeddedPiAgent({
                          sessionId: sid, sessionKey: ctx?.sessionKey ?? "llm-label", agentId,
                          messageProvider: ctx?.messageProvider, messageChannel: ctx?.channelId,
                          sessionFile: path.join(aDir, `llm-label-${sid}.json`),
                          workspaceDir: wsDir, agentDir: aDir, config: rawConfig,
                          prompt: labelPrompt,
                          provider: ctx?.modelProviderId ?? lastLlmProvider ?? "miaoda",
                          model: ctx?.modelId ?? lastLlmModel ?? "miaoda-model-flash",
                          timeoutMs: 15000, runId: sid, trigger: "manual",
                          toolsAllow: [], disableTools: true, disableMessageTool: true,
                          bootstrapContextMode: "lightweight", verboseLevel: "off",
                          reasoningLevel: "off", silentExpected: true,
                        });
                        labelText = (res?.payloads ?? []).map((p: any) => p?.text?.trim?.() ?? "").filter(Boolean).join("\n").trim();
                      } catch {}
                    }
                    if (!labelText && capturedConfig.llmApiUrl && capturedConfig.llmApiKey) {
                      try {
                        const resp = await fetch(capturedConfig.llmApiUrl, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${capturedConfig.llmApiKey}` },
                          body: JSON.stringify({ model: capturedConfig.llmModel ?? "gpt-4o-mini", messages: [{ role: "user", content: labelPrompt }], max_tokens: 200, temperature: 0.1 }),
                        });
                        const d: any = await resp.json();
                        labelText = d?.choices?.[0]?.message?.content?.trim?.() ?? d?.response?.trim?.() ?? "";
                      } catch {}
                    }
                    if (labelText) {
                      const labels = parseLabelDecompositionResponse(labelText);
                      if (labels.length > 0) {
                        log("llm_label", "semantic labels extracted", { userQuestion: userQuestion.slice(0, 100), labels });
                        return labels;
                      }
                    }
                    return [];
                  } catch { return []; }
                })();

                evalScore = await evalPromise;
                llmDepResult = await depPromise;
                semanticLabels = await labelPromise;
              } finally {
                capturedSession.isEvaluating = false;
              }

              // 应用语义标签增强 chain embedding（提升后续检索质量）
              if (semanticLabels.length > 0) {
                const enhanced = enhanceEmbeddingWithLabels(saved.chain.embedding, semanticLabels);
                saved.chain.embedding = enhanced;
                // 持久化增强后的 chain（提升后续相似检索精度）
                await capturedProcessor.saveChain(saved.chain);
                // 更新 Intent 节点标签属性
                const intentNode = saved.nodes.find((n) => n.type === "Intent");
                if (intentNode) {
                  intentNode.properties.labels = semanticLabels;
                }
              }

              // 应用 LLM 依赖检测结果到图谱
              if (llmDepResult && llmDepResult.dependencies.length > 0) {
                const actionNodes = saved.nodes.filter((n) => n.type === "Action");
                const toolNodesForApply = actionNodes.map((a) => ({
                  toolCallId: a.properties.toolCallId ?? "",
                  toolName: a.label,
                  arguments: a.properties.arguments ?? {},
                  resultText: "",
                  resultDetails: null,
                  isError: a.properties.isError ?? false,
                }));
                const llmRels = capturedProcessor.applyLlmDependencies(
                  llmDepResult,
                  toolNodesForApply as any,
                  actionNodes,
                );
                // 合并 DEPENDS_ON：用 LLM 结果替换/补充 LCS 检测（去重）
                const existingDepKeys = new Set(
                  saved.rels
                    .filter((r) => r.type === "DEPENDS_ON")
                    .map((r) => `${r.from[0]}->${r.to[0]}`),
                );
                for (const rel of llmRels) {
                  const key = `${rel.from[0]}->${rel.to[0]}`;
                  if (!existingDepKeys.has(key)) {
                    saved.rels.push(rel);
                  }
                }
                log("llm_dep", "LLM dependencies applied to graph", {
                  chainId: saved.chainId,
                  lcsDepCount: saved.rels.filter((r) => r.type === "DEPENDS_ON").length - llmRels.length,
                  llmDepCount: llmRels.length,
                  totalDepCount: saved.rels.filter((r) => r.type === "DEPENDS_ON").length,
                });
              }

              if (evalScore !== null && outcomeNode) {
                outcomeNode.properties.evalScore = evalScore;
                if (evalScore < capturedConfig.evalScoreThreshold) {
                  await capturedProcessor.removeGraph(saved.chainId);
                } else {
                  await capturedProcessor.saveGraph(saved.chainId, saved.nodes, saved.rels);
                }
              }

              log("llm_eval_result", "LLM evaluation score", {
                chainId: saved.chainId,
                score: evalScore,
                userQuestion: userQuestion.slice(0, 200),
                finalAnswer: String(finalAnswer).slice(0, 200),
              });
            } catch (err: any) {
              log("error", "background eval/export failed", { error: String(err) });
            }
          });
        }
      } catch (err: any) {
        log("error", "agent_end graph build failed", { error: String(err) });
      }
    });

    api.on("llm_input", (event: any) => {
      log("llm_input", "llm_input", { event });
    });
  },
});
