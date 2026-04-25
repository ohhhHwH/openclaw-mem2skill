import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: any) => entry,
}));

vi.mock("../src/logger", () => ({
  log: vi.fn(),
}));

import pluginEntry from "../index";
import { log } from "../src/logger";

interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
  execute(id: string, params: any): Promise<{ content: { type: string; text: string }[] }>;
}

describe("memory2skill plugin", () => {
  const tools: ToolDefinition[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tools.length = 0;

    const fakeApi = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
    };
    pluginEntry.register(fakeApi as any);
  });

  it("should have correct plugin metadata", () => {
    expect(pluginEntry.id).toBe("memory2skill");
    expect(pluginEntry.name).toBe("Memory to Skill");
  });

  it("should register 5 tools", () => {
    expect(tools).toHaveLength(5);
  });

  it("should register tools with expected names", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "mem2skill_transform_input",
      "mem2skill_log_input",
      "mem2skill_log_plan",
      "mem2skill_log_skill",
      "mem2skill_log_tool",
    ]);
  });

  describe("mem2skill_transform_input", () => {
    it("should prepend default prefix", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_transform_input")!;
      const result = await tool.execute("test-id", { input: "world" });
      expect(result.content[0].text).toBe("hello openclaw, world");
    });

    it("should use custom prefix when provided", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_transform_input")!;
      const result = await tool.execute("test-id", { input: "world", prefix: "hi," });
      expect(result.content[0].text).toBe("hi, world");
    });

    it("should call log", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_transform_input")!;
      await tool.execute("test-id", { input: "world" });
      expect(log).toHaveBeenCalledWith("user_input", "Input transformed", {
        original: "world",
        transformed: "hello openclaw, world",
      });
    });
  });

  describe("mem2skill_log_input", () => {
    it("should return 'logged'", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_log_input")!;
      const result = await tool.execute("id", { content: "test msg" });
      expect(result.content[0].text).toBe("logged");
      expect(log).toHaveBeenCalledWith("user_input", "test msg", { taskId: undefined });
    });
  });

  describe("mem2skill_log_plan", () => {
    it("should log plan with steps", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_log_plan")!;
      const result = await tool.execute("id", {
        planId: "p1",
        steps: ["step1", "step2"],
        reasoning: "because",
      });
      expect(result.content[0].text).toBe("plan logged");
      expect(log).toHaveBeenCalledWith("agent_plan", "Plan p1", {
        steps: ["step1", "step2"],
        reasoning: "because",
      });
    });
  });

  describe("mem2skill_log_skill", () => {
    it("should log skill invocation", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_log_skill")!;
      const result = await tool.execute("id", { skillName: "mySkill", args: "a=1" });
      expect(result.content[0].text).toBe("skill logged");
      expect(log).toHaveBeenCalledWith("skill_invoke", "Skill: mySkill", { args: "a=1" });
    });
  });

  describe("mem2skill_log_tool", () => {
    it("should log tool call", async () => {
      const tool = tools.find((t) => t.name === "mem2skill_log_tool")!;
      const result = await tool.execute("id", {
        toolName: "grep",
        parameters: "pattern",
        result: "found",
        success: true,
      });
      expect(result.content[0].text).toBe("tool call logged");
      expect(log).toHaveBeenCalledWith("tool_call", "Tool: grep", {
        parameters: "pattern",
        result: "found",
        success: true,
      });
    });
  });
});
