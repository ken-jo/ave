/**
 * Every catalog key whose text reaches the model is in the model-facing set
 * (`model-facing.ts`), which installed language packages may not translate.
 * The model reads: everything the system prompt, the engine and the tools
 * build (`src/prompts`, `src/engine`, `src/tools`), the shell execution
 * environment the system prompt describes, and a message a surface sends as
 * the user's own (`chatSend(t(...))`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isModelFacingKey } from "../model-facing.js";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const MODEL_SOURCES = ["prompts", "engine", "tools", join("shared", "shell-execution-environment.ts")];

function sourceFiles(path: string): string[] {
  const full = join(SRC, path);
  if (/\.tsx?$/u.test(full)) return [full];
  return readdirSync(full, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.parentPath.includes("__tests__"))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** `t("key"` and `translate(<locale>, "key"` literals. */
const KEY_LITERAL = /\b(?:t\(\s*|translate\(\s*[^,()]+,\s*)"([A-Za-z0-9_.]+)"/gu;
const CHAT_SEND_KEY = /\bchatSend\(\s*t\(\s*"([A-Za-z0-9_.]+)"/gu;

describe("model-facing catalog keys", () => {
  it("covers every key the system prompt, engine and tools read", () => {
    const outside: string[] = [];
    for (const file of MODEL_SOURCES.flatMap(sourceFiles)) {
      for (const [, key] of readFileSync(file, "utf8").matchAll(KEY_LITERAL)) {
        if (!isModelFacingKey(key!)) outside.push(`${relative(SRC, file)}: ${key}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("covers every key a surface sends to the model as the user's message", () => {
    const sent: string[] = [];
    const outside: string[] = [];
    for (const file of sourceFiles("ui")) {
      for (const [, key] of readFileSync(file, "utf8").matchAll(CHAT_SEND_KEY)) {
        sent.push(key!);
        if (!isModelFacingKey(key!)) outside.push(`${relative(SRC, file)}: ${key}`);
      }
    }
    // The scan finds the one there is today, so a pattern change cannot make it pass vacuously.
    expect(sent).toContain("routinePanel.naturalRoutinePrompt");
    expect(outside).toEqual([]);
  });

  it("keeps interface keys outside the set", () => {
    expect(isModelFacingKey("be_conversationLoop.generateTextSystemPrompt")).toBe(true);
    expect(isModelFacingKey("shellExecution.pipelineStatus")).toBe(true);
    expect(isModelFacingKey("appearanceTab.pageTitle")).toBe(false);
    expect(isModelFacingKey("routinePanel.errorNaturalParseFailed")).toBe(false);
  });
});
