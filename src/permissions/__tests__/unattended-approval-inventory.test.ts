import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { expect, it } from "vitest";

const SRC = new URL("../../", import.meta.url);

const APPROVAL_GATE_CALLERS = [
  "boot/steps/plugin-tool-executor.ts",
  "engine/subagent-runner.ts",
  "engine/turn/query-loop.ts",
  "hooks/hook-command-policy.ts",
  "mcp/mcp-elicitation-resolver.ts",
  "permissions/agent-action-approver.ts",
  "permissions/effect-enforcement.ts",
  "permissions/egress-approval.ts",
  "permissions/extension-start-asker.ts",
  "permissions/permission-mode-apply.ts",
  "tools/invocation-authorization.ts",
  "tools/invocation-execution.ts",
  "tools/invocation-runner.ts",
  "tools/pipeline/user-owned-surface.ts",
  "tools/skill-load.ts",
];

// A new native presenter requires review as either a tool-owned ask or a user-operated window.
const NATIVE_ASK_ENTRY_POINTS = {
  "boot/desktop-host-runtime.ts": ["pickBrowserUploadFiles: async"],
  "main/auth-partition-viewer-service.ts": ["export async function openAuthPartitionViewer"],
  "main/auth-window-service.ts": ["export async function openAuthWindow", "export async function openOAuthInAuthWindow"],
  "main/browser/browser-workspace-desktop.ts": ["promptPermission: async"],
  "main/device-code-dialog.ts": ["async show(prompt, controller)"],
  "main/host-api/pick-folders.ts": ["export async function pickFoldersForPlugin"],
};

const NON_ASK_NATIVE_PRESENTERS = [
  "ipc/domains/attach.ts", "ipc/domains/chat.ts", "ipc/domains/git-marketplace.ts",
  "ipc/domains/memory-map-runtime.ts", "ipc/domains/plugin-studio.ts", "ipc/domains/plugins.ts",
  "ipc/domains/settings.ts", "ipc/domains/window.ts", "ipc/domains/workspace.ts",
  "main/audio-capture-surface.ts", "main/auto-updater.ts", "main/floating-dock-surface.ts", "main/link-window-service.ts",
  // A popup from the already guarded authentication window, never a second HostApi entry.
  "main/auth-window-content.ts",
];

const GUARDS = {
  ...NATIVE_ASK_ENTRY_POINTS,
  "main/ask-user-question-gate.ts": ["  ask(input:"],
  "main/browser/browser-upload.ts": ["export async function stageBrowserUpload"],
  "main/browser/browser-page-prompts.ts": ["  ask<K extends"],
  "permissions/approval-gate.ts": ["async requestAndWait(req:"],
  "permissions/extension-start-consent.ts": ["function answer(entry:", "function deferExtensionStart(", "function takeExtensionStartGrant("],
  "tools/invocation-execution.ts": ["authorizeBrowserSite: async"],
  "tools/skill-load.ts": ["const skillName ="],
};

function enclosingFunctionBody(node: ts.Node, offset: number): ts.Block | undefined {
  if (offset < node.getStart() || offset >= node.getEnd()) return undefined;
  const inner = node.forEachChild(child => enclosingFunctionBody(child, offset));
  if (inner) return inner;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
    return node.body && ts.isBlock(node.body) ? node.body : undefined;
  }
  if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) {
    return node.initializer.body;
  }
  return undefined;
}

it("routes every inventoried approval request and native ask through the unattended turn guard", () => {
  const sources = new Map(readdirSync(fileURLToPath(SRC), { recursive: true, encoding: "utf8" }).map(path => path.replaceAll("\\", "/"))
    .filter(path => path.endsWith(".ts") && !path.split("/").includes("__tests__") && !path.includes("/test-helpers.") && !path.startsWith("ui/"))
    .map(path => [path, readFileSync(new URL(path, SRC), "utf8")]));
  const filesUsing = (pattern: RegExp) => [...sources].filter(([, source]) => pattern.test(source)).map(([path]) => path).sort();

  expect(filesUsing(/\.requestAndWait!?\s*\(/)).toEqual([...APPROVAL_GATE_CALLERS].sort());
  expect(filesUsing(/\.send\(\s*(?:IPC_APPROVAL_REQUEST|IPC_ASK_USER_QUESTION_REQUEST|CHANNELS\.(?:approval|askUserQuestion)\.request)\b/)).toEqual([
    "main/ask-user-question-gate.ts", "permissions/approval-gate.ts",
  ]);
  expect(filesUsing(/\.(?:showOpenDialog|showMessageBox)(?:Sync)?\(|new BrowserWindow\(/)).toEqual([
    ...Object.keys(NATIVE_ASK_ENTRY_POINTS), ...NON_ASK_NATIVE_PRESENTERS,
  ].sort());
  const guardedSources = new Map([...sources].filter(([path]) => Object.hasOwn(GUARDS, path)));
  const parsed = parseSourceTexts(guardedSources) as Map<string, ts.SourceFile>;
  for (const [path, entries] of Object.entries(GUARDS)) {
    const source = sources.get(path);
    if (source === undefined) throw new Error(`Missing approval surface source: ${path}`);
    const syntax = parsed.get(path);
    if (!syntax) throw new Error(`Could not parse approval surface: ${path}`);
    for (const entry of entries) {
      const start = source.indexOf(entry);
      expect(start, entry).toBeGreaterThanOrEqual(0);
      const offset = start + entry.search(/\S/);
      const body = enclosingFunctionBody(syntax, offset);
      expect(body?.getText(), entry).toContain("unattendedApprovalDenial()");
    }
  }
  const gate = sources.get("permissions/approval-gate.ts")?.split("async requestAndWait(req:")[1];
  expect(gate?.indexOf("unattendedApprovalDenial()")).toBeLessThan(gate?.indexOf("this.pending.set") ?? -1);
  expect(gate?.indexOf("unattendedApprovalDenial()")).toBeLessThan(gate?.indexOf("this.notifyPendingParked") ?? -1);
});
