import path from "path";
import os from "os";

export interface PluginConfig {
  graphLogPath: string;
  graphDataDir: string;
  lanceDbPath: string;
  scoreThreshold: number;
  embeddingDim: number;
  llmTaskProvider: string;
  llmTaskModel: string;
}

const DEFAULT_BASE_DIR = path.join(os.homedir(), "workspace", "agent", "logs", "mem2skill");

const defaults: PluginConfig = {
  graphLogPath: path.join(DEFAULT_BASE_DIR, "graph.jsonl"),
  graphDataDir: path.join(DEFAULT_BASE_DIR, "graph_data"),
  lanceDbPath: path.join(DEFAULT_BASE_DIR, "lance.db"),
  scoreThreshold: 0.8,
  embeddingDim: 64,
  llmTaskProvider: "",
  llmTaskModel: "",
};

export function resolveConfig(userConfig?: Record<string, any>): PluginConfig {
  return {
    graphLogPath: userConfig?.graphLogPath ?? defaults.graphLogPath,
    graphDataDir: userConfig?.graphDataDir ?? defaults.graphDataDir,
    lanceDbPath: userConfig?.lanceDbPath ?? defaults.lanceDbPath,
    scoreThreshold: userConfig?.scoreThreshold ?? defaults.scoreThreshold,
    embeddingDim: userConfig?.embeddingDim ?? defaults.embeddingDim,
    llmTaskProvider: userConfig?.llmTaskProvider ?? defaults.llmTaskProvider,
    llmTaskModel: userConfig?.llmTaskModel ?? defaults.llmTaskModel,
  };
}
