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

  type RegistrationMode =
    | "full"
    | "discovery"
    | "setup-only"
    | "setup-runtime"
    | "cli-metadata";

  interface OpenClawPluginApi {
    registrationMode: RegistrationMode;
    registerTool(tool: ToolDefinition): void;
    registerProvider(provider: any): void;
    registerChannel(channel: any): void;
    registerCli(...args: any[]): void;
    registerService(service: any): void;
    registerGatewayMethod(method: any): void;
  }

  interface PluginEntry {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: any;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
