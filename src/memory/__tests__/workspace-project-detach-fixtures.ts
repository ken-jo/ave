import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryManager } from "../memory-manager.js";
import type { SessionMetadata } from "../session-repository.js";

export async function seedSession(
  memory: MemoryManager,
  dir: string,
  sessionId: string,
  projectRoot: string,
  title: string,
): Promise<string> {
  await memory.sessions.saveSession(sessionId, [{ role: "user", content: `message-${sessionId}` }]);
  await memory.sessions.saveSessionMetadata(sessionId, {
    sessionKind: "main",
    projectRoot,
    projectName: "Alpha",
    title,
    customFutureField: { preserved: true },
  } as SessionMetadata);
  return readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf-8");
}
