/** Untrusted or changed hooks.json must stay quarantined; only trusted, unchanged commands may load. */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRunner } from "../boot/conversation.js";
import { wireHookSystem } from "../boot/steps/hook-system-wiring.js";
import { acceptHookTrust } from "../hooks/hook-trust-commands.js";
import { HOOKS_CONFIG_FILENAME } from "../hooks/hook-config-trust.js";
import { writeJsonConfig, hookDirLayout, type HookDirLayout } from "../hooks/__tests__/test-helpers.js";
import { cleanupTmpDir } from "../__tests__/support/tmp-dir-teardown.js";

describe("boot hook runner wiring", () => {
  it("creates an in-process HookRunner with no external hook surface", async () => {
    const runner = createHookRunner();

    const pre = await runner.runPreHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    const post = await runner.runPostHooks({
      toolName: "bash",
      toolInput: { command: "ls" },
      toolOutput: "ok",
      isError: false,
    });

    expect(runner.preHookCount).toBe(0);
    expect(runner.postHookCount).toBe(0);
    expect(pre).toMatchObject({ action: "allow" });
    expect(post).toBeUndefined();
  });
});

describe("boot wireHookSystem — hooks.json rides the TOFU quarantine gate (#811)", () => {
  let tmpDir: string;
  let hooksDir: string;
  let disabledDir: string;
  let layout: HookDirLayout;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-hooks-wiring-"));
    layout = hookDirLayout(tmpDir);
    ({ hooksDir, disabledDir } = layout);
    configPath = join(hooksDir, HOOKS_CONFIG_FILENAME);
    mkdirSync(hooksDir, { recursive: true });
    // Omit discovery prefixes so this script is only a config command target.
    const p = join(hooksDir, "policy.sh");
    writeFileSync(p, "#!/bin/sh\necho '{\"action\":\"allow\",\"reason\":\"ok\"}'");
    chmodSync(p, 0o755);
  });

  afterEach(async () => {
    if (tmpDir) await cleanupTmpDir(tmpDir);
  });

  const CONFIG = {
    version: 1,
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./policy.sh" }] }] },
  };

  it("no hooks.json ⇒ empty registry (back-compat — behavior identical to today)", async () => {
    const boot = await wireHookSystem(layout);
    expect(boot.manager.size()).toBe(0);
    expect(boot.trust.trustedConfigEntries).toEqual([]);
  });

  it("an UNTRUSTED hooks.json is loaded ONLY into quarantine — never into the registry", async () => {
    writeJsonConfig(configPath, CONFIG);
    const boot = await wireHookSystem(layout);
    expect(boot.manager.size()).toBe(0);
    expect(boot.trust.trustedConfigEntries).toEqual([]);
    expect(boot.trust.disabledHooks.map((h) => h.fileName)).toContain(HOOKS_CONFIG_FILENAME);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("a TRUSTED hooks.json loads its command entries into the registry", async () => {
    writeJsonConfig(configPath, CONFIG);
    const firstBoot = await wireHookSystem(layout);
    expect(firstBoot.manager.size()).toBe(0);

    const accepted = await acceptHookTrust(HOOKS_CONFIG_FILENAME, {
      ...layout,
      manager: firstBoot.manager,
    });
    expect(accepted).toMatchObject({ ok: true });

    const secondBoot = await wireHookSystem(layout);
    expect(secondBoot.trust.trustedConfigEntries).toHaveLength(1);
    expect(secondBoot.manager.size()).toBe(1);
  });

  it("a CHANGED hooks.json after trust is re-quarantined — commands stop running", async () => {
    writeJsonConfig(configPath, CONFIG);
    const boot1 = await wireHookSystem(layout);
    await acceptHookTrust(HOOKS_CONFIG_FILENAME, { ...layout, manager: boot1.manager });
    const boot2 = await wireHookSystem(layout);
    expect(boot2.manager.size()).toBe(1);

    writeJsonConfig(configPath, { ...CONFIG, version: 999 });
    const boot3 = await wireHookSystem(layout);
    expect(boot3.manager.size()).toBe(0);
    expect(boot3.trust.trustedConfigEntries).toEqual([]);
    expect(existsSync(join(disabledDir, HOOKS_CONFIG_FILENAME))).toBe(true);
  });
});
