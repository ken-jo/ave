import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import { filterRegistryByEventAndTool } from "../hook-registry.js";
import { PluginHookTrustStore, preparePluginHookGeneration as prepareWithDigests } from "../plugin-hook-projection.js";

// Prepare with an approval digest per hook that follows its fingerprint, as `extensionComponentDigests` gives for changed bytes.
function preparePluginHookGeneration(generation: ActivePluginGeneration, root: string, dataDir: string) {
  return prepareWithDigests(generation, root, dataDir, new Map(generation.contributions.map((contribution) =>
    [contribution.localId, createHash("sha256").update(`digest:${contribution.fingerprint}`).digest("hex")])));
}

const payloadRoot = mkdtempSync(join(tmpdir(), "ave-plugin-hook-projection-"));
mkdirSync(join(payloadRoot, "hooks"), { recursive: true });
mkdirSync(join(payloadRoot, "data"), { recursive: true });
writeFileSync(join(payloadRoot, "hooks", "policy.mjs"), "process.stdout.write(JSON.stringify({ action: 'allow', reason: 'ok' }))");

afterAll(async () => {
  await cleanupTmpDir(payloadRoot);
});

function generation(version: string, generationId: string, fingerprint = "a".repeat(64)): ActivePluginGeneration {
  return {
    pluginId: "bundle-hooks",
    pluginVersion: version,
    artifactGenerationId: version === "1.0.0" && fingerprint === "a".repeat(64)
      ? "a".repeat(64)
      : "b".repeat(64),
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: "bundle-hooks",
      ownerVersion: version,
      kind: "hook",
      localId: "policy",
      path: "hooks/policy.json",
      fingerprint,
      files: [{
        path: "hooks/policy.json",
        sha256: fingerprint,
        content: JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "^portal_.*$", hooks: [{ type: "command", command: ["node", "./hooks/policy.mjs"] }] }],
          },
        }),
      }],
    }],
  };
}

describe("plugin-owned Hook projections", () => {
  it("preserves an HTTP definition and requires exact trust after its headers change", () => {
    const make = (token: string) => {
      const value = generation("1.0.0", "http-generation");
      const contribution = value.contributions[0];
      const content = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "http", url: "https://hooks.example.com/check", headers: { authorization: token } }] }] } });
      return { ...value, contributions: [{ ...contribution, fingerprint: createHash("sha256").update(content).digest("hex"),
        files: [{ ...contribution.files[0], content }] }] };
    };
    const [approved] = preparePluginHookGeneration(make("fixture-first"), payloadRoot, join(payloadRoot, "data"));
    const [changed] = preparePluginHookGeneration(make("fixture-second"), payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    trust.approve(approved);
    expect(trust.isApproved(changed)).toBe(false);
    const manager = new ScriptHookManager();
    manager.publishPluginGeneration([approved], trust);
    expect(manager.hooksOfType("pre")[0]).toMatchObject({ handlerType: "http", http: { url: "https://hooks.example.com/check" }, command: [] });
  });

  it("compiles plugin matchers at publication and reuses them during filtering", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    trust.approve(projection);
    const manager = new ScriptHookManager();
    const constructor = vi.spyOn(globalThis, "RegExp");
    try {
      manager.publishPluginGeneration([projection], trust);
      expect(constructor).toHaveBeenCalledTimes(1);
      const entries = manager.hooksOfType("pre");
      for (let call = 0; call < 3; call += 1) {
        expect(filterRegistryByEventAndTool(entries, "pre", "portal_read")).toHaveLength(1);
        expect(filterRegistryByEventAndTool(entries, "pre", "prefix_portal_read")).toEqual([]);
      }
      expect(constructor).toHaveBeenCalledTimes(1);
    } finally {
      constructor.mockRestore();
    }
  });

  it("prepares without spawn and contributes nothing until exact trust", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    manager.publishPluginGeneration([projection], trust);
    expect(manager.size()).toBe(0);
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);
    expect(manager.hooksOfType("pre")).toEqual([
      expect.objectContaining({
        id: "plugin:bundle-hooks:policy:PreToolUse#0.0",
        owner: expect.objectContaining({
          pluginId: "bundle-hooks",
          pluginVersion: "1.0.0",
          generationId: "a".repeat(64),
          localId: "policy",
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
  });

  it("refuses to run plugin hooks without exact generation leasing", async () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);

    await expect(manager.runPreToolUse({
      toolName: "portal_read",
      source: "plugin",
      category: "read",
      input: {},
      sessionId: "session-1",
      trustOrigin: "user-keyboard",
    })).rejects.toThrow(/cannot run without generation leasing/);
  });

  it("rejects a plugin Hook projection without an exact activation identity", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    const missingActivation = {
      ...projection,
      owner: { ...projection.owner, activationId: undefined },
    };
    const manager = new ScriptHookManager();
    expect(() => manager.preparePluginGeneration(
      [missingActivation] as never,
      new PluginHookTrustStore(),
      { pluginId: "bundle-hooks", generationId: "g1" },
    )).toThrow(/activation identity is missing/);
  });

  it("fails closed when a hook snapshot races generation retirement", async () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);
    const acquireExact = vi.fn(async () => {
      throw new Error("generation g1 retired before lease acquisition");
    });
    manager.setPluginGenerationAccess({ acquireExact } as never);

    await expect(manager.runPreToolUse({
      toolName: "portal_write",
      source: "plugin",
      category: "write",
      input: {},
      sessionId: "session-race",
      trustOrigin: "user-keyboard",
    })).rejects.toThrow(/retired before lease acquisition/);
    expect(acquireExact).toHaveBeenCalledOnce();
  });

  it("does not transfer trust across versions or fingerprints", () => {
    const trust = new PluginHookTrustStore();
    const [approved] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    trust.approve(approved);
    const [newVersion] = preparePluginHookGeneration(generation("2.0.0", "g2"), payloadRoot, join(payloadRoot, "data"));
    const [changed] = preparePluginHookGeneration(generation("1.0.0", "g3", "b".repeat(64)), payloadRoot, join(payloadRoot, "data"));
    const [restored] = preparePluginHookGeneration(generation("1.0.0", "g1-restored"), payloadRoot, join(payloadRoot, "data"));
    expect(trust.isApproved(newVersion)).toBe(false);
    expect(trust.isApproved(changed)).toBe(false);
    expect(trust.isApproved(restored)).toBe(true);
  });

  it("removes only the retired owner generation", () => {
    const trust = new PluginHookTrustStore();
    const manager = new ScriptHookManager();
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    trust.approve(projection);
    manager.publishPluginGeneration([projection], trust);
    manager.removePluginGeneration("bundle-hooks", "g1");
    expect(manager.size()).toBe(0);
  });

  it("rejects malformed configuration before publication", () => {
    const broken = generation("1.0.0", "g1");
    const contribution = broken.contributions[0];
    const malformed: ActivePluginGeneration = {
      ...broken,
      contributions: [{ ...contribution, files: [{ ...contribution.files[0], content: "{" }] }],
    };
    expect(() => preparePluginHookGeneration(malformed, payloadRoot, join(payloadRoot, "data"))).toThrow(/not valid JSON/);
  });

  it("anchors executable paths to the retained generation root", () => {
    const [projection] = preparePluginHookGeneration(generation("1.0.0", "g1"), payloadRoot, join(payloadRoot, "data"));
    expect(projection.entries[0].command).toEqual(["node", realpathSync(join(payloadRoot, "hooks", "policy.mjs"))]);
  });

  it("binds the materialized config directory and reviews bare file operands there", () => {
    const configDir = realpathSync(join(payloadRoot, "hooks"));
    const operand = join(configDir, "bare-policy.cjs");
    writeFileSync(operand, "module.exports = 'reviewed';");
    const value = generation("1.0.0", "bare-files");
    const contribution = value.contributions[0];
    const content = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command",
      command: ["node", "./hooks/policy.mjs", "bare-policy.cjs", "plain-argument"] }] }] } });
    const withBareOperand = { ...value, contributions: [{ ...contribution,
      files: [{ ...contribution.files[0], content }] }] };
    const [reviewed] = preparePluginHookGeneration(withBareOperand, payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    trust.approve(reviewed);
    expect(reviewed.entries[0]).toMatchObject({ configDir, command: ["node",
      realpathSync(join(configDir, "policy.mjs")), "bare-policy.cjs", "plain-argument"] });
    expect(reviewed.entries[0].fileDependencies).toContain(realpathSync(operand));
    expect(reviewed.entries[0].validateTrust?.()).toBe(true);

    writeFileSync(operand, "module.exports = 'changed';");
    expect(reviewed.entries[0].validateTrust?.()).toBe(false);
    expect(trust.isApproved(reviewed)).toBe(false);
    expect(trust.record(reviewed)).toBeUndefined();
    expect(() => trust.approve(reviewed)).toThrow("Hook definition changed before approval");
    const [changed] = preparePluginHookGeneration(withBareOperand, payloadRoot, join(payloadRoot, "data"));
    expect(changed.owner.fingerprint).not.toBe(reviewed.owner.fingerprint);
    expect(changed.approvalDigest).not.toBe(reviewed.approvalDigest);
    expect(trust.isApproved(changed)).toBe(false);
    writeFileSync(operand, "module.exports = 'reviewed';");
    expect(reviewed.entries[0].validateTrust?.()).toBe(true);
    expect(trust.isApproved(reviewed)).toBe(false);
    expect(trust.record(reviewed)).toBeUndefined();
  });

  it("withdraws approval when command-file validation throws", () => {
    const [base] = preparePluginHookGeneration(generation("1.0.0", "validator-error"), payloadRoot, join(payloadRoot, "data"));
    let unreadable = false;
    const projection = { ...base, entries: base.entries.map((entry) => ({ ...entry, validateTrust: () => {
      if (unreadable) throw new Error("file cannot be read");
      return true;
    } })) };
    const trust = new PluginHookTrustStore();
    trust.approve(projection);
    unreadable = true;
    expect(trust.record(projection)).toBeUndefined();
    unreadable = false;
    expect(trust.isApproved(projection)).toBe(false);
  });

  it("fails closed when a stale approval cannot be removed from disk", () => {
    const [base] = preparePluginHookGeneration(generation("1.0.0", "persist-error"), payloadRoot, join(payloadRoot, "data"));
    let current = true;
    const projection = { ...base, entries: base.entries.map((entry) => ({ ...entry, validateTrust: () => current })) };
    const directory = join(payloadRoot, "persisted-hook-trust");
    const displaced = `${directory}-retained`;
    const trust = new PluginHookTrustStore(join(directory, "approvals.json"));
    trust.approve(projection);
    renameSync(directory, displaced);
    writeFileSync(directory, "not a directory");
    current = false;
    try {
      expect(() => trust.isApproved(projection)).toThrow();
    } finally {
      unlinkSync(directory);
      renameSync(displaced, directory);
    }
    expect(trust.record(projection)).toBeUndefined();
    current = true;
    expect(trust.isApproved(projection)).toBe(false);
  });

  it("keeps a plugin's Hooks published while another plugin's generation was being prepared", () => {
    const base = generation("1.0.0", "g1");
    const other: ActivePluginGeneration = {
      ...base,
      pluginId: "other-hooks",
      contributions: base.contributions.map((contribution) => ({ ...contribution, ownerPluginId: "other-hooks" })),
    };
    const [first] = preparePluginHookGeneration(base, payloadRoot, join(payloadRoot, "data"));
    const [second] = preparePluginHookGeneration(other, payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    trust.approve(first);
    trust.approve(second);
    const manager = new ScriptHookManager();
    const preparedFirst = manager.preparePluginGeneration([first], trust);
    const preparedSecond = manager.preparePluginGeneration([second], trust);

    preparedFirst.publish();
    preparedSecond.publish();

    expect(manager.hooksOfType("pre").map((entry) => entry.owner?.pluginId).sort()).toEqual([
      "bundle-hooks",
      "other-hooks",
    ]);
  });

  it("keeps another plugin's Hooks when a prepared Hook removal publishes", () => {
    const base = generation("1.0.0", "g1");
    const other: ActivePluginGeneration = {
      ...base,
      pluginId: "other-hooks",
      contributions: base.contributions.map((contribution) => ({ ...contribution, ownerPluginId: "other-hooks" })),
    };
    const [first] = preparePluginHookGeneration(base, payloadRoot, join(payloadRoot, "data"));
    const [second] = preparePluginHookGeneration(other, payloadRoot, join(payloadRoot, "data"));
    const trust = new PluginHookTrustStore();
    trust.approve(first);
    trust.approve(second);
    const manager = new ScriptHookManager();
    manager.publishPluginGeneration([first], trust);
    const removal = manager.preparePluginGeneration([], trust, {
      pluginId: first.owner.pluginId, generationId: first.owner.activationId,
    });

    manager.publishPluginGeneration([second], trust);
    removal.publish();

    expect(manager.hooksOfType("pre").map((entry) => entry.owner?.pluginId)).toEqual(["other-hooks"]);
  });
});
