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

  interface TextTransformDefinition {
    name: string;
    description: string;
    transformUserMessage?(text: string): string;
    transformAssistantMessage?(text: string): string;
  }

  interface OpenClawPluginApi {
    id: string;
    name: string;
    version: string;
    description: string;
    source: string;
    rootDir: string;
    registrationMode: RegistrationMode;
    config: Record<string, any>;
    pluginConfig: Record<string, any>;
    runtime: any;
    logger: any;
    registerTool(tool: ToolDefinition): void;
    registerHook(hook: any): void;
    registerHttpRoute(route: any): void;
    registerChannel(channel: any): void;
    registerGatewayMethod(method: any): void;
    registerCli(...args: any[]): void;
    registerReload(handler: any): void;
    registerNodeHostCommand(cmd: any): void;
    registerSecurityAuditCollector(collector: any): void;
    registerService(service: any): void;
    registerCliBackend(backend: any): void;
    registerTextTransforms(transforms: TextTransformDefinition): void;
    registerConfigMigration(migration: any): void;
    registerAutoEnableProbe(probe: any): void;
    registerProvider(provider: any): void;
    registerSpeechProvider(provider: any): void;
    registerRealtimeTranscriptionProvider(provider: any): void;
    registerRealtimeVoiceProvider(provider: any): void;
    registerMediaUnderstandingProvider(provider: any): void;
    registerImageGenerationProvider(provider: any): void;
    registerVideoGenerationProvider(provider: any): void;
    registerMusicGenerationProvider(provider: any): void;
    registerWebFetchProvider(provider: any): void;
    registerWebSearchProvider(provider: any): void;
    registerInteractiveHandler(handler: any): void;
    onConversationBindingResolved(handler: any): void;
    registerCommand(cmd: any): void;
    registerContextEngine(engine: any): void;
    registerCompactionProvider(provider: any): void;
    registerAgentHarness(harness: any): void;
    registerMemoryCapability(cap: any): void;
    registerMemoryPromptSection(section: any): void;
    registerMemoryPromptSupplement(supplement: any): void;
    registerMemoryCorpusSupplement(supplement: any): void;
    registerMemoryFlushPlan(plan: any): void;
    registerMemoryRuntime(runtime: any): void;
    registerMemoryEmbeddingProvider(provider: any): void;
    resolvePath(path: string): string;
    on(event: string, handler: (...args: any[]) => void): void;
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
