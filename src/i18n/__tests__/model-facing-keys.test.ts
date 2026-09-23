/**
 * Every catalog key whose text reaches the model is in the model-facing set
 * (`model-facing.ts`), which installed language packages may not translate.
 *
 * The scan is inverted so a new path to the model is caught by default: every
 * `t("…")` / `translate(…, "…")` key used outside the renderer must be in the
 * set, except in the files listed below, which only build interface text
 * (dialogs, menus, notifications, labels). In the renderer, a message a
 * surface sends as the user's own (`chatSend(t(...))`) must be in the set too,
 * and so must the origin guidance lines the system prompt emits per staged
 * input origin.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGED_ORIGIN_KINDS } from "../../shared/staged-origins.js";
import { isModelFacingKey } from "../model-facing.js";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Outside the renderer, the files whose catalog text only people read. */
const INTERFACE_FILES: ReadonlySet<string> = new Set([
  "ipc/domains/attach.ts", // file picker title
  "ipc/domains/chat.ts", // delete / import / export dialogs
  "ipc/domains/plugins.ts", // local plugin install dialogs
  "ipc/domains/ui.ts", // native context menus
  "ipc/domains/workspace.ts", // folder picker
  "lib/chat-stream-state.ts", // transcript recap labels
  "lib/llm-status-message.ts", // status line
  "main/auto-updater.ts", // update dialogs
  "main/global-shortcuts.ts", // shortcut notifications
  "main/host-api/pick-folders.ts", // folder picker
  "main/ave-deep-link.ts", // deep-link dialogs
  "main/startup-launch.ts", // login-item dialogs
  "shared/format-time.ts", // relative times in the sidebar
]);
/** The renderer and the catalogs themselves. */
const RENDERER_ROOTS = ["ui", "components", "i18n"];

function sourceFiles(root: string): string[] {
  return readdirSync(join(SRC, root), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.parentPath.split(sep).includes("__tests__"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const posix = (file: string) => relative(SRC, file).split(sep).join("/");

/** `t("key"` and `translate(<locale>, "key"` literals. */
const KEY_LITERAL = /\b(?:t\(\s*|translate\(\s*[^,()]+,\s*)["']([A-Za-z0-9_.]+)["']/gu;
const CHAT_SEND_KEY = /\bchatSend\(\s*t\(\s*["']([A-Za-z0-9_.]+)["']/gu;

describe("model-facing catalog keys", () => {
  it("covers every key used outside the renderer, except in interface-only files", () => {
    const outside: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(".")) {
      const path = posix(file);
      if (RENDERER_ROOTS.some((root) => path.startsWith(`${root}/`)) || INTERFACE_FILES.has(path)) continue;
      scanned += 1;
      for (const [, key] of readFileSync(file, "utf8").matchAll(KEY_LITERAL)) {
        if (!isModelFacingKey(key!)) outside.push(`${path}: ${key}`);
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(outside).toEqual([]);
  });

  it("lists only files that still exist", () => {
    const present = new Set(sourceFiles(".").map(posix));
    expect([...INTERFACE_FILES].filter((path) => !present.has(path))).toEqual([]);
  });

  it("covers every key a surface sends to the model as the user's message", () => {
    const sent: string[] = [];
    const outside: string[] = [];
    for (const file of sourceFiles("ui")) {
      for (const [, key] of readFileSync(file, "utf8").matchAll(CHAT_SEND_KEY)) {
        sent.push(key!);
        if (!isModelFacingKey(key!)) outside.push(`${posix(file)}: ${key}`);
      }
    }
    // The scan finds the one there is today, so a pattern change cannot make it pass vacuously.
    expect(sent).toContain("routinePanel.naturalRoutinePrompt");
    expect(outside).toEqual([]);
  });

  it("covers the origin guidance the system prompt emits for each staged origin", () => {
    const lines = STAGED_ORIGIN_KINDS.flatMap((kind) => kind.guidance.lineKeys);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((key) => !isModelFacingKey(key))).toEqual([]);
  });

  it("keeps interface keys outside the set", () => {
    expect(isModelFacingKey("be_conversationLoop.generateTextSystemPrompt")).toBe(true);
    expect(isModelFacingKey("shellExecution.pipelineStatus")).toBe(true);
    expect(isModelFacingKey("appearanceTab.pageTitle")).toBe(false);
    expect(isModelFacingKey("routinePanel.errorNaturalParseFailed")).toBe(false);
  });
});
