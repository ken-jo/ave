/** Only manifest-validation failures are reinstall-fixable; version, protocol, provenance and revocation refusals are not. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";
import { revocationRegistry } from "../revocation/revocation-registry.js";
import { isReinstallFixableFailureKind } from "../../shared/plugin-install-failure.js";

/** A `_meta` vendor prefix the host does not own; the manifest schema refuses it on a tool. */
const UNKNOWN_META_PREFIX = "xyz.example/";

async function writeProcessEntry(fixture: TestPluginRuntimeFixture): Promise<string> {
  const { manifestPath } = await writeTestPlugin(fixture, { id: "process-kit", tools: [] });
  await mkdir(join(dirname(manifestPath), "bin"), { recursive: true });
  await writeFile(join(dirname(manifestPath), "bin", "plugin"), "#!/bin/sh\n", "utf8");
  await writeFile(manifestPath, JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "process-kit", version: "1.0.0", description: "Process extension",
    extensions: { "ai.agent-connector.ave": {
      process: { command: "./bin/plugin" },
      requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
      tools: [],
    } },
  }), "utf8");
  await writeTestPluginRegistry(fixture, [{ id: "process-kit", manifestPath, enabled: true }]);
  return manifestPath;
}

describe("PluginRuntime Doctor load-failure classification", () => {
  let fixture: TestPluginRuntimeFixture;

  afterEach(async () => {
    revocationRegistry.resetForTesting();
    if (fixture) await rm(fixture.rootDir, { recursive: true, force: true });
  });

  // Without a receipt cache root, admission has no provenance evidence.
  it("keeps an unpinned process extension failed at boot with a stable Doctor diagnosis", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    await writeProcessEntry(fixture);
    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();
    const card = runtime.listPluginCards().find((candidate) => candidate.id === "process-kit");
    expect(card).toMatchObject({ loadStatus: "failed", installFailureKind: "process-entry-requires-pinned-artifact" });
    expect(card?.installFailureMessage).toContain("pinned by its sha256 hash");
    expect(card?.installFailureMessage).toContain("Install it from a marketplace that pins its release");
    expect(isReinstallFixableFailureKind(card?.installFailureKind)).toBe(false);
    expect(isReinstallFixableFailureKind("process-entry-unconfined")).toBe(false);
  });

  it("refuses an added unpinned process extension before it starts", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    await writeProcessEntry(fixture);
    const runtime = makeTestPluginRuntime(fixture);
    await expect(runtime.addPlugin("process-kit")).rejects.toThrow(/requires an install pinned by a release or archive artifact/);
    expect(runtime.listPluginCards().find((candidate) => candidate.id === "process-kit"))
      .toMatchObject({ installFailureKind: "process-entry-requires-pinned-artifact" });
    expect(runtime.listPluginIds()).not.toContain("process-kit");
  });

  it("classifies a schema-invalid (pre-v6) on-disk manifest as reinstall-fixable", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-prev6",
      tools: ["p_prev6_ping"],
      entrySource: makeTestPluginEntrySource({ p_prev6_ping: JSON.stringify("hi") }),
      // Unknown top-level fields must fail the current host schema.
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

  it("classifies an installed unknown-vendor pathFields `_meta` manifest as reinstall-fixable (fail-closed → Doctor-repairable)", async () => {
    // Unknown _meta vendor keys must fail closed and classify as reinstall-fixable manifest-validation-error.
    fixture = await makeTestPluginRuntimeFixture();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-unknown-meta",
      tools: [],
      entrySource: makeTestPluginEntrySource({ p_unknown_ping: JSON.stringify("hi") }),
      manifest: {
        tools: [
          {
            name: "p_unknown_ping",
            description: "Unknown-vendor _meta path tool.",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            // Force an unknown vendor key onto the typed fixture to exercise on-disk validation.
            _meta: { ui: { visibility: ["model"] }, [`${UNKNOWN_META_PREFIX}pathFields`]: ["path"] } as never,
          },
        ],
      },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-unknown-meta", manifestPath, enabled: true }]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-unknown-meta");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("manifest-validation-error");
    expect(card?.installFailureMessage).toMatch(/schema validation failed/);
    expect(card?.installFailureMessage).toContain(`${UNKNOWN_META_PREFIX}pathFields`);
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

  it("refuses old and undeclared host protocols before plugin code runs", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    const refused = await writeTestPlugin(fixture, {
      id: "p-protocol",
      tools: ["p_protocol_ping"],
      // A throwing entry proves the refusal runs before code import.
      entrySource: "throw new Error('the entry of a refused plugin was imported');\n",
      manifest: { requires: { capabilities: [], hostProtocol: "2" } },
    });
    const undeclared = await writeTestPlugin(fixture, {
      id: "p-protocol-undeclared",
      tools: ["p_protocol_undeclared_ping"],
      entrySource: "throw new Error('the entry of an undeclared plugin was imported');\n",
      manifest: { requires: { capabilities: [], hostProtocol: undefined } },
    });
    const served = await writeTestPlugin(fixture, {
      id: "p-protocol-served",
      tools: ["p_protocol_served_ping"],
      entrySource: makeTestPluginEntrySource({ p_protocol_served_ping: JSON.stringify("hi") }),
      manifest: { requires: { capabilities: [], hostProtocol: "4" } },
    });
    await writeTestPluginRegistry(fixture, [
      { id: "p-protocol", manifestPath: refused.manifestPath, enabled: true },
      { id: "p-protocol-undeclared", manifestPath: undeclared.manifestPath, enabled: true },
      { id: "p-protocol-served", manifestPath: served.manifestPath, enabled: true },
    ]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-protocol");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("incompatible-host-protocol");
    expect(card?.installFailureMessage).toMatch(/speaks host protocol 2; this app serves 3, 4/);
    const missing = runtime.listPluginCards().find((candidate) => candidate.id === "p-protocol-undeclared");
    expect(missing?.installFailureKind).toBe("incompatible-host-protocol");
    expect(missing?.installFailureMessage).toMatch(/does not declare a host protocol; this app serves 3, 4/);
    const kept = runtime.listPluginCards().find((candidate) => candidate.id === "p-protocol-served");
    expect(kept?.loadStatus).not.toBe("failed");
  });

  it("refuses an undeclared protocol on the targeted add path before activation", async () => {
    fixture = await makeTestPluginRuntimeFixture();
    await writeTestPluginRegistry(fixture, []);
    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "p-late-protocol",
      tools: ["p_late_protocol_ping"],
      entrySource: "throw new Error('the targeted entry was imported');\n",
      manifest: { requires: { hostProtocol: undefined } },
    });
    await writeTestPluginRegistry(fixture, [{ id: "p-late-protocol", manifestPath, enabled: true }]);

    await expect(runtime.addPlugin("p-late-protocol")).rejects.toThrow(/does not declare a host protocol/);
    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-late-protocol");
    expect(card?.loadStatus).toBe("failed");
    expect(card?.installFailureKind).toBe("incompatible-host-protocol");
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
