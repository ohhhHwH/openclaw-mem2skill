import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock openclaw plugin entry - just passes through
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: any) => entry,
}));

// Mock logger
vi.mock("../src/logger", () => ({
  log: vi.fn(),
  setLogPath: vi.fn(),
}));

// Mock processor to avoid filesystem side effects
vi.mock("../src/processor", () => {
  return {
    simpleEmbedding: (text: string, dim?: number) => {
      const d = dim ?? 64;
      const vec = new Array(d).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % d] += text.charCodeAt(i);
      const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
      return vec.map((v: number) => v / norm);
    },
    enhanceEmbeddingWithLabels: (embedding: number[], _labels: string[]) => embedding,
    buildLlmDependencyPrompt: () => "",
    parseLlmDependencyResponse: () => null,
    buildLabelDecompositionPrompt: () => "",
    parseLabelDecompositionResponse: () => [],
    scoreToolCallQuality: () => 0.5,
    detectUserFeedback: () => null,
    applyFeedbackToScores: (scores: any) => scores,
    Processor: vi.fn().mockImplementation(function (this: any) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.close = vi.fn().mockResolvedValue(undefined);
      this.onMessageReceived = vi.fn().mockResolvedValue([]);
      this.onReplyDispatch = vi.fn();
      this.onBeforeToolCall = vi.fn();
      this.onAfterToolCall = vi.fn();
      this.onAgentEnd = vi.fn().mockResolvedValue(undefined);
      this.onLlmOutput = vi.fn().mockResolvedValue(undefined);
      this.searchSimilar = vi.fn().mockResolvedValue([]);
      this.getGraphs = vi.fn().mockReturnValue(new Map());
      this.getLastSavedGraph = vi.fn().mockReturnValue(null);
      this.removeGraph = vi.fn().mockResolvedValue(undefined);
      this.saveGraph = vi.fn().mockResolvedValue(undefined);
      this.saveChain = vi.fn().mockResolvedValue(undefined);
      this.applyLlmDependencies = vi.fn().mockReturnValue([]);
      this.queryByIntent = vi.fn().mockResolvedValue([]);
      this.processQuery = vi.fn().mockResolvedValue({ chain: {}, similar: [] });
      this.buildKnowledgeGraph = vi.fn().mockResolvedValue({ chain: {}, nodes: [], rels: [] });
    }),
  };
});

import pluginEntry from "../index";
import { log, setLogPath } from "../src/logger";

describe("memory2skill plugin", () => {
  // Collect registered hooks
  let hooks: Map<string, Function[]>;

  function createMockApi() {
    hooks = new Map();
    return {
      registrationMode: "full",
      config: {},
      on: vi.fn((event: string, handler: Function) => {
        if (!hooks.has(event)) hooks.set(event, []);
        hooks.get(event)!.push(handler);
      }),
      registerTool: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("plugin metadata", () => {
    it("should have correct plugin metadata", () => {
      expect(pluginEntry.id).toBe("memory2skill");
      expect(pluginEntry.name).toBe("Memory to Skill");
      expect(pluginEntry.description).toContain("Captures");
    });

    it("should export a register function", () => {
      expect(typeof pluginEntry.register).toBe("function");
    });
  });

  describe("plugin registration (full mode)", () => {
    let api: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      api = createMockApi();
      pluginEntry.register(api as any);
    });

    it("should set up message_received hook", () => {
      expect(api.on).toHaveBeenCalledWith("message_received", expect.any(Function));
    });

    it("should set up before_prompt_build hook", () => {
      expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    });

    it("should set up reply_dispatch hook", () => {
      expect(api.on).toHaveBeenCalledWith("reply_dispatch", expect.any(Function));
    });

    it("should set up agent_end hook", () => {
      expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    });

    it("should set up llm_output hook", () => {
      expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
    });

    it("should set up gateway_start hook", () => {
      expect(api.on).toHaveBeenCalledWith("gateway_start", expect.any(Function));
    });

    it("should set up llm_input hook", () => {
      expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    });

    it("should set log path from config", () => {
      expect(setLogPath).toHaveBeenCalled();
    });

    it("should log registration lifecycle", () => {
      expect(log).toHaveBeenCalledWith(
        "lifecycle",
        expect.stringContaining("registered"),
        expect.any(Object),
      );
    });
  });

  describe("plugin registration (non-full mode)", () => {
    it("should not set up hooks in non-full registration mode", () => {
      const api = createMockApi();
      api.registrationMode = "partial";
      pluginEntry.register(api as any);
      // Only lifecycle log should be called, not hooks
      expect(api.on).not.toHaveBeenCalled();
    });
  });

  describe("message_received handler", () => {
    it("should skip commands starting with /", async () => {
      const api = createMockApi();
      pluginEntry.register(api as any);

      const handler = hooks.get("message_received")?.[0];
      expect(handler).toBeDefined();

      await handler!("/new");
      // Should return early without processing
      expect(log).toHaveBeenCalledWith(
        "user_input",
        "message_received",
        expect.objectContaining({ original: "/new" }),
      );
    });

    it("should prepend default prefix and log", async () => {
      const api = createMockApi();
      pluginEntry.register(api as any);

      const handler = hooks.get("message_received")?.[0];
      expect(handler).toBeDefined();

      await handler!("hello world");
      expect(log).toHaveBeenCalledWith(
        "user_input",
        "message_received",
        expect.objectContaining({
          original: "hello world",
          transformed: "hello openclaw, hello world",
        }),
      );
    });
  });

  describe("before_prompt_build handler", () => {
    it("should return undefined when no pending prompt", async () => {
      const api = createMockApi();
      pluginEntry.register(api as any);

      const handler = hooks.get("before_prompt_build")?.[0];
      expect(handler).toBeDefined();

      const result = await handler!({});
      expect(result).toBeUndefined();
    });
  });
});
