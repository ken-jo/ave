import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { settingsFilePath } from "../../data/settings-store.js";
import {
  buildPerCommandSandboxCustomConfig, cleanupAsrtSandboxAfterCommand,
  initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand,
} from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { userPolicyPath } from "../policy-store.js";
import { asrtCanInitialize } from "./test-helpers.js";

const CONTROL_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".git/hooks/pre-commit", ".git/config", ".vscode/settings.json",
] as const;

describe("sandbox control-file write boundary", () => {
  let root: string;
  let userData: string;
  let active = false;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-control-writes-")));
    userData = join(root, "desktop-data");
    vi.stubEnv("AVE_HOME", join(root, "ave"));
    active = process.platform !== "win32" && await asrtCanInitialize();
    if (active) await initializeAsrtSandbox({ allowedDomains: [], userDataDir: userData });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function attempt(target: string): Promise<number | null> {
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: root, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand('mkdir -p "$(dirname "$CONTROL_TARGET")" && printf changed >> "$CONTROL_TARGET"', {
        commandId: invocation.token, denyUnixSockets: true,
        // An explicit empty caller deny cannot remove mandatory host policy.
        filesystem: { allowWrite: [root], denyWrite: [] },
      });
      return await new Promise((resolve, reject) => {
        const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
          env: { ...process.env, ...wrapped.env, CONTROL_TARGET: target }, cwd: root, stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 71) reject(new Error(stderr));
          else resolve(code);
        });
      });
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
  }

  it.each(CONTROL_ENTRIES)("keeps %s protected when absent and present", async (entry) => {
    const project = join(root, entry.replaceAll("/", "-"));
    mkdirSync(project);
    const target = join(project, entry);
    const config = buildPerCommandSandboxCustomConfig({ allowWrite: [project], denyWrite: [] });
    // The configured deny exists even before its protected entry is created.
    const protectedRoot = entry.startsWith(".git/hooks/") ? join(project, ".git/hooks")
      : entry.startsWith(".vscode/") ? join(project, ".vscode") : target;
    expect(config?.filesystem?.denyWrite).toContain(protectedRoot);
    if (!active) {
      expect(isAsrtSandboxActive()).toBe(false);
      return;
    }
    // Grant this project itself so each reserved name is relative to a write root.
    const originalRoot = root;
    root = project;
    try {
      expect(await attempt(target)).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "original");
      expect(await attempt(target)).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe("original");
      const ordinary = join(project, "result.txt");
      expect(await attempt(ordinary)).toBe(0);
      expect(readFileSync(ordinary, "utf8")).toBe("changed");
    } finally { root = originalRoot; }
  });

  it("blocks settings, global/project rules, saved grants and policy writes from an ancestor grant", async () => {
    const targets = [settingsFilePath(userData), permissionSettingsPath(), permissionsFilePath(),
      join(projectRulesDirectory(join(root, "ave")), "project.json"),
      userApprovalFilePath(), egressGrantFilePath(), userPolicyPath()];
    if (!active) { expect(isAsrtSandboxActive()).toBe(false); return; }
    for (const target of targets) {
      expect(await attempt(target)).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "original");
      expect(await attempt(target)).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe("original");
    }
  });
});
