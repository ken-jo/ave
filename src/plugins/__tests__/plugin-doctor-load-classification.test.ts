/**
 * Plugin Doctor — runtime load-failure classification on plugin cards.
 *
 * The Doctor auto-repairs a plugin that failed to LOAD by reinstalling the
 * latest marketplace version, but only when the cause is reinstall-fixable.
 * These tests pin the classification the settings UI reads off `listPluginCards`:
 *   - a stale/pre-v6/schema-invalid on-disk manifest → `manifest-validation-error`
 *     (reinstall-fixable) plus the underlying field detail, and
 *   - a too-new `requires.minAppVersion` → `incompatible-app-version`
 *     (NOT reinstall-fixable — a reinstall re-fetches the same too-new package).
 *   - a `requires.hostProtocol` this app does not serve → `incompatible-host-protocol`
 *     (NOT reinstall-fixable, and refused before the plugin's code runs).
 *   - a version its bound source revoked → `plugin-revoked` with that source's
 *     reason (design §10.4); other plugins still load.
 */
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";
import { revocationRegistry } from "../revocation/revocation-registry.js";

describe("PluginRuntime Doctor load-failure classification", () => {
  let fixture: TestPluginRuntimeFixture;

  afterEach(async () => {
    revocationRegistry.resetForTesting();
    if (fixture) await rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("classifies a schema-invalid (pre-v6) on-disk manifest as reinstall-fixable", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-prev6",
      tools: ["p_prev6_ping"],
      entrySource: makeTestPluginEntrySource({ p_prev6_ping: JSON.stringify("hi") }),
      // Unknown top-level property rejected by the current host schema — this is
      // the shape a manifest shipped before #885 Phase R now fails validation on.
      manifest: { startupTools: [] },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-prev6", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-prev6");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("manifest-validation-error");
    expect(card?.installFailureMessage).toMatch(/schema validation failed/);
  });

  it("classifies an installed legacy-`_meta` (xyz.ave/pathFields) manifest as reinstall-fixable (fail-closed → Doctor-repairable)", async () => {
    // The load-bearing safety-net test for the `_meta` vendor-namespace rename.
    // An installed plugin whose on-disk manifest still carries the removed legacy
    // key `xyz.ave/pathFields` must FAIL to load (fail-closed — the schema's
    // `_meta` is additionalProperties:false, so the key is rejected, never silently
    // accepted-but-ungated), and that failure must classify as the reinstall-fixable
    // `manifest-validation-error` kind so the Plugin Doctor auto-repairs it by
    // reinstalling the migrated marketplace version. This is the terminal (tier-3)
    // rung when auto-migration cannot run (plugin absent from / unreachable on the
    // marketplace): a broken-until-repaired plugin, never a silently-ungated one.
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-legacy-meta",
      tools: [],
      entrySource: makeTestPluginEntrySource({ p_legacy_ping: JSON.stringify("hi") }),
      manifest: {
        tools: [
          {
            name: "p_legacy_ping",
            description: "Legacy _meta path tool.",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            // Cast: the legacy key is no longer part of the `_meta` type; it is
            // forced on to reproduce a pre-rename installed manifest on disk.
            _meta: { ui: { visibility: ["model"] }, "xyz.ave/pathFields": ["path"] } as never,
          },
        ],
      },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-legacy-meta", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-legacy-meta");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("manifest-validation-error");
    expect(card?.installFailureMessage).toMatch(/schema validation failed/);
    // The rejection is specifically about the removed legacy key.
    expect(card?.installFailureMessage).toContain("xyz.ave/pathFields");
  });

  it("classifies a too-new minAppVersion as NOT reinstall-fixable", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-appver",
      tools: ["p_appver_ping"],
      entrySource: makeTestPluginEntrySource({ p_appver_ping: JSON.stringify("hi") }),
      manifest: { requires: { capabilities: [], minAppVersion: "999.0.0" } },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-appver", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-appver");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("incompatible-app-version");
  });

  it("refuses a host protocol version this app does not serve, before the plugin's code runs", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const refused = await writeTestPlugin(fixture, {
      id: "p-protocol",
      tools: ["p_protocol_ping"],
      // Importing this entry throws, so a gate that ran after the import would
      // report a load crash instead of the refusal.
      entrySource: "throw new Error('the entry of a refused plugin was imported');\n",
      manifest: { requires: { capabilities: [], hostProtocol: "2" } },
    });
    const served = await writeTestPlugin(fixture, {
      id: "p-protocol-served",
      tools: ["p_protocol_served_ping"],
      entrySource: makeTestPluginEntrySource({ p_protocol_served_ping: JSON.stringify("hi") }),
      manifest: { requires: { capabilities: [], hostProtocol: "1" } },
    });
    await writeTestPluginRegistry(fixture, [
      { id: "p-protocol", manifestPath: refused.manifestPath, enabled: true },
      { id: "p-protocol-served", manifestPath: served.manifestPath, enabled: true },
    ]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-protocol");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("incompatible-host-protocol");
    expect(card?.installFailureMessage).toMatch(/speaks host protocol 2; this app serves 1/);
    const kept = runtime.listPluginCards().find((candidate) => candidate.id === "p-protocol-served");
    expect(kept?.loadStatus).not.toBe("failed");
  });

  it("refuses to load a version its bound source revoked, with the source's reason, and loads the rest", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const revoked = await writeTestPlugin(fixture, {
      id: "p-revoked",
      tools: ["p_revoked_ping"],
      entrySource: makeTestPluginEntrySource({ p_revoked_ping: JSON.stringify("hi") }),
    });
    const kept = await writeTestPlugin(fixture, {
      id: "p-kept",
      tools: ["p_kept_ping"],
      entrySource: makeTestPluginEntrySource({ p_kept_ping: JSON.stringify("hi") }),
    });
    await writeTestPluginRegistry(fixture, [
      { id: "p-revoked", manifestPath: revoked.manifestPath, enabled: true },
      { id: "p-kept", manifestPath: kept.manifestPath, enabled: true },
    ]);
    revocationRegistry.replace([
      { kind: "plugin", name: "p-revoked", versions: "*", reason: "leaks tokens", at: "2026-09-24T00:00:00Z", action: "disable", sourceId: "acme" },
    ]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-revoked");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("plugin-revoked");
    expect(card?.installFailureMessage).toBe("revoked by acme: leaks tokens");
    expect(runtime.listPluginCards().find((candidate) => candidate.id === "p-kept")?.loadStatus).not.toBe("failed");
  });
});
