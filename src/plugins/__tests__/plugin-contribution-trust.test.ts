import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginContributionTrustStore } from "../plugin-contribution-trust.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginContributionTrustStore", () => {
  const approved = {
    pluginId: "sampleportal",
    pluginVersion: "1.0.0",
    generationId: "1".repeat(64),
    localId: "checkin_policy",
    fingerprint: "a".repeat(64),
  };

  it("restores only the exact owner/version/generation/local-id/fingerprint tuple", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-contribution-trust-"));
    roots.push(root);
    const path = join(root, "hooks.json");
    new PluginContributionTrustStore("hook", path).approve(approved, "c".repeat(64));

    const restored = new PluginContributionTrustStore("hook", path);
    expect(restored.isApproved(approved)).toBe(true);
    expect(restored.isApproved({ ...approved, pluginVersion: "2.0.0" })).toBe(false);
    expect(restored.isApproved({ ...approved, generationId: "2".repeat(64) })).toBe(false);
    expect(restored.isApproved({ ...approved, fingerprint: "b".repeat(64) })).toBe(false);
  });

  it("does not expose an approval in memory when durable persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-contribution-trust-fail-"));
    roots.push(root);
    const trustDir = join(root, "trust");
    mkdirSync(trustDir);
    const store = new PluginContributionTrustStore("hook", join(trustDir, "hooks.json"));
    rmSync(trustDir, { recursive: true });
    writeFileSync(trustDir, "not-a-directory");

    expect(() => store.approve(approved, "c".repeat(64))).toThrow();
    expect(store.isApproved(approved)).toBe(false);
  });

  it("does not revoke an in-memory approval when durable persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-contribution-trust-revoke-fail-"));
    roots.push(root);
    const trustDir = join(root, "trust");
    mkdirSync(trustDir);
    const store = new PluginContributionTrustStore("hook", join(trustDir, "hooks.json"));
    store.approve(approved, "c".repeat(64));
    rmSync(trustDir, { recursive: true });
    writeFileSync(trustDir, "not-a-directory");

    expect(() => store.revoke(approved)).toThrow();
    expect(store.isApproved(approved)).toBe(true);
  });

  function trustFile(body: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "ave-contribution-trust-version-"));
    roots.push(root);
    const path = join(root, "hooks.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  it("loads a version-2 file with no approval digests and fills one only for the exact identity", () => {
    const path = trustFile({ version: 2, kind: "hook", approvals: [approved] });
    const store = new PluginContributionTrustStore("hook", path);
    expect(store.record(approved)).toEqual({ ...approved, approvalDigest: null });
    store.recordDigest({ ...approved, generationId: "2".repeat(64) }, "d".repeat(64));
    expect(store.record(approved)?.approvalDigest).toBeNull();
    store.recordDigest(approved, null);
    expect(store.record(approved)?.approvalDigest).toBeNull();
    store.recordDigest(approved, "d".repeat(64));
    // A digest once recorded is never replaced.
    store.recordDigest(approved, "e".repeat(64));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 3, kind: "hook", approvals: [{ ...approved, approvalDigest: "d".repeat(64) }] });
  });

  it("round-trips version 3 with its carried source, and refuses malformed records", () => {
    const path = trustFile({ version: 3, kind: "hook", approvals: [] });
    new PluginContributionTrustStore("hook", path).approve(approved, "c".repeat(64), "9".repeat(64));
    expect(new PluginContributionTrustStore("hook", path).record(approved)).toEqual({ ...approved, approvalDigest: "c".repeat(64), carriedFrom: "9".repeat(64) });

    for (const body of [
      { version: 2, kind: "hook", approvals: [{ ...approved, approvalDigest: null }] },
      { version: 3, kind: "hook", approvals: [approved] },
      { version: 3, kind: "hook", approvals: [{ ...approved, approvalDigest: "not-a-digest" }] },
      { version: 3, kind: "hook", approvals: [{ ...approved, approvalDigest: null, carriedFrom: "x" }] },
      { version: 3, kind: "mcpServer", approvals: [] },
      { version: 4, kind: "hook", approvals: [] },
    ]) {
      expect(() => new PluginContributionTrustStore("hook", trustFile(body))).toThrow(/invalid hook plugin contribution trust/u);
    }
  });
});
