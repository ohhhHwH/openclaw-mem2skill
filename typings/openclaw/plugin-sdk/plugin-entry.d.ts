declare module "openclaw/plugin-sdk/plugin-entry" {
  import { TSchema } from "@sinclair/typebox";

  interface ToolDefinition {
    name: string;
    description: string;
    parameters: TSchema;
    execute(id: string, params: any): Promise<{
      content: { type: string; text: string }[];
    }>;
  }

  interface PluginApi {
    onTaskStart(handler: (task: any) => Promise<void>): void;
    onTaskEnd(handler: (task: any) => Promise<void>): void;
    onFeedback(handler: (feedback: { taskId: string; score: number; comment?: string }) => Promise<void>): void;
    registerTool(tool: ToolDefinition): void;
  }

  interface PluginEntry {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
