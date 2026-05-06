import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "fs";
import path from "path";
import { log } from "./src/logger";
import { Processor, simpleEmbedding } from "./src/processor";
import { resolveConfig } from "./src/config";
import type { PluginConfig } from "./src/config";
import type {
  EventChain,
  GraphNode,
  GraphRelationship,
  RetrievalResult,
} from "./src/types";

const PLUGIN_VERSION = "1.18.4";
const DEBUG = true;
const DEFAULT_PREFIX = "hello openclaw,";
const questionTimestampByKey = new Map<string, number>();
let latestQuestionTimestamp: number | null = null;

let processor: Processor | null = null;
let pluginConfig: PluginConfig | null = null;
let lastRunId: string | null = null;
let pendingRetrievalPrompt: string | null = null;
let pendingOriginalText: string | null = null;
let lastLlmProvider: string | null = null;
let lastLlmModel: string | null = null;
let isEvaluating = false;

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

  const parts: string[] = [];

  for (const { result, graphEntry } of hits) {
    const similarity = result.score.toFixed(4);
    const confidence = graphEntry ? getEvalScoreFromGraph(graphEntry) : 1;
    const historyQuestion = result.chain.userIntent;

    let toolPath: string;
    if (graphEntry) {
      toolPath = buildToolPathFromGraph(graphEntry);
    } else {
      toolPath = result.chain.toolSequence.join(" → ");
    }

    parts.push(
      `以下是与当前问题相关的历史执行记录，${historyQuestion}(问题相似性: ${similarity}, 结果置信度: ${confidence})`,
    );
    parts.push(`可参考其中的工具调用路径：${toolPath}`);
  }

  return parts.join("\n");
}

// ---- LLM 评估：对用户问题和最终回答进行评分 ----

function buildEvalPrompt(userQuestion: string, finalAnswer: string): string {
  return (
    `请根据以下用户输入的问题和最终回答，判断回答的准确性和相关性，并给出一个0-1之间的评分，` +
    `0表示完全不相关或错误，1表示完全相关且正确。` +
    `用户输入的问题是：${userQuestion}，最终回答是：${finalAnswer}。` +
    `最终回答只给出一个评分，不需要其他解释或信息。`
  );
}

function parseEvalScore(text: string): number | null {
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
    } catch {}
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
    log("plugin", `memory2skill v${PLUGIN_VERSION} registered`, {
      mode: api.registrationMode,
    });

    if (api.registrationMode !== "full") return;

    const userConfig = (api as any).config ?? {};
    pluginConfig = resolveConfig(userConfig);

    if (!processor) {
      processor = new Processor({
        lanceDbPath: pluginConfig.lanceDbPath,
        graphLogPath: pluginConfig.graphLogPath,
        debug: DEBUG,
      });

      processor.init().catch((err: any) => {
        log("error", "processor init failed", { error: String(err) });
      });
    }

    // ---- message_received: 检索历史事件链，构建 prompt 注入 ----
    api.on("message_received", async (event: any) => {
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

      if (!processor || !pluginConfig) return;

      try {
        const results = await processor.onMessageReceived({
          time: Date.now(),
          data: {
            original: content,
            taskId: event?.taskId ?? `task-${Date.now()}`,
          },
        });

        const threshold = pluginConfig.scoreThreshold;
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

        const storage: any = (processor as any).storage;
        const graphsMap: Map<string, { nodes: GraphNode[]; rels: GraphRelationship[] }> =
          (storage as any).graphs;

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
          pendingRetrievalPrompt = prompt;
          pendingOriginalText = content;
        }
      } catch (err: any) {
        log("error", "retrieval failed", { error: String(err) });
      }
    });

    // ---- before_prompt_build: 将检索到的事件链注入原始消息之后 ----
    api.on("before_prompt_build", (_event: any) => {
      
      // return undefined;
      if (pendingRetrievalPrompt && pendingOriginalText) {
        const combined = `${pendingOriginalText}\n${pendingRetrievalPrompt}`;
        pendingRetrievalPrompt = null;
        pendingOriginalText = null;
        log("retrieval", "injecting prompt via before_prompt_build", {
          length: combined.length,
        });
        return { replaceMessage: combined };
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
      } catch {}
      if (runId) lastRunId = runId;

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
      if (isEvaluating) return;
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

    // ---- agent_end: 建图 + 导出事件链和图谱 ----
    api.on("agent_end", async (event: any, ctx: any) => {
      if (isEvaluating) return;
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
        const resolvedRunId = event?.runId ?? event?.taskId ?? lastRunId;

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
        if (saved && !DEBUG) {
          exportEventChainData(saved.chain, pluginConfig!);
          exportGraphData(saved.chainId, saved.nodes, saved.rels, pluginConfig!);

          const outcomeNode = saved.nodes.find((n) => n.type === "Outcome");
          const userQuestion = saved.chain.userIntent;
          const finalAnswer = outcomeNode?.properties?.fullText ?? "";
          isEvaluating = true;
          let evalScore: number | null = null;
          try {
            evalScore = await evaluateWithLlm(
              userQuestion,
              finalAnswer,
              pluginConfig!,
              api,
              ctx,
            );
          } finally {
            isEvaluating = false;
          }

          if (evalScore !== null && outcomeNode) {
            outcomeNode.properties.evalScore = evalScore;
            const storage: any = (processor as any).storage;
            await storage.saveGraph(saved.chainId, saved.nodes, saved.rels);
          }

          log("llm_eval_result", "LLM evaluation score", {
            chainId: saved.chainId,
            score: evalScore,
            userQuestion: userQuestion.slice(0, 200),
            finalAnswer: String(finalAnswer).slice(0, 200),
          });
        }

        log("graph_build", "agent_end graph built and exported", {
          taskId: resolvedRunId,
          chainId: saved?.chainId,
        });

        lastRunId = null;
      } catch (err: any) {
        log("error", "agent_end graph build failed", { error: String(err) });
      }
    });

    api.on("llm_input", (event: any) => {
      log("llm_input", "llm_input", { event });
    });
  },
});
