import fs from 'fs';
import path from 'path';
import {
  PluginLogEntry,
  PluginLogCategory,
  MessageEvent,
  AgentPlanEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './types';

const DEFAULT_LOG_DIR = path.join(process.cwd(), '.openclaw', 'memory', 'plugin-logs');

let logDir = DEFAULT_LOG_DIR;

function ensureLogDir() {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function getLogFilePath(): string {
  const d = new Date();
  const name = `plugin-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  return path.join(logDir, name);
}

function writeEntry(category: PluginLogCategory, taskId: string, payload: any) {
  ensureLogDir();
  const entry: PluginLogEntry = {
    timestamp: Date.now(),
    category,
    taskId,
    payload,
  };
  fs.appendFileSync(getLogFilePath(), JSON.stringify(entry) + '\n');
}

export const pluginLog = {
  setLogDir(dir: string) {
    logDir = dir;
  },

  async logUserInput(event: MessageEvent): Promise<void> {
    writeEntry('user_input', event.taskId, {
      role: event.role,
      content: event.content,
      timestamp: event.timestamp,
    });
  },

  async logAgentPlan(event: AgentPlanEvent): Promise<void> {
    writeEntry('agent_plan', event.taskId, {
      planId: event.planId,
      steps: event.steps,
      reasoning: event.reasoning,
      timestamp: event.timestamp,
    });
  },

  async logToolCall(event: ToolCallEvent): Promise<void> {
    writeEntry('tool_call', event.taskId, {
      callId: event.callId,
      toolName: event.toolName,
      parameters: event.parameters,
      timestamp: event.timestamp,
    });
  },

  async logToolResult(event: ToolResultEvent): Promise<void> {
    writeEntry('tool_result', event.taskId, {
      callId: event.callId,
      toolName: event.toolName,
      result: event.result,
      success: event.success,
      duration: event.duration,
      timestamp: event.timestamp,
    });
  },
};
