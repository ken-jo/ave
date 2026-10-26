// A killed process must retain completed work and partial text without rerunning interrupted tools.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryManager } from "../../memory/memory-manager.js";
import type { GenericMessage } from "../llm/types.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { historyToEntries, interruptedTurnOffer } from "../../ui/renderer/utils/history.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mid-stream-writer.ts");
const repoRoot = resolve(here, "../../..");
const SESSION_ID = "9e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOOL_ROUNDS = 3;

let home: string | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (home) await cleanupTmpDir(home);
  home = undefined;
  child = undefined;
});

function startWriter(mode: "stream" | "tool-hang", ready: RegExp): { ready: Promise<void>; exited: Promise<NodeJS.Signals | null> } {
  home = mkdtempSync(join(tmpdir(), "ave-kill-durability-"));
  const proc = spawn(
    process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath,
    ["--import=tsx", fixture, home, SESSION_ID, String(TOOL_ROUNDS), mode],
    { cwd: repoRoot, env: { ...process.env, HOME: home, AVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child = proc;
  let stdout = "";
  let stderr = "";
  proc.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const readyPromise = new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`writer never reached ${ready}: ${stdout}\n${stderr}`)), 60_000);
    proc.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (ready.test(stdout)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`writer exited ${code} before ${ready}: ${stderr}`));
    });
  });
  const exited = new Promise<NodeJS.Signals | null>((resolveExit) => proc.once("exit", (_code, signal) => resolveExit(signal)));
  return { ready: readyPromise, exited };
}

function reopen(): GenericMessage[] {
  return (new MemoryManager({ aveDir: home! }).loadSession(SESSION_ID) ?? []) as GenericMessage[];
}

describe("SIGKILL mid-turn", () => {
  it("keeps every completed round, every tool result, and the streaming text", async () => {
    const writer = startWriter("stream", /CHUNK_SNAPSHOT_SAVED\n[\s\S]*STREAMED 40\n|STREAMED 40\n[\s\S]*CHUNK_SNAPSHOT_SAVED\n/);
    await writer.ready;
    child!.kill("SIGKILL");
    expect(await writer.exited).toBe("SIGKILL");

    const messages = reopen();
    expect(messages[0]).toMatchObject({ role: "user", content: "kill test question" });
    for (let round = 0; round < TOOL_ROUNDS; round += 1) {
      expect(messages[1 + round * 2]).toMatchObject({
        role: "assistant",
        content: `round ${round} text`,
        toolCalls: [expect.objectContaining({ id: `call-${round}` })],
      });
      expect(messages[2 + round * 2]).toMatchObject({ role: "tool_result", toolUseId: `call-${round}` });
      expect(String(messages[2 + round * 2].content)).toContain(`"round":${round}`);
    }
    const partial = messages[1 + TOOL_ROUNDS * 2];
    expect(partial).toMatchObject({ role: "assistant", meta: { interrupted: true, interruptedBy: "host-exit" } });
    // Recovery guarantees an ordered stream prefix; throttle scheduling determines its length.
    const content = String(partial.content);
    const chunks = content.split(" ");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(content).toBe(chunks.map((_, i) => `chunk-${i}`).join(" "));
    process.stderr.write(`[kill-test] streamed>=41 chunks before SIGKILL, recovered ${chunks.length}\n`);
    expect(messages).toHaveLength(2 + TOOL_ROUNDS * 2);
    expect(new Set(messages.map((m) => m.meta?.messageId)).size).toBe(messages.length);

    const entries = historyToEntries(messages.map((m, i) => serializeHistoryMessage(m, i)));
    expect(interruptedTurnOffer(entries)).toBe("resume");
  }, 90_000);

  it("shows a tool that was running as interrupted with an unknown result, never re-run", async () => {
    const writer = startWriter("tool-hang", /TOOL_RUNNING\n/);
    await writer.ready;
    child!.kill("SIGKILL");
    await writer.exited;

    const messages = reopen();
    const hung = messages.find((m) => m.role === "tool_result" && m.toolUseId === `call-${TOOL_ROUNDS - 1}`);
    expect(hung).toMatchObject({ isError: true, meta: { toolDisplay: { cancelled: true } } });
    expect(messages[messages.length - 1]).toMatchObject({
      role: "assistant",
      content: "",
      meta: { interrupted: true, interruptedBy: "host-exit" },
    });
    const results = messages.filter((m) => m.role === "tool_result");
    expect(results).toHaveLength(TOOL_ROUNDS + 1);
    const completed = results.find((m) => m.toolUseId === "batch-completed");
    expect(completed).toMatchObject({ content: `work output {"round":${TOOL_ROUNDS - 1}}` });
    expect(completed?.isError).not.toBe(true);
    expect(results.slice(-2).map((m) => m.toolUseId)).toEqual(["batch-completed", `call-${TOOL_ROUNDS - 1}`]);
    expect(messages[1 + (TOOL_ROUNDS - 1) * 2]).toMatchObject({
      role: "assistant",
      toolCalls: [expect.objectContaining({ id: "batch-completed" }), expect.objectContaining({ id: `call-${TOOL_ROUNDS - 1}` })],
    });
    const entries = historyToEntries(messages.map((m, i) => serializeHistoryMessage(m, i)));
    expect(interruptedTurnOffer(entries)).toBe("resume");
  }, 90_000);
});
