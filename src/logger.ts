import fs from "fs";
import path from "path";
import os from "os";

const LOG_FILE = path.join(
  os.homedir(),
  "workspace",
  "agent",
  "logs",
  "myplugins.log"
);

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ts(): string {
  return new Date().toISOString();
}

export function log(category: string, message: string, data?: any) {
  ensureDir();
  const line = JSON.stringify({
    time: ts(),
    category,
    message,
    ...(data !== undefined ? { data } : {}),
  });
  fs.appendFileSync(LOG_FILE, line + "\n");
}
