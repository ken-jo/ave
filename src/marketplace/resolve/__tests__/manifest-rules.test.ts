import { describe, expect, it } from "vitest";
import type { PluginAuthority } from "../../catalog/types.js";
import { isMarketplaceError } from "../../errors.js";
import { assertGitInstallManifest, expectedPluginOf, gitInstallManifestMismatches, PLUGIN_AUTHORITY_FIELDS, type ExpectedPlugin } from "../manifest-rules.js";

const UNKNOWN_NAMESPACE = "xyz.example";

const authority = (): PluginAuthority => ({
  capabilities: ["llm.chat"],
  networkAccess: { allowedDomains: ["api.example.com"] },
  hostSecrets: { read: ["llm.apiKey.openai"] },
  pluginAccess: { allow: ["notes"] },
  auth: { kind: "none" },
  requires: { capabilities: ["llm.chat"], minAppVersion: "0.12.0" },
  dependencies: [{ id: "notes", version: ">=1.0.0" }],
});

const expected = (): ExpectedPlugin => ({ name: "alpha", version: "1.2.0", minAppVersion: "0.12.0", authority: authority(), platforms: undefined, artifact: undefined });

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const ave = Object.fromEntries(Object.entries(authority()).reverse());
  return {
    name: "alpha",
    version: "1.2.0",
    description: "Alpha",
    extensions: { "ai.agent-connector.ave": { displayName: "Alpha", entry: "dist/index.js", ...ave, ...patch } },
  };
}

describe("git-install manifest rules (design §5.3)", () => {
  it("accepts a manifest equal to the descriptor, whatever its key order and extra host fields", () => {
    expect(gitInstallManifestMismatches(manifest(), expected())).toEqual([]);
  });

  it.each(PLUGIN_AUTHORITY_FIELDS.filter((field) => field !== "requires" && field !== "sandbox"))("stops on a different %s", (field) => {
    expect(gitInstallManifestMismatches(manifest({ [field]: ["changed"] }), expected())).toEqual([`${field} differs from the descriptor's authority`]);
  });

  it.each(PLUGIN_AUTHORITY_FIELDS.filter((field) => field !== "requires" && field !== "capabilities" && field !== "sandbox"))(
    "stops when the manifest adds %s the descriptor does not declare",
    (field) => {
      const narrower = expected();
      delete narrower.authority[field];
      expect(gitInstallManifestMismatches(manifest(), narrower)).toEqual([`${field} differs from the descriptor's authority`]);
    },
  );

  it("holds a valid sandbox declaration equal to the reviewed authority", () => {
    const sandbox = { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read a certificate bundle" }],
      write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store workspace data" }] } as const;
    const document = manifest({ sandbox, configSchema: { properties: { workspace: { type: "string" } } } });
    expect(gitInstallManifestMismatches(document, { ...expected(), authority: { ...authority(), sandbox: sandbox as unknown as PluginAuthority["sandbox"] } })).toEqual([]);
    expect(gitInstallManifestMismatches(document, expected())).toEqual(["sandbox differs from the descriptor's authority"]);
  });

  it("requires requires.minAppVersion and its equality with the descriptor", () => {
    expect(gitInstallManifestMismatches(manifest({ requires: { capabilities: ["llm.chat"] } }), expected())).toEqual([
      "requires.minAppVersion is required for a git install",
      "requires differs from the descriptor's authority",
    ]);
    expect(gitInstallManifestMismatches(manifest({ requires: { capabilities: ["llm.chat"], minAppVersion: "0.11.0" } }), expected())).toEqual([
      'requires.minAppVersion is "0.11.0", the descriptor says "0.12.0"',
      "requires differs from the descriptor's authority",
    ]);
  });

  it("throws PACKAGE_COMPAT_UNDECLARED for a missing requires.minAppVersion, MANIFEST_MISMATCH otherwise (design §14)", () => {
    expect(() => assertGitInstallManifest(manifest({ requires: { capabilities: ["llm.chat"] } }), expected())).toThrow(
      expect.objectContaining({ code: "PACKAGE_COMPAT_UNDECLARED" }),
    );
    expect(() => assertGitInstallManifest(manifest({ requires: { capabilities: ["llm.chat"], minAppVersion: "0.11.0" } }), expected())).toThrow(
      expect.objectContaining({ code: "MANIFEST_MISMATCH" }),
    );
  });

  it("checks name and version, and rejects installPolicy and publisher by name", () => {
    const wrong = { ...manifest({ installPolicy: "admin", publisher: "Ave Official" }), name: "beta", version: "1.2.1" };
    expect(gitInstallManifestMismatches(wrong, expected())).toEqual([
      'name is "beta", the descriptor says "alpha"',
      'version is "1.2.1", the descriptor says "1.2.0"',
      "installPolicy is no longer supported: no package is installed or locked by its own manifest",
      "publisher is no longer supported: no verified publishing identity backs it",
    ]);
  });

  it("refuses a document without the Ave extension block", () => {
    expect(gitInstallManifestMismatches([], expected())).toEqual(["plugin.json is not a JSON object"]);
    expect(gitInstallManifestMismatches({ name: "alpha", version: "1.2.0" }, expected())).toEqual(['extensions["ai.agent-connector.ave"] is missing']);
  });

  it("never reads Ave fields from an unknown extension namespace, and leaves one beside the Ave block alone", () => {
    const current = manifest();
    const unknownOnly = { ...current, extensions: { [UNKNOWN_NAMESPACE]: (current.extensions as Record<string, unknown>)["ai.agent-connector.ave"] } };
    const both = { ...current, extensions: { ...(current.extensions as Record<string, unknown>), [UNKNOWN_NAMESPACE]: {} } };
    expect(gitInstallManifestMismatches(unknownOnly, expected())).toEqual(['extensions["ai.agent-connector.ave"] is missing']);
    expect(gitInstallManifestMismatches(both, expected())).toEqual([]);
  });

  it("throws MANIFEST_MISMATCH naming every problem", () => {
    try {
      assertGitInstallManifest(manifest({ capabilities: [] }), expected());
      expect.unreachable();
    } catch (error) {
      expect(isMarketplaceError(error) && error.code).toBe("MANIFEST_MISMATCH");
      expect((error as Error).message).toContain("alpha@1.2.0: capabilities differs");
    }
    expect(() => assertGitInstallManifest(manifest(), expected())).not.toThrow();
  });

});

describe("process-entry admission, declared half (§9.7 P4, decision 34)", () => {
  const SHA = "c".repeat(64);
  const processAuthority = (minAppVersion = "0.14.0"): PluginAuthority => ({
    ...authority(),
    requires: { capabilities: ["llm.chat"], minAppVersion, hostProtocol: "4" },
  });
  const admitted = (patch: Partial<ExpectedPlugin> = {}): ExpectedPlugin => ({
    name: "alpha",
    version: "1.2.0",
    minAppVersion: "0.14.0",
    hostProtocol: "4",
    authority: processAuthority(),
    platforms: ["darwin", "linux"],
    artifact: { release: { repo: "acme/alpha", sha256: SHA } },
    ...patch,
  });
  function processManifest(minAppVersion = "0.14.0"): Record<string, unknown> {
    const document = manifest({ ...processAuthority(minAppVersion), process: { command: "./bin/plugin" }, tools: [] });
    delete (document.extensions as { "ai.agent-connector.ave": Record<string, unknown> })["ai.agent-connector.ave"].entry;
    return document;
  }

  const PLATFORMS_UNDECLARED = 'platforms is not declared in ave-package.json; a process entry must list its platforms, without "win32"';
  const WINDOWS = 'platforms in ave-package.json includes "win32", where a process entry cannot run';
  const UNPINNED = "artifact in ave-package.json pins no release or archive by sha256, which a process entry is installed from";
  const TREE = "artifact.tree is declared in ave-package.json; a process entry is never installed from the tree rung";

  it("passes darwin and linux with a pinned release or archive and 0.14.0", () => {
    expect(gitInstallManifestMismatches(processManifest(), admitted())).toEqual([]);
    expect(() => assertGitInstallManifest(processManifest(), admitted())).not.toThrow();
    const archive = admitted({ artifact: { archive: { url: "https://example.com/alpha-1.2.0.zip", sha256: SHA } } });
    expect(gitInstallManifestMismatches(processManifest(), archive)).toEqual([]);
  });

  it.each<[string, Partial<ExpectedPlugin>, string[]]>([
    ["without platforms", { platforms: undefined }, [PLATFORMS_UNDECLARED]],
    ["with win32", { platforms: ["darwin", "win32", "linux"] }, [WINDOWS]],
    ["with only a tree", { artifact: { tree: "plugins/alpha" } }, [UNPINNED, TREE]],
    ["with a release and no sha256", { artifact: { release: { repo: "acme/alpha" } } }, [UNPINNED]],
    ["with no artifact pins at all", { artifact: undefined }, [UNPINNED]],
    ["with a tree beside a pinned release", { artifact: { release: { repo: "acme/alpha", sha256: SHA }, tree: "plugins/alpha" } }, [TREE]],
  ])("is MANIFEST_MISMATCH %s, naming the field", (_label, patch, problems) => {
    expect(gitInstallManifestMismatches(processManifest(), admitted(patch))).toEqual(problems);
    expect(() => assertGitInstallManifest(processManifest(), admitted(patch))).toThrow(
      expect.objectContaining({ code: "MANIFEST_MISMATCH", message: expect.stringContaining(problems[0]!) }),
    );
  });

  it("uses protocol negotiation without inventing a release floor for an unreleased protocol", () => {
    const candidate = admitted({ minAppVersion: "0.13.0", authority: processAuthority("0.13.0") });
    expect(gitInstallManifestMismatches(processManifest("0.13.0"), candidate)).toEqual([]);
    expect(() => assertGitInstallManifest(processManifest("0.13.0"), candidate)).not.toThrow();
  });

  it("still enforces the released process-entry floor for an unreleased protocol", () => {
    // The process-entry floor remains independent of protocol negotiation.
    const below = admitted({ minAppVersion: "0.12.0", authority: processAuthority("0.12.0") });
    expect(gitInstallManifestMismatches(processManifest("0.12.0"), below)).toEqual([
      'minAppVersion in ave-package.json is "0.12.0"; a process entry needs 0.13.0 or newer, the first release that runs one',
    ]);
    expect(() => assertGitInstallManifest(processManifest("0.12.0"), below)).toThrow(expect.objectContaining({ code: "MANIFEST_MISMATCH" }));
  });

  it("installs a legacy protocol-3 package at its 0.14.0 floor and refuses one below it", () => {
    const legacyAuthority = (minAppVersion: string): PluginAuthority => ({
      ...authority(),
      requires: { capabilities: ["llm.chat"], minAppVersion, hostProtocol: "3" },
    });
    const legacyManifest = (minAppVersion: string) => {
      const document = manifest({ ...legacyAuthority(minAppVersion), process: { command: "./bin/plugin" }, tools: [] });
      delete (document.extensions as { "ai.agent-connector.ave": Record<string, unknown> })["ai.agent-connector.ave"].entry;
      return document;
    };
    const at = (minAppVersion: string) => admitted({ minAppVersion, hostProtocol: "3", authority: legacyAuthority(minAppVersion) });
    expect(gitInstallManifestMismatches(legacyManifest("0.14.0"), at("0.14.0"))).toEqual([]);
    expect(gitInstallManifestMismatches(legacyManifest("0.13.0"), at("0.13.0"))).toEqual([
      'minAppVersion in ave-package.json is "0.13.0"; host protocol 3 needs 0.14.0 or newer, the first release that serves it',
    ]);
  });

  it("leaves an entry manifest that runs on win32 from the tree rung untouched", () => {
    const entryOnTree = { ...expected(), platforms: ["darwin", "win32", "linux"] as const, artifact: { tree: "plugins/alpha" } };
    expect(gitInstallManifestMismatches(manifest(), entryOnTree)).toEqual([]);
  });

  it("takes platforms and artifact from the plan, so every plan-based producer checks them", () => {
    const plan = { name: "alpha", version: "1.2.0", minAppVersion: "0.14.0", hostProtocol: "4", platforms: ["darwin" as const], authority: processAuthority(), artifact: { tree: "x" } };
    expect(expectedPluginOf(plan)).toEqual({
      name: "alpha", version: "1.2.0", minAppVersion: "0.14.0", hostProtocol: "4", authority: processAuthority(), platforms: ["darwin"], artifact: { tree: "x" },
    });
  });
});
