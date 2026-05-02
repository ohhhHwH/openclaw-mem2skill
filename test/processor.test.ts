import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { Processor } from "../src/processor";
import type { StorageConfig } from "../src/types";

const LOG_PATH = path.join(__dirname, "v1.7.log");
const OUTPUT_DIR = path.join(__dirname, "output");
const GRAPH_LOG_PATH = path.join(OUTPUT_DIR, "graph.jsonl");

interface LogEntry {
  time: string;
  category: string;
  message: string;
  data?: any;
}

function loadLog(): LogEntry[] {
  const raw = fs.readFileSync(LOG_PATH, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function cleanOutputDir() {
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
}

const TEST_CONFIG: StorageConfig = {
  lanceDbPath: "/tmp/test-vectors",
  graphLogPath: GRAPH_LOG_PATH,
};

afterAll(() => {
  cleanOutputDir();
});

describe("v1.7 log parsing", () => {
  const entries = loadLog();

  it("should parse all log entries", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBe(25);
  });

  it("should contain expected categories", () => {
    const categories = [...new Set(entries.map((e) => e.category))];
    expect(categories).toContain("lifecycle");
    expect(categories).toContain("plugin");
    expect(categories).toContain("user_input");
    expect(categories).toContain("agent_plan");
    expect(categories).toContain("tool_call");
    expect(categories).toContain("tool_result");
    expect(categories).toContain("agent_end");
    expect(categories).toContain("llm_output");
  });

  it("should contain two user sessions", () => {
    const userInputs = entries.filter(
      (e) => e.category === "user_input"
    );
    expect(userInputs).toHaveLength(2);
    expect(userInputs[0].data.original).toContain("美股");
    expect(userInputs[1].data.original).toContain("leetcode");
  });
});

describe("Processor — session 1 (stock query)", () => {
  let processor: Processor;
  const entries = loadLog();

  const session1 = {
    messageReceived: entries.find(
      (e) =>
        e.category === "user_input" && e.data.original.includes("美股")
    )!,
    replyDispatch: entries.find(
      (e) =>
        e.category === "agent_plan" &&
        e.data.content?.includes("美股")
    )!,
    toolCalls: entries.filter(
      (e) =>
        e.category === "tool_call" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:25:00Z").getTime()
    ),
    toolResults: entries.filter(
      (e) =>
        e.category === "tool_result" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:25:00Z").getTime()
    ),
    agentEnd: entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:30:00Z").getTime()
    )!,
  };

  beforeEach(async () => {
    cleanOutputDir();
    processor = new Processor(TEST_CONFIG);
    await processor.init();
  });

  it("onMessageReceived creates an active chain", async () => {
    await processor.onMessageReceived(session1.messageReceived);
    expect(processor.getActiveChainCount()).toBe(1);
  });

  it("onReplyDispatch creates chain with correct userIntent", () => {
    processor.onReplyDispatch(session1.replyDispatch);
    const parsed = JSON.parse(session1.replyDispatch.data.content);
    const taskId = parsed.runId;
    const chain = processor.getActiveChain(taskId);
    expect(chain).toBeDefined();
    expect(chain!.userIntent).toContain("美股");
  });

  it("onBeforeToolCall appends tool events and updates toolSequence", () => {
    processor.onReplyDispatch(session1.replyDispatch);

    for (const tc of session1.toolCalls) {
      processor.onBeforeToolCall(tc);
    }

    const parsed = JSON.parse(session1.replyDispatch.data.content);
    const chain = processor.getActiveChain(parsed.runId)!;

    expect(chain.toolSequence).toEqual(["exec", "exec", "web_crawl"]);
    const toolEvents = chain.events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(3);
  });

  it("onAfterToolCall backfills result on matching before event", () => {
    processor.onReplyDispatch(session1.replyDispatch);

    for (const tc of session1.toolCalls) {
      processor.onBeforeToolCall(tc);
    }
    for (const tr of session1.toolResults) {
      processor.onAfterToolCall(tr);
    }

    const parsed = JSON.parse(session1.replyDispatch.data.content);
    const chain = processor.getActiveChain(parsed.runId)!;
    const firstTool = chain.events.find(
      (e) => e.type === "tool_call" && e.metadata.toolName === "exec"
    )!;
    expect(firstTool.metadata.result).toBeDefined();
    expect(firstTool.metadata.success).toBe(true);
  });

  it("onAgentEnd saves chain and clears activeChains", async () => {
    processor.onReplyDispatch(session1.replyDispatch);
    for (const tc of session1.toolCalls) {
      processor.onBeforeToolCall(tc);
    }
    for (const tr of session1.toolResults) {
      processor.onAfterToolCall(tr);
    }

    await processor.onAgentEnd(session1.agentEnd);
    expect(processor.getActiveChainCount()).toBe(0);
  });
});

describe("Processor — session 2 (LeetCode query)", () => {
  let processor: Processor;
  const entries = loadLog();

  const session2 = {
    messageReceived: entries.find(
      (e) =>
        e.category === "user_input" && e.data.original.includes("leetcode")
    )!,
    replyDispatch: entries.find(
      (e) =>
        e.category === "agent_plan" &&
        e.data.content?.includes("leetcode")
    )!,
    toolCalls: entries.filter(
      (e) =>
        e.category === "tool_call" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    ),
    toolResults: entries.filter(
      (e) =>
        e.category === "tool_result" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    ),
    agentEnd: entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    )!,
  };

  beforeEach(async () => {
    cleanOutputDir();
    processor = new Processor(TEST_CONFIG);
    await processor.init();
  });

  it("onReplyDispatch creates chain with LeetCode intent", () => {
    processor.onReplyDispatch(session2.replyDispatch);
    const parsed = JSON.parse(session2.replyDispatch.data.content);
    const chain = processor.getActiveChain(parsed.runId);
    expect(chain).toBeDefined();
    expect(chain!.userIntent).toContain("leetcode");
  });

  it("tool sequence matches expected tools", () => {
    processor.onReplyDispatch(session2.replyDispatch);
    for (const tc of session2.toolCalls) {
      processor.onBeforeToolCall(tc);
    }

    const parsed = JSON.parse(session2.replyDispatch.data.content);
    const chain = processor.getActiveChain(parsed.runId)!;
    expect(chain.toolSequence).toEqual(["exec", "web_crawl", "exec", "web_crawl"]);
  });

  it("full lifecycle saves and clears chain", async () => {
    processor.onReplyDispatch(session2.replyDispatch);
    for (const tc of session2.toolCalls) {
      processor.onBeforeToolCall(tc);
    }
    for (const tr of session2.toolResults) {
      processor.onAfterToolCall(tr);
    }
    await processor.onAgentEnd(session2.agentEnd);
    expect(processor.getActiveChainCount()).toBe(0);
  });
});

describe("Processor — searchSimilar after saving chains", () => {
  it("returns results with scores after saving two sessions", async () => {
    cleanOutputDir();
    const entries = loadLog();
    const processor = new Processor(TEST_CONFIG);
    await processor.init();

    const session1Dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("美股")
    )!;
    const session1End = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:30:00Z").getTime()
    )!;
    processor.onReplyDispatch(session1Dispatch);
    await processor.onAgentEnd(session1End);

    const session2Dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("leetcode")
    )!;
    const session2End = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    )!;
    processor.onReplyDispatch(session2Dispatch);
    await processor.onAgentEnd(session2End);

    const msgEvent = entries.find(
      (e) => e.category === "user_input" && e.data.original.includes("美股")
    )!;
    const results = await processor.onMessageReceived(msgEvent);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].chain).toBeDefined();
  });
});

describe("Processor — graph log file output", () => {
  const entries = loadLog();

  it("onAgentEnd appends graph entry to graphLogPath", async () => {
    cleanOutputDir();
    const processor = new Processor(TEST_CONFIG);
    await processor.init();

    const dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("美股")
    )!;
    const toolCalls = entries.filter(
      (e) =>
        e.category === "tool_call" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:25:00Z").getTime()
    );
    const toolResults = entries.filter(
      (e) =>
        e.category === "tool_result" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:25:00Z").getTime()
    );
    const agentEnd = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:30:00Z").getTime()
    )!;

    processor.onReplyDispatch(dispatch);
    for (const tc of toolCalls) processor.onBeforeToolCall(tc);
    for (const tr of toolResults) processor.onAfterToolCall(tr);
    await processor.onAgentEnd(agentEnd);

    expect(fs.existsSync(GRAPH_LOG_PATH)).toBe(true);
    const raw = fs.readFileSync(GRAPH_LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.chainId).toBeDefined();
    expect(entry.nodes.length).toBeGreaterThan(0);
    expect(entry.rels.length).toBeGreaterThan(0);

    const intentNode = entry.nodes.find((n: any) => n.type === "Intent");
    expect(intentNode.label).toContain("美股");

    const relTypes = entry.rels.map((r: any) => r.type);
    expect(relTypes).toContain("TRIGGERS");
    expect(relTypes).toContain("RESULTS_IN");
  });

  it("two sessions produce two lines in graph log", async () => {
    cleanOutputDir();
    const processor = new Processor(TEST_CONFIG);
    await processor.init();

    const s1Dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("美股")
    )!;
    const s1End = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() < new Date("2026-04-27T14:30:00Z").getTime()
    )!;
    processor.onReplyDispatch(s1Dispatch);
    await processor.onAgentEnd(s1End);

    const s2Dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("leetcode")
    )!;
    const s2End = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    )!;
    processor.onReplyDispatch(s2Dispatch);
    await processor.onAgentEnd(s2End);

    const raw = fs.readFileSync(GRAPH_LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);
    const intent1 = entry1.nodes.find((n: any) => n.type === "Intent");
    const intent2 = entry2.nodes.find((n: any) => n.type === "Intent");
    expect(intent1.label).toContain("美股");
    expect(intent2.label).toContain("leetcode");
  });

  it("graph log is loaded on init and queryByIntent works", async () => {
    cleanOutputDir();
    const processor1 = new Processor(TEST_CONFIG);
    await processor1.init();

    const dispatch = entries.find(
      (e) => e.category === "agent_plan" && e.data.content?.includes("leetcode")
    )!;
    const agentEnd = entries.find(
      (e) =>
        e.category === "agent_end" &&
        new Date(e.time).getTime() > new Date("2026-04-27T14:40:00Z").getTime()
    )!;
    processor1.onReplyDispatch(dispatch);
    await processor1.onAgentEnd(agentEnd);
    await processor1.close();

    const processor2 = new Processor(TEST_CONFIG);
    await processor2.init();
    const results = await processor2.queryByIntent("leetcode");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("Intent");
    expect(results[0].label).toContain("leetcode");
  });
});

describe("Processor — edge cases", () => {
  let processor: Processor;

  beforeEach(async () => {
    cleanOutputDir();
    processor = new Processor(TEST_CONFIG);
    await processor.init();
  });

  it("onBeforeToolCall with no active chain does not throw", () => {
    expect(() =>
      processor.onBeforeToolCall({
        time: "2026-04-27T14:00:00Z",
        data: { toolName: "exec", parameters: "{}" },
      })
    ).not.toThrow();
  });

  it("onAfterToolCall with no matching before event does not throw", () => {
    processor.onReplyDispatch({
      time: "2026-04-27T14:00:00Z",
      category: "agent_plan",
      message: "reply_dispatch",
      data: {
        content: JSON.stringify({
          runId: "test-run-id",
          ctx: { Body: "test query" },
        }),
      },
    });

    expect(() =>
      processor.onAfterToolCall({
        time: "2026-04-27T14:00:01Z",
        data: { toolName: "nonexistent", result: "{}" },
      })
    ).not.toThrow();
  });

  it("onAgentEnd with no active chain does not throw", async () => {
    await expect(
      processor.onAgentEnd({ data: { success: true } })
    ).resolves.not.toThrow();
  });
});
