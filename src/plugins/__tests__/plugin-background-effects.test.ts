import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATED_EFFECT_PATHS } from "../../permissions/effect-enforcement.js";
import {
  backgroundEffectPaths,
  declaredBackgroundEffects,
  PluginBackgroundEffectApprovals,
} from "../plugin-background-effects.js";
import type { PluginManifest } from "../types.js";

const STORAGE_WRITES = ["storage.write", "storage.writeJson", "storage.rm", "storage.mkdir", "storage.writeEncrypted"];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id: "sample", name: "Sample", version: "1.0.0", entry: "plugin.mjs", description: "sample", tools: [], ...extra } as PluginManifest;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function approvalsFile(): string {
  const root = mkdtempSync(join(tmpdir(), "background-effects-"));
  roots.push(root);
  return join(root, "plugin-contribution-trust", "background-effects.json");
}

describe("the background scope a manifest declares", () => {
  it("is the plugin's own storage alone when it declares nothing else", () => {
    expect(declaredBackgroundEffects(manifest())).toEqual({
      ownStorage: true, networkDestinations: [], alertKinds: [], suggestionSources: [],
    });
    expect([...backgroundEffectPaths(manifest())].sort()).toEqual([...STORAGE_WRITES].sort());
  });

  it("adds each declared destination, alert kind and suggestion source", () => {
    const declaring = manifest({
      networkAccess: { allowedDomains: ["api.example.test"] },
      alerts: {
        reasoning: "Tells you when a digest is ready.",
        kinds: [{
          id: "digest", label: { en: "Morning digest" }, defaultEnabled: true, visibility: "summary-only",
          slots: { topics: { kind: "list", maxItems: 5, maxLength: 120 } },
          summary: { en: "Today: {topics}" }, prompt: { en: "Summarise these topics for me: {topics}" },
        }],
        suggestions: ["overlay:sample-routine"],
      },
    } as Partial<PluginManifest>);
    expect(declaredBackgroundEffects(declaring)).toEqual({
      ownStorage: true,
      networkDestinations: ["api.example.test"],
      alertKinds: ["digest"],
      suggestionSources: ["overlay:sample-routine"],
    });
    expect([...backgroundEffectPaths(declaring)].sort()).toEqual([...STORAGE_WRITES, "hostFetch", "raiseAlert", "triggerConversation"].sort());
  });

  it("names only real gated paths, so every other gated path is denied outside a tool call", () => {
    for (const path of STORAGE_WRITES) expect(GATED_EFFECT_PATHS.has(path)).toBe(true);
    for (const path of ["raiseAlert", "triggerConversation"]) expect(GATED_EFFECT_PATHS.has(path)).toBe(true);
    const denied = [...GATED_EFFECT_PATHS].filter((path) => !STORAGE_WRITES.includes(path) && path !== "raiseAlert" && path !== "triggerConversation");
    expect(denied).toEqual(expect.arrayContaining(["config.set", "spawnWorker", "openExternalUrl", "callLlm"]));
  });
});

describe("background effect approvals", () => {
  it("bind one manifest hash per plugin; a new hash replaces the old one", () => {
    const approvals = new PluginBackgroundEffectApprovals();
    expect(approvals.isApproved("sample", HASH_A)).toBe(false);
    approvals.approve("sample", HASH_A);
    expect(approvals.isApproved("sample", HASH_A)).toBe(true);
    expect(approvals.isApproved("sample", HASH_B)).toBe(false);
    expect(approvals.isApproved("sample", null)).toBe(false);
    expect(approvals.isApproved("other", HASH_A)).toBe(false);
    approvals.approve("sample", HASH_B);
    expect(approvals.isApproved("sample", HASH_A)).toBe(false);
    expect(approvals.isApproved("sample", HASH_B)).toBe(true);
    expect(() => approvals.approve("sample", "not-a-hash")).toThrow();
  });

  it("persist across loads and approve nothing from a malformed file", () => {
    const path = approvalsFile();
    new PluginBackgroundEffectApprovals(path).approve("sample", HASH_A);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, approvals: [{ pluginId: "sample", manifestSha256: HASH_A }] });
    expect(new PluginBackgroundEffectApprovals(path).isApproved("sample", HASH_A)).toBe(true);
    for (const body of ["{", JSON.stringify({ version: 2, approvals: [] }), JSON.stringify({ version: 1, approvals: [{ pluginId: "sample", manifestSha256: "x" }] })]) {
      writeFileSync(path, body);
      expect(new PluginBackgroundEffectApprovals(path).isApproved("sample", HASH_A)).toBe(false);
    }
  });
});
