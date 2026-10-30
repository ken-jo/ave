import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { settingsFilePath } from "../../data/settings-store.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import {
  annotateWithSandboxViolations, cleanupAsrtSandboxAfterCommand,
  isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand,
} from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { permissionSettingsPath } from "../permission-settings-store.js";
import { permissionsFilePath } from "../permissions-store.js";
import { projectRulesDirectory } from "../rules/project-rule-files.js";
import { egressGrantFilePath } from "../egress-grants.js";
import { userApprovalFilePath } from "../user-approval-store.js";
import { userPolicyPath } from "../policy-store.js";

const CONTROL_ENTRIES = [
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".gitconfig",
  ".git", ".git/hooks/pre-commit", ".git/config", ".git/modules/x/config", ".git/modules/future/hooks/pre-commit", ".vscode/settings.json",
] as const;
const linkedControlEntries = [...CONTROL_ENTRIES.filter(entry => entry !== ".git" && !entry.includes("/")), ".vscode"];

describe.skipIf(shouldSkipNativeSandboxTests())("sandbox control-file write boundary", () => {
  let root: string;
  let userData: string;
  let previousLocale: ReturnType<typeof getLocale>;
  beforeAll(async () => {
    previousLocale = getLocale();
    setLocale("en");
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-control-writes-")));
    userData = join(root, "desktop-data");
    vi.stubEnv("AVE_HOME", join(root, "ave"));
    mkdirSync(join(root, "ave", "config"), { recursive: true, mode: 0o700 });
    await initializeRequiredSandbox({ allowedDomains: [], userDataDir: userData });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    setLocale(previousLocale);
  });

  async function attempt(
    target: string,
    command = 'mkdir -p "$(dirname "$CONTROL_TARGET")" && printf changed >> "$CONTROL_TARGET"',
    writeRoots: string[] = [root],
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ status: number | null; output: string }> {
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: root, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand(command, {
        commandId: invocation.token, denyUnixSockets: true,
        // An explicit empty caller deny cannot remove mandatory host policy.
        filesystem: { allowWrite: writeRoots, denyWrite: [] },
      });
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
          env: { ...process.env, ...wrapped.env, ...extraEnv, CONTROL_TARGET: target }, cwd: root, stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 71) reject(new Error(stderr));
          else resolve({ status: code, stderr });
        });
      });
      expect(result.status, result.stderr).not.toBeNull();
      invocation.release();
      if (process.platform === "linux") expect(wrapped.cleanupCompleted).toBeDefined();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.failure, outcome?.failure).toBeUndefined();
      const output = await annotateWithSandboxViolations(invocation.token, result.stderr, command,
        [...(wrapped.notices ?? []), ...(outcome?.notice ? [outcome.notice] : [])]);
      return { status: result.status, output };
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
  }

  it.each(CONTROL_ENTRIES)("keeps %s protected when absent and present", async (entry) => {
    const project = join(root, `project-${entry.replaceAll("/", "-")}`);
    mkdirSync(project);
    const target = join(project, entry);
    // Grant this project itself so each reserved name is relative to a write root.
    const originalRoot = root;
    root = project;
    try {
      const missing = await attempt(target);
      if (process.platform === "linux" && (entry === ".git" || entry.startsWith(".git/"))) {
        expect(missing.status, missing.output).toBe(0);
        expect(missing.output).toContain("moved to quarantine (not deleted)");
        expect(missing.output).toContain("Restore each entry");
        expect(missing.output).toContain(`${JSON.stringify(join(project, ".git"))} -> `);
        expect(existsSync(join(project, ".git"))).toBe(false);
      } else expect(missing.status, missing.output).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "original");
      if (entry.startsWith(".git/")) writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
      if (entry.startsWith(".git/modules/")) writeFileSync(join(project, ".git", "modules", entry.split("/")[2]!, "HEAD"), "ref: refs/heads/main\n");
      expect((await attempt(target)).status).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe("original");
      const ordinary = join(project, "result.txt");
      expect((await attempt(ordinary)).status).toBe(0);
      expect(readFileSync(ordinary, "utf8")).toBe("changed");
    } finally {
      root = originalRoot;
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses symbolic repository markers before starting a command", async () => {
    const project = join(root, "linked-marker");
    const storage = join(root, "linked-marker-target");
    mkdirSync(project);
    mkdirSync(storage);
    const marker = join(project, ".git");
    symlinkSync(storage, marker, "dir");
    const ordinary = join(project, "result.txt");
    const originalRoot = root;
    root = project;
    try {
      await expect(attempt(ordinary)).rejects.toThrow("Linked sandbox Git markers are unsupported");
      expect(existsSync(ordinary)).toBe(false);
      expect(realpathSync(marker)).toBe(storage);
    } finally {
      root = originalRoot;
      rmSync(project, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it.each(linkedControlEntries)("prevents replacing the %s routing link while an independent child stays writable", async (entry) => {
    const project = join(root, `linked-${entry.replaceAll(".", "")}`);
    const storage = join(root, `targets-${entry.replaceAll(".", "")}`);
    const work = join(project, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(storage);
    const original = join(storage, "original");
    const replacement = join(storage, "replacement");
    const directory = entry === ".vscode";
    if (directory) {
      mkdirSync(original);
      mkdirSync(replacement);
    } else {
      writeFileSync(original, "original");
      writeFileSync(replacement, "planted");
    }
    const target = join(project, entry);
    symlinkSync(original, target, directory ? "dir" : "file");
    const ordinary = join(work, "result.txt");
    const originalRoot = root;
    root = project;
    try {
      const { status } = await attempt(target,
        `printf ordinary > ${shellQuote(ordinary)} && rm "$CONTROL_TARGET" && ln -s ${shellQuote(replacement)} "$CONTROL_TARGET"`,
        [project, work]);
      expect(status).not.toBeNull();
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary");
      expect(status).not.toBe(0);
      expect(realpathSync(target)).toBe(original);
      if (!directory) expect(readFileSync(original, "utf8")).toBe("original");
    } finally {
      root = originalRoot;
      rmSync(project, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("blocks opaque mutations of repository controls and application configuration while commits remain writable", async () => {
    const project = join(root, "opaque-project");
    mkdirSync(project);
    const gitConfigurationEnv = { GIT_CONFIG_GLOBAL: join(project, "git-global"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_ATTR_NOSYSTEM: "1", XDG_CONFIG_HOME: join(project, "git-xdg") };
    const gitEnv = { ...process.env, ...gitConfigurationEnv };
    execFileSync("git", ["init", "--quiet", project], { env: gitEnv });
    execFileSync("git", ["-C", project, "config", "user.name", "Sandbox Fixture"], { env: gitEnv });
    execFileSync("git", ["-C", project, "config", "user.email", "fixture.invalid"], { env: gitEnv });
    const configuration = join(process.env.AVE_HOME!, "config");
    mkdirSync(configuration, { recursive: true, mode: 0o700 });
    const targets = [join(project, ".git", "config"), join(project, ".git", "hooks", "pre-commit"),
      join(project, ".bash_profile"), join(configuration, "future-control.json")];
    const originalRoot = root;
    root = project;
    try {
      for (const target of targets) {
        mkdirSync(dirname(target), { recursive: true });
        if (!existsSync(target)) writeFileSync(target, "original");
        const original = readFileSync(target, "utf8");
        const command = "ELECTRON_RUN_AS_NODE=1 " + shellQuote(process.execPath)
          + " -e " + shellQuote('require("node:fs").appendFileSync(process.env.CONTROL_TARGET,"changed")');
        const result = await attempt(target, command, [project, configuration]);
        expect(result.status, result.output).not.toBe(0);
        expect(readFileSync(target, "utf8")).toBe(original);
      }
      const ordinary = join(project, "opaque-result.txt");
      const opaque = "ELECTRON_RUN_AS_NODE=1 " + shellQuote(process.execPath)
        + " -e " + shellQuote('require("node:fs").appendFileSync(process.env.CONTROL_TARGET,"changed")');
      const ordinaryResult = await attempt(ordinary, opaque, [project]);
      expect(ordinaryResult.status, ordinaryResult.output).toBe(0);
      expect(readFileSync(ordinary, "utf8")).toBe("changed");
      // A protected hook must not execute while testing the ordinary commit path.
      rmSync(join(project, ".git", "hooks", "pre-commit"));
      writeFileSync(join(project, "tracked.txt"), "checkpoint");
      const result = await attempt(join(project, "tracked.txt"),
        "git add tracked.txt && git -c commit.gpgSign=false commit --quiet -m checkpoint", [project], gitConfigurationEnv);
      expect(result.status, result.output).toBe(0);
      expect(execFileSync("git", ["-C", project, "log", "-1", "--format=%s"], { encoding: "utf8", env: gitEnv }).trim()).toBe("checkpoint");
      expect(existsSync(join(project, ".git", "index"))).toBe(true);
    } finally {
      root = originalRoot;
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("blocks settings, global/project rules, saved grants and policy writes from an ancestor grant", async () => {
    const targets = [settingsFilePath(userData), permissionSettingsPath(), permissionsFilePath(),
      join(projectRulesDirectory(join(root, "ave")), "project.json"),
      userApprovalFilePath(), egressGrantFilePath(), userPolicyPath()];
    for (const target of targets) {
      expect((await attempt(target)).status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "original");
      expect((await attempt(target)).status).not.toBe(0);
      expect(readFileSync(target, "utf8")).toBe("original");
    }
    const ordinary = join(root, "settings-control-result.txt");
    expect((await attempt(ordinary)).status).toBe(0);
    expect(readFileSync(ordinary, "utf8")).toBe("changed");
  });
});
