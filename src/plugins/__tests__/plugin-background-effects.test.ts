import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATED_EFFECT_PATHS } from "../../permissions/effect-enforcement.js";
import {
  backgroundEffectPaths,
  backgroundEffectScopeSha256,
  backgroundEffectSubject,
  declaredBackgroundEffects,
  PluginBackgroundEffectApprovals,
  withinBackgroundScope,
} from "../plugin-background-effects.js";
import type { PluginManifest, PluginRegistryEntryOrigin, PluginRegistryTrust } from "../types.js";

const atomicWrites = vi.hoisted(() => ({ fail: false }));
vi.mock("../../lib/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/atomic-file.js")>();
  return {
    ...actual,
    writeUtf8FileAtomicSync: (...args: Parameters<typeof actual.writeUtf8FileAtomicSync>) => {
      if (atomicWrites.fail) throw new Error("disk full");
      return actual.writeUtf8FileAtomicSync(...args);
    },
  };
});

const STORAGE_WRITES = ["storage.write", "storage.writeJson", "storage.rm", "storage.mkdir", "storage.writeEncrypted"];

const ALERTS = {
  reasoning: "Tells you when a digest is ready.",
  kinds: [{
    id: "digest", label: { en: "Morning digest" }, defaultEnabled: true, visibility: "summary-only",
    slots: { topics: { kind: "list", maxItems: 5, maxLength: 120 } },
    summary: { en: "Today: {topics}" }, prompt: { en: "Summarise these topics for me: {topics}" },
  }],
  suggestions: ["overlay:sample-routine"],
};

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id: "sample", name: "Sample", version: "1.0.0", entry: "plugin.mjs", description: "sample", tools: [], ...extra } as PluginManifest;
}

const declaring = (extra: Partial<PluginManifest> = {}) => manifest({
  networkAccess: { allowedDomains: ["api.example.test"] },
  alerts: ALERTS,
  ...extra,
} as Partial<PluginManifest>);

function origin(extra: Partial<PluginRegistryEntryOrigin> = {}): PluginRegistryEntryOrigin {
  return {
    sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/sample",
    version: "1.0.0", rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z", ...extra,
  };
}

const marketplaceEntry = (extra: Partial<PluginRegistryEntryOrigin> = {}): PluginRegistryTrust => ({ installSource: "user", origin: origin(extra) });

const roots: string[] = [];
afterEach(() => {
  atomicWrites.fail = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function approvalsFile(): string {
  const root = mkdtempSync(join(tmpdir(), "background-effects-"));
  roots.push(root);
  return join(root, "plugin-contribution-trust", "background-effects.json");
}

describe("the background scope a manifest declares", () => {
  it("is empty, with no gated path, when the manifest declares nothing beyond its own storage", () => {
    expect(declaredBackgroundEffects(manifest())).toEqual({
      ownStorage: true, networkDestinations: [], alertKinds: [], suggestionSources: [], llm: false, workers: false,
    });
    expect(backgroundEffectSubject(manifest(), marketplaceEntry()).declared).toBe(false);
    expect([...backgroundEffectPaths(manifest())]).toEqual([]);
  });

  it("adds each declared destination, alert kind and suggestion source", () => {
    expect(declaredBackgroundEffects(declaring())).toEqual({
      ownStorage: true,
      networkDestinations: ["api.example.test"],
      alertKinds: ["digest"],
      suggestionSources: ["overlay:sample-routine"],
      llm: false,
      workers: false,
    });
    expect([...backgroundEffectPaths(declaring())].sort()).toEqual(["hostFetch", "raiseAlert", "triggerConversation"]);
  });

  it("names only real gated paths, so every other gated path is denied outside a tool call", () => {
    for (const path of STORAGE_WRITES) expect(GATED_EFFECT_PATHS.has(path)).toBe(true);
    for (const path of ["raiseAlert", "triggerConversation", "callLlm", "spawnWorker"]) expect(GATED_EFFECT_PATHS.has(path)).toBe(true);
    const denied = [...GATED_EFFECT_PATHS].filter((path) => !STORAGE_WRITES.includes(path)
      && !["raiseAlert", "triggerConversation", "callLlm", "spawnWorker"].includes(path));
    expect(denied).toEqual(expect.arrayContaining(["config.set", "openExternalUrl", "openAuthWindow", "authDeviceCode.authorize"]));
  });
});

describe("background model and helper-process declarations", () => {
  it("come only from the background capabilities and make a card on their own", () => {
    expect(declaredBackgroundEffects(manifest({ capabilities: ["external-auth-consumer"] }))).toMatchObject({ llm: false, workers: false });
    const llm = declaredBackgroundEffects(manifest({ capabilities: ["background:call-llm"] }));
    expect(llm).toMatchObject({ llm: true, workers: false });
    expect(backgroundEffectSubject(manifest({ capabilities: ["background:call-llm"] }), marketplaceEntry()).declared).toBe(true);
    expect([...backgroundEffectPaths(manifest({ capabilities: ["background:spawn-worker"] }))]).toContain("spawnWorker");
    expect(withinBackgroundScope(llm, "callLlm", undefined)).toBe(true);
    expect(withinBackgroundScope(llm, "spawnWorker", undefined)).toBe(false);
  });

  it("re-ask when declared, dropped or swapped", () => {
    const hash = (capabilities: string[]) => backgroundEffectScopeSha256(declaredBackgroundEffects(declaring({ capabilities })));
    const none = hash([]);
    expect(hash(["background:call-llm"])).not.toBe(none);
    expect(hash(["background:spawn-worker"])).not.toBe(hash(["background:call-llm"]));
    expect(hash(["background:spawn-worker", "background:call-llm"])).toBe(hash(["background:call-llm", "background:spawn-worker"]));
    expect(hash(["external-auth-consumer"])).toBe(none);
  });
});

describe("the scope hash", () => {
  it("ignores the version, unrelated manifest fields, order, case and duplicates", () => {
    const base = backgroundEffectSubject(declaring(), marketplaceEntry()).scopeSha256;
    const bumped = declaring({ version: "2.0.0", description: "new text", tools: [{ name: "extra", description: "x" }] } as Partial<PluginManifest>);
    expect(backgroundEffectSubject(bumped, marketplaceEntry()).scopeSha256).toBe(base);
    const reordered = declaring({ networkAccess: { allowedDomains: ["API.Example.test", "api.example.test"] } } as Partial<PluginManifest>);
    expect(backgroundEffectSubject(reordered, marketplaceEntry()).scopeSha256).toBe(base);
  });

  it.each([
    ["a new destination", { networkAccess: { allowedDomains: ["api.example.test", "upload.example.test"] } }],
    ["a dropped destination", { networkAccess: undefined }],
    ["another alert kind", { alerts: { ...ALERTS, kinds: [...ALERTS.kinds, { ...ALERTS.kinds[0], id: "weekly" }] } }],
    ["another suggestion source", { alerts: { ...ALERTS, suggestions: [...ALERTS.suggestions, "overlay:other"] } }],
  ])("changes with %s", (_label, change) => {
    const base = backgroundEffectSubject(declaring(), marketplaceEntry()).scopeSha256;
    expect(backgroundEffectSubject(declaring(change as Partial<PluginManifest>), marketplaceEntry()).scopeSha256).not.toBe(base);
  });

  it("covers the model and helper-process declarations", () => {
    const effects = declaredBackgroundEffects(declaring());
    const base = backgroundEffectScopeSha256(effects);
    expect(backgroundEffectScopeSha256({ ...effects, llm: true })).not.toBe(base);
    expect(backgroundEffectScopeSha256({ ...effects, workers: true })).not.toBe(base);
  });

  it("is the same for a cloned manifest, so the review and the gate agree", () => {
    const parsed = declaring();
    const clone = JSON.parse(JSON.stringify(parsed)) as PluginManifest;
    expect(backgroundEffectSubject(clone, marketplaceEntry())).toEqual(backgroundEffectSubject(parsed, marketplaceEntry()));
  });
});

describe("the install source an approval binds to", () => {
  it("keeps the source across commits and versions of one package", () => {
    const first = backgroundEffectSubject(declaring(), marketplaceEntry()).source;
    expect(backgroundEffectSubject(declaring(), marketplaceEntry({ commit: "c".repeat(40), version: "2.0.0", artifactSha256: "d".repeat(64) })).source).toBe(first);
  });

  it("differs for another source, another package path, a dev install and a missing pin", () => {
    const first = backgroundEffectSubject(declaring(), marketplaceEntry()).source;
    expect(backgroundEffectSubject(declaring(), marketplaceEntry({ sourceId: "other-source" })).source).not.toBe(first);
    expect(backgroundEffectSubject(declaring(), marketplaceEntry({ sourceOrigin: "official" })).source).not.toBe(first);
    expect(backgroundEffectSubject(declaring(), marketplaceEntry({ packagePath: "plugins/fork" })).source).not.toBe(first);
    const dev = backgroundEffectSubject(declaring(), { installSource: "local-dev", manifestSha256: "e".repeat(64) }).source;
    expect(dev).not.toBeNull();
    expect(dev).not.toBe(first);
    expect(backgroundEffectSubject(declaring(), { installSource: "local-dev", manifestSha256: "f".repeat(64) }).source).not.toBe(dev);
    expect(backgroundEffectSubject(declaring(), { installSource: "local-dev" }).source).toBeNull();
    expect(backgroundEffectSubject(declaring(), { installSource: "user" }).source).toBeNull();
    expect(backgroundEffectSubject(declaring(), undefined).source).toBeNull();
  });
});

describe("standalone targets inside the declared scope", () => {
  const effects = declaredBackgroundEffects(declaring({
    networkAccess: { allowedDomains: ["api.example.test", "127.0.0.1", "::1"] },
  } as Partial<PluginManifest>));

  it("admits declared destinations, kinds and sources only", () => {
    expect(withinBackgroundScope(effects, "hostFetch", "https://api.example.test")).toBe(true);
    expect(withinBackgroundScope(effects, "hostFetch", "https://eu.api.example.test")).toBe(true);
    expect(withinBackgroundScope(effects, "hostFetch", "http://127.0.0.1:8080")).toBe(true);
    expect(withinBackgroundScope(effects, "hostFetch", "http://[::1]:8080")).toBe(true);
    expect(withinBackgroundScope(effects, "hostFetch", "https://api.example.test.attacker.test")).toBe(false);
    expect(withinBackgroundScope(effects, "hostFetch", "https://undeclared.test")).toBe(false);
    expect(withinBackgroundScope(effects, "hostFetch", undefined)).toBe(false);
    expect(withinBackgroundScope(effects, "raiseAlert", "digest")).toBe(true);
    expect(withinBackgroundScope(effects, "raiseAlert", "other")).toBe(false);
    expect(withinBackgroundScope(effects, "triggerConversation", "overlay:sample-routine")).toBe(true);
    expect(withinBackgroundScope(effects, "triggerConversation", "overlay:other")).toBe(false);
    expect(withinBackgroundScope(effects, "storage.write", "notes/a.txt")).toBe(false);
    expect(withinBackgroundScope(effects, "callLlm", undefined)).toBe(false);
    expect(withinBackgroundScope(effects, "spawnWorker", "worker")).toBe(false);
    expect(withinBackgroundScope(effects, "config.set", "key")).toBe(false);
  });

  it("admits nothing for an empty scope", () => {
    expect(withinBackgroundScope(declaredBackgroundEffects(manifest()), "storage.write", "a.txt")).toBe(false);
  });
});

describe("background effect approvals", () => {
  it("bind the plugin, its install source and its scope hash", () => {
    const approvals = new PluginBackgroundEffectApprovals();
    const subject = backgroundEffectSubject(declaring(), marketplaceEntry());
    expect(approvals.isApproved(subject)).toBe(false);
    approvals.approve(subject);
    expect(approvals.isApproved(subject)).toBe(true);
    expect(approvals.isApproved(backgroundEffectSubject(declaring({ version: "9.9.9" }), marketplaceEntry({ version: "9.9.9" })))).toBe(true);
    expect(approvals.isApproved(backgroundEffectSubject(declaring(), marketplaceEntry({ sourceId: "other-source" })))).toBe(false);
    expect(approvals.isApproved(backgroundEffectSubject(declaring({ networkAccess: { allowedDomains: ["upload.example.test"] } } as Partial<PluginManifest>), marketplaceEntry()))).toBe(false);
    expect(approvals.isApproved(backgroundEffectSubject({ ...declaring(), id: "other" }, marketplaceEntry()))).toBe(false);
  });

  it("refuse an empty scope or an unpinned source", () => {
    const approvals = new PluginBackgroundEffectApprovals();
    expect(() => approvals.approve(backgroundEffectSubject(manifest(), marketplaceEntry()))).toThrow();
    expect(() => approvals.approve(backgroundEffectSubject(declaring(), undefined))).toThrow();
  });

  it("are dropped by revoke and stay dropped after a reload", () => {
    const path = approvalsFile();
    const subject = backgroundEffectSubject(declaring(), marketplaceEntry());
    const approvals = new PluginBackgroundEffectApprovals(path);
    approvals.approve(subject);
    approvals.revoke(subject.pluginId);
    expect(approvals.isApproved(subject)).toBe(false);
    expect(new PluginBackgroundEffectApprovals(path).isApproved(subject)).toBe(false);
    expect(() => approvals.revoke("never-approved")).not.toThrow();
  });

  it("drop a removal whose write failed at the next save, or at boot once the registry no longer names the plugin", () => {
    const path = approvalsFile();
    const removed = backgroundEffectSubject(declaring(), marketplaceEntry());
    const kept = backgroundEffectSubject(declaring({ id: "kept" }), marketplaceEntry({ packagePath: "plugins/kept" }));
    const approvals = new PluginBackgroundEffectApprovals(path);
    approvals.approve(removed);
    approvals.approve(kept);
    atomicWrites.fail = true;
    approvals.revoke(removed.pluginId);
    atomicWrites.fail = false;
    expect(approvals.isApproved(removed)).toBe(false);
    const restarted = new PluginBackgroundEffectApprovals(path);
    expect(restarted.isApproved(removed)).toBe(true);
    restarted.retain(new Set(["kept"]));
    expect(restarted.isApproved(removed)).toBe(false);
    for (const fresh of [restarted, new PluginBackgroundEffectApprovals(path)]) {
      expect(fresh.isApproved(removed)).toBe(false);
      expect(fresh.isApproved(kept)).toBe(true);
    }

    const retried = approvalsFile();
    const session = new PluginBackgroundEffectApprovals(retried);
    session.approve(removed);
    atomicWrites.fail = true;
    session.revoke(removed.pluginId);
    atomicWrites.fail = false;
    session.approve(kept);
    expect(new PluginBackgroundEffectApprovals(retried).isApproved(removed)).toBe(false);

    const reinstalled = approvalsFile();
    const before = new PluginBackgroundEffectApprovals(reinstalled);
    before.approve(removed);
    atomicWrites.fail = true;
    before.revoke(removed.pluginId);
    atomicWrites.fail = false;
    before.bindSubject(removed.pluginId, async () => removed);
    expect(new PluginBackgroundEffectApprovals(reinstalled).isApproved(removed)).toBe(false);
  });

  it("keep every approval the registry still names, and survive a failed prune", () => {
    const path = approvalsFile();
    const subject = backgroundEffectSubject(declaring(), marketplaceEntry());
    const approvals = new PluginBackgroundEffectApprovals(path);
    approvals.approve(subject);
    approvals.retain(new Set(["sample"]));
    expect(new PluginBackgroundEffectApprovals(path).isApproved(subject)).toBe(true);
    atomicWrites.fail = true;
    expect(() => approvals.retain(new Set())).not.toThrow();
    expect(approvals.isApproved(subject)).toBe(false);
  });

  it("persist across loads and approve nothing from a malformed file", () => {
    const path = approvalsFile();
    const subject = backgroundEffectSubject(declaring(), marketplaceEntry());
    new PluginBackgroundEffectApprovals(path).approve(subject);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 2, approvals: [{ pluginId: "sample", source: subject.source, scopeSha256: subject.scopeSha256 }],
    });
    expect(new PluginBackgroundEffectApprovals(path).isApproved(subject)).toBe(true);
    for (const body of ["{", JSON.stringify({ version: 1, approvals: [] }), JSON.stringify({ version: 2, approvals: [{ pluginId: "sample", source: subject.source, scopeSha256: "x" }] })]) {
      writeFileSync(path, body);
      expect(new PluginBackgroundEffectApprovals(path).isApproved(subject)).toBe(false);
    }
  });
});

describe("the subject a running plugin binds for its review", () => {
  it("answers with the newest live binding and falls back as bindings go", async () => {
    const approvals = new PluginBackgroundEffectApprovals();
    const older = backgroundEffectSubject(declaring(), marketplaceEntry());
    const newer = backgroundEffectSubject(declaring({ networkAccess: { allowedDomains: ["upload.example.test"] } } as Partial<PluginManifest>), marketplaceEntry());
    const unbindOlder = approvals.bindSubject("sample", async () => older);
    const unbindNewer = approvals.bindSubject("sample", async () => newer);
    expect(await approvals.currentSubject("sample")).toBe(newer);
    unbindNewer();
    unbindNewer();
    expect(await approvals.currentSubject("sample")).toBe(older);
    unbindOlder();
    expect(await approvals.currentSubject("sample")).toBeNull();
  });
});

describe("an unreadable approvals file", () => {
  it.each(["null", "[]", "7", "\"x\"", "{\"version\":2,\"approvals\":null}", "{\"version\":2,\"approvals\":[null]}"])(
    "boots with nothing approved for %s",
    (body) => {
      const path = approvalsFile();
      const subject = backgroundEffectSubject(declaring(), marketplaceEntry());
      new PluginBackgroundEffectApprovals(path).approve(subject);
      writeFileSync(path, body);
      let approvals: PluginBackgroundEffectApprovals | undefined;
      expect(() => { approvals = new PluginBackgroundEffectApprovals(path); }).not.toThrow();
      expect(approvals?.isApproved(subject)).toBe(false);
    },
  );
});
