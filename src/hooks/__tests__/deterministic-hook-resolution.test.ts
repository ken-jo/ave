import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { loadHookConfig } from "../hook-config-trust.js";
import { listRuntimeHookTrustState, reviewRuntimeHookTrust } from "../hook-source-controller.js";
import type { HookRuntimePolicy } from "../hook-source-policy.js";
import type { HookCommandAuthorizer } from "../hook-command-policy.js";
import type { RunnableHook } from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";
import { hookDirLayout, type HookDirLayout } from "./test-helpers.js";

const NODE_EXECUTABLE = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const OPEN_POLICY: HookRuntimePolicy = { allowManagedHooksOnly: false, allowedHttpHookUrls: [], httpHookAllowedEnvVars: [], managedHooks: [] };
const PAYLOAD: ScriptHookStdin = { hookType: "pre", toolName: "read_file", source: "builtin", category: "read", input: {},
  sessionId: "deterministic-hook-session", trustOrigin: "user-keyboard" };

let root: string;
let layout: HookDirLayout;
let configPath: string;
let workspace: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "deterministic-hook-")));
  layout = hookDirLayout(root);
  configPath = join(layout.hooksDir, "hooks.json");
  workspace = join(root, "workspace");
  mkdirSync(layout.hooksDir, { recursive: true });
  mkdirSync(workspace);
});

afterEach(async () => { await cleanupTmpDir(root); });

function writeConfig(command: string[]): void {
  writeFileSync(configPath, JSON.stringify({ version: 1, hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }));
}

async function trust(command: string[], authorizeCommand: HookCommandAuthorizer = async () => ({ decision: "allow", reason: "approved hook" })) {
  writeConfig(command);
  const boot = await wireHookSystem({ ...layout, policy: OPEN_POLICY, authorizeCommand });
  const row = listRuntimeHookTrustState(boot.manager).disabled.find((entry) => entry.fileName === "hooks.json");
  if (!row) throw new Error("Hook configuration must appear in trust review");
  expect((await reviewRuntimeHookTrust(boot.manager, { sourceId: "user", fileName: row.fileName,
    expectedSha256: row.sha256, action: "accept" })).ok).toBe(true);
  const admitted = boot.manager.hooksOfType("pre")[0];
  if (!admitted) throw new Error("Reviewed configuration must supply a runnable hook");
  return { ...boot, admitted };
}

describe("deterministic command-file trust", () => {
  it.each([
    { form: "a bare script after a PATH interpreter", command: () => ["node", "policy.cjs"] },
    { form: "a bare script after an environment launcher", command: () => {
      const launcher = process.platform === "win32" ? join(root, "env-launcher.cmd") : "/usr/bin/env";
      if (process.platform === "win32") writeFileSync(launcher, "@node %*\r\n");
      return [launcher, "node", "policy.cjs"];
    } },
    { form: "a bare script after an absolute interpreter", command: () => [NODE_EXECUTABLE, "policy.cjs"] },
    { form: "a bare script after an anchored preload", command: () => [NODE_EXECUTABLE, "--require", "./preload.cjs", "policy.cjs"] },
  ])("rehashes $form and invalidates the reviewed definition", async ({ command }) => {
    const script = join(layout.hooksDir, "policy.cjs");
    writeFileSync(script, "process.stdout.write('reviewed');");
    writeFileSync(join(layout.hooksDir, "preload.cjs"), "module.exports = {};\n");
    const argv = command();
    writeConfig(argv);
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.errors).toEqual([]);
    const { admitted } = await trust(argv);
    expect(admitted.validateTrust?.()).toBe(true);
    writeFileSync(script, "process.stdout.write('changed');");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
    expect(admitted.validateTrust?.()).toBe(false);
  });

  it.each([false, true])("invalidates a symlink retarget even with identical target bytes: %s", async (identical) => {
    const first = join(root, "first-target.cjs");
    const second = join(root, "second-target.cjs");
    const link = join(layout.hooksDir, "policy.cjs");
    writeFileSync(first, "module.exports = 'reviewed';");
    writeFileSync(second, identical ? readFileSync(first) : "module.exports = 'changed';");
    symlinkSync(first, link, "file");
    const { admitted } = await trust([NODE_EXECUTABLE, "policy.cjs"]);
    const reviewed = loadHookConfig(configPath).trustHash;
    expect(admitted.validateTrust?.()).toBe(true);
    unlinkSync(link);
    symlinkSync(second, link, "file");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed);
    expect(admitted.validateTrust?.()).toBe(false);
  });

  it("binds and hashes a relative executable containing a directory separator", async () => {
    mkdirSync(join(layout.hooksDir, "bin"));
    const executable = join(layout.hooksDir, "bin", "tool");
    writeFileSync(executable, "reviewed executable");
    writeFileSync(join(layout.hooksDir, "policy.cjs"), "module.exports = {};\n");
    const { admitted } = await trust([join("bin", "tool"), "policy.cjs"]);
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.entries[0].command).toEqual([executable, "policy.cjs"]);
    expect(admitted.validateTrust?.()).toBe(true);
    writeFileSync(executable, "changed executable");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
    expect(admitted.validateTrust?.()).toBe(false);
  });

  it.each(["missing-to-file", "file-to-missing"])("invalidates operand membership changing %s", async (transition) => {
    writeFileSync(join(layout.hooksDir, "policy.cjs"), "module.exports = {};\n");
    const operand = join(layout.hooksDir, "optional.txt");
    if (transition === "file-to-missing") writeFileSync(operand, "reviewed operand");
    const { admitted } = await trust([NODE_EXECUTABLE, "policy.cjs", "optional.txt"]);
    const reviewed = loadHookConfig(configPath).trustHash;
    expect(admitted.validateTrust?.()).toBe(true);
    if (transition === "missing-to-file") writeFileSync(operand, "new operand");
    else unlinkSync(operand);
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed);
    expect(admitted.validateTrust?.()).toBe(false);
  });

  it("invalidates content shifted across a following operand's hash boundary", async () => {
    const first = join(layout.hooksDir, "first.cjs");
    const second = join(layout.hooksDir, "second.cjs");
    writeFileSync(first, "A");
    writeFileSync(second, "");
    const candidate = second.replaceAll("\\", "/");
    const target = realpathSync(second).replaceAll("\\", "/");
    const nextFilePrefix = `\0file:2\0${candidate}\0${target}\0`;
    writeFileSync(second, `X${nextFilePrefix}Y`);
    const { admitted } = await trust(["node", "first.cjs", "second.cjs"]);
    const reviewed = loadHookConfig(configPath).trustHash;
    expect(admitted.validateTrust?.()).toBe(true);
    writeFileSync(first, `A${nextFilePrefix}X`);
    writeFileSync(second, "Y");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed);
    expect(admitted.validateTrust?.()).toBe(false);
  });

  it("quarantines a script edit after approval before any code executes", async () => {
    const marker = join(workspace, "executed.txt");
    const script = join(layout.hooksDir, "policy.cjs");
    const body = (value: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)});process.stdout.write(JSON.stringify({action:'allow',reason:'executed'}));`;
    writeFileSync(script, body("reviewed"));
    let authorizations = 0;
    const { manager } = await trust([NODE_EXECUTABLE, "policy.cjs"], async () => {
      authorizations += 1;
      await Promise.resolve();
      writeFileSync(script, body("unreviewed"));
      return { decision: "allow", reason: "approved hook" };
    });
    const result = await manager.runPreToolUse(PAYLOAD, { cwd: layout.hooksDir });
    expect(authorizations).toBe(1);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Hook definition changed");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(layout.disabledDir, "hooks.json"))).toBe(true);
    expect(listRuntimeHookTrustState(manager).disabled).toContainEqual(expect.objectContaining({
      fileName: "hooks.json", hashState: "changed",
    }));
  });

  it("runs from the bound config directory while preserving the project env and output option", async () => {
    const output = join(workspace, "observed.json");
    const option = `--output=${output}`;
    writeFileSync(join(layout.hooksDir, "policy.cjs"), `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const option=process.argv.slice(2).find(value=>value.startsWith('--output='));fs.writeFileSync(option.slice('--output='.length),JSON.stringify({cwd:process.cwd(),projectDir:process.env.AVE_HOOK_PROJECT_DIR,pwd:process.env.PWD,stdinCwd:input.cwd,args:process.argv.slice(2)}));process.stdout.write(JSON.stringify({action:'allow',reason:'observed'}));`);
    writeFileSync(join(workspace, "policy.cjs"), "throw new Error('invocation cwd must not select code');");
    let approval: { cwd: string; projectDir?: string } | undefined;
    const authorizeCommand = async (_hook: RunnableHook, _input: ScriptHookStdin, cwd: string, projectDir?: string) => {
      approval = { cwd, projectDir };
      return { decision: "allow" as const, reason: "approved hook" };
    };
    const { manager } = await trust([NODE_EXECUTABLE, "policy.cjs", option], authorizeCommand);
    expect(manager.hooksOfType("pre")[0].command.slice(1)).toEqual(["policy.cjs", option]);
    const result = await manager.runPreToolUse(PAYLOAD, { cwd: workspace });
    expect(result.decision, result.reason).toBe("allow");
    expect(approval).toEqual({ cwd: layout.hooksDir, projectDir: workspace });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ cwd: layout.hooksDir,
      projectDir: workspace, pwd: layout.hooksDir, stdinCwd: layout.hooksDir, args: [option] });
  });
});
