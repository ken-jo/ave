/** Every catalog key whose text reaches the model is in the model-facing set (`model-facing.ts`), which installed language packages may not translate. The scan is inverted so a new path to the model is caught by default: every `t("…")` / `translate(…, "…")` key used outside the renderer must be in the set, except the
 * interface namespaces (dialogs, menus, notifications, labels) listed for the few files that also build text only people read. In the renderer, a message a surface sends as the user's own (`chatSend(t(...))`) must be in the set too, and so must the origin guidance lines the system prompt emits per staged input origin. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGED_ORIGIN_KINDS } from "../../shared/staged-origins.js";
import { isModelFacingKey } from "../model-facing.js";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Outside the renderer, the files that also build text only people read, and the interface
 * namespaces each may use there. Any other key in these files must still be model-facing. */
const INTERFACE_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["ipc/domains/attach.ts", ["mainDialog."]], // file picker title
  ["ipc/domains/chat.ts", ["mainDialog."]], // delete / import / export dialogs
  ["ipc/domains/git-marketplace.ts", ["mainDialog."]], // marketplace folder picker
  ["ipc/domains/plugins.ts", ["mainDialog."]], // local plugin install dialogs
  ["ipc/domains/preview.ts", ["chatPreviewRail.xlsxEnable"]], // native workbook permission dialog
  ["ipc/domains/ui.ts", ["chatPreviewRail.", "chatView.", "mainToolbar.", "sidebar.", "toolActivity.", "turnActionBar."]], // native context menus
  ["ipc/domains/workspace.ts", ["chatPreviewRail."]], // folder picker
  ["lib/chat-stream-state.ts", ["askUserQuestionCard."]], // transcript recap labels
  ["lib/llm-status-message.ts", ["useChatState."]], // status line
  ["main/auto-updater.ts", ["common.", "mainDialog."]], // update dialogs
  ["main/browser/browser-workspace-desktop.ts", ["browserWorkspace.permissionPrompt."]], // native site-permission dialog
  ["main/global-shortcuts.ts", ["startupTab."]], // shortcut notifications
  ["main/host-api/pick-folders.ts", ["mainDialog."]], // folder picker
  ["main/provider-settings-startup-error.ts", ["providerSettingsError."]], // startup settings error dialog
  ["main/auth-window-content.ts", ["oauthWindow."]], // login window address and TLS chrome
  ["main/auth-window-service.ts", ["oauthWindow."]], // login window title and system-browser notice
  ["main/startup-launch.ts", ["startupTab."]], // login-item dialogs
  ["shared/format-time.ts", ["sidebar."]], // relative times in the sidebar
  ["shared/plugin-provenance.ts", ["alerts."]], // plugin identity on cards and notifications
]);
/** The renderer and the catalogs themselves. */
const RENDERER_ROOTS = ["ui", "components", "i18n"];

function sourceFiles(root: string): string[] {
  return readdirSync(join(SRC, root), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:tsx?|[cm]?js)$/u.test(entry.name) && !entry.parentPath.split(sep).includes("__tests__"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const posix = (file: string) => relative(SRC, file).split(sep).join("/");

/** `t("key"` and `translate(<locale>, "key"` literals. */
const KEY_LITERAL = /\b(?:t\(\s*|translate\(\s*[^,()]+,\s*)["']([A-Za-z0-9_.]+)["']/gu;
const CHAT_SEND_KEY = /\bchatSend\(\s*t\(\s*["']([A-Za-z0-9_.]+)["']/gu;

describe("model-facing catalog keys", () => {
  it("covers every key used outside the renderer, except the interface namespaces a file is allowed", () => {
    const outside: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(".")) {
      const path = posix(file);
      if (RENDERER_ROOTS.some((root) => path.startsWith(`${root}/`))) continue;
      scanned += 1;
      const allowed = INTERFACE_KEYS.get(path) ?? [];
      for (const [, key] of readFileSync(file, "utf8").matchAll(KEY_LITERAL)) {
        if (isModelFacingKey(key!) || allowed.some((prefix) => key!.startsWith(prefix))) continue;
        outside.push(`${path}: ${key}`);
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(outside).toEqual([]);
  });

  it("lists only files that still exist, and only namespaces each still uses", () => {
    const present = new Set(sourceFiles(".").map(posix));
    expect([...INTERFACE_KEYS.keys()].filter((path) => !present.has(path))).toEqual([]);
    const unused: string[] = [];
    for (const [path, prefixes] of INTERFACE_KEYS) {
      const keys = [...readFileSync(join(SRC, path), "utf8").matchAll(KEY_LITERAL)].map(([, key]) => key!);
      for (const prefix of prefixes) {
        if (!keys.some((key) => key.startsWith(prefix))) unused.push(`${path}: ${prefix}`);
      }
    }
    expect(unused).toEqual([]);
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
    expect(isModelFacingKey("sandboxPolicy.quarantined")).toBe(true);
    expect(isModelFacingKey("sandboxPolicy.scanNarrowed")).toBe(true);
    expect(isModelFacingKey("appearanceTab.pageTitle")).toBe(false);
    expect(isModelFacingKey("routinePanel.errorNaturalParseFailed")).toBe(false);
    expect(isModelFacingKey("chatPreviewRail.xlsxEnableMessage")).toBe(false);
  });
});
