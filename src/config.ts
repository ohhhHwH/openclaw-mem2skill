import path from "path";
import os from "os";

export interface PluginConfig {
  graphLogPath: string;
  graphDataDir: string;
  lanceDbPath: string;
  scoreThreshold: number;
  embeddingDim: number;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  evalScoreThreshold: number;
  logPath: string;
}

const DEFAULT_BASE_DIR = path.join(os.homedir(), "workspace", "agent", "logs", "mem2skill");

const defaults: PluginConfig = {
  graphLogPath: path.join(DEFAULT_BASE_DIR, "graph.jsonl"),
  graphDataDir: path.join(DEFAULT_BASE_DIR, "graph_data"),
  lanceDbPath: path.join(DEFAULT_BASE_DIR, "lance.db"),
  scoreThreshold: 0.8,
  embeddingDim: 64,
  llmApiUrl: "",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  evalScoreThreshold: 0.5,
  logPath: path.join(os.homedir(), "workspace", "agent", "logs", "myplugins.log"),
};

export function resolveConfig(userConfig?: Record<string, any>): PluginConfig {
  return {
    graphLogPath: userConfig?.graphLogPath ?? defaults.graphLogPath,
    graphDataDir: userConfig?.graphDataDir ?? defaults.graphDataDir,
    lanceDbPath: userConfig?.lanceDbPath ?? defaults.lanceDbPath,
    scoreThreshold: userConfig?.scoreThreshold ?? defaults.scoreThreshold,
    embeddingDim: userConfig?.embeddingDim ?? defaults.embeddingDim,
    llmApiUrl: userConfig?.llmApiUrl ?? defaults.llmApiUrl,
    llmApiKey: userConfig?.llmApiKey ?? defaults.llmApiKey,
    llmModel: userConfig?.llmModel ?? defaults.llmModel,
    evalScoreThreshold: userConfig?.evalScoreThreshold ?? defaults.evalScoreThreshold,
    logPath: userConfig?.logPath ?? defaults.logPath,
  };
}
