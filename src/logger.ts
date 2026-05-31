import fs from "fs";
import path from "path";
import os from "os";

let LOG_FILE = path.join(
  os.homedir(),
  "workspace",
  "agent",
  "logs",
  "myplugins.log"
);

export function setLogPath(logPath: string): void {
  LOG_FILE = logPath;
}

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ts(): string {
  return new Date().toISOString();
}

const ALLOWED_CATEGORIES = new Set([
  "lifecycle",
  "user_input",
  "agent_plan",
  "tool_call",
  "tool_result",
  "agent_end",
  "llm_output",
]);

export function log(category: string, message: string, data?: any) {
  if (!ALLOWED_CATEGORIES.has(category)) return;
  ensureDir();
  const line = JSON.stringify({
    time: ts(),
    category,
    message,
    ...(data !== undefined ? { data } : {}),
  });
  fs.appendFileSync(LOG_FILE, line + "\n");
}
