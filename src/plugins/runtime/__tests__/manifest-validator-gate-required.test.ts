/**
 * Manifest loading must use the host-owned schema validator as its source of truth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() }),
}));
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";

describe("parsePluginJson — host schema validator required", () => {
  let testDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-manifest-validator-"));
    manifestPath = join(testDir, "plugin.json");
    await mkdir(testDir, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(agentPluginsDocument({
        id: "test-validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [{ name: "validator_ping", description: "validator_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Validator required test plugin",
      })),
      "utf-8");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("fails closed when the Host schema validator is absent", async () => {
    await expect(parsePluginJson(manifestPath, null as never)).rejects.toThrow(
      /Host plugin manifest validator is required/,
    );
  });

  it("parses a valid manifest with the Host schema validator", async () => {
    const validator = await buildManifestValidator();
    const manifest = await parsePluginJson(manifestPath, validator);
    expect(manifest.id).toBe("test-validator");
  });

  it("loads an installed manifest that still carries installPolicy and publisher, dropping them with one warning", async () => {
    // Every official plugin installed before the git marketplace has both (design §5.3).
    await writeFile(
      manifestPath,
      JSON.stringify(agentPluginsDocument({
        id: "test-legacy",
        name: "Legacy",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [{ name: "legacy_ping", description: "legacy_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Legacy plugin",
        installPolicy: "admin",
        publisher: "Ave Official",
      })),
      "utf-8");
    warn.mockClear();
    const validator = await buildManifestValidator();

    const manifest = await parsePluginJson(manifestPath, validator);
    await parsePluginJson(manifestPath, validator);

    expect(manifest.id).toBe("test-legacy");
    expect(manifest).not.toHaveProperty("installPolicy");
    expect(manifest).not.toHaveProperty("publisher");
    const retired = warn.mock.calls.filter(([message]) => String(message).includes("retired field"));
    expect(retired).toEqual([[expect.stringContaining("ignoring retired field(s) installPolicy, publisher")]]);
  });

  it("#885 v6 — a pure app-only Tool loads and carries no uiActions map", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify(agentPluginsDocument({
        id: "test-validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [
          {
            name: "ui_upload_chunk",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
        description: "Validator UI-only runtime method test plugin",
      })),
      "utf-8");

    const validator = await buildManifestValidator();
    const manifest = await parsePluginJson(manifestPath, validator);
    // Pure form: no uiActions map; the method is ONE Tool object with app-only visibility.
    expect((manifest as Record<string, unknown>).uiActions).toBeUndefined();
    const tool = manifest.tools.find((t) => t.name === "ui_upload_chunk");
    expect(tool?._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("#885 v6 — a pure app-only Tool with a description loads", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify(agentPluginsDocument({
        id: "test-validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [
          {
            name: "ui_upload_chunk",
            description: "Upload a staged chunk from the panel",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
        description: "Validator UI action runtime method test plugin",
      })),
      "utf-8");

    const validator = await buildManifestValidator();
    const manifest = await parsePluginJson(manifestPath, validator);
    const tool = manifest.tools.find((t) => t.name === "ui_upload_chunk");
    expect(tool).toBeDefined();
    expect(tool?._meta?.ui?.visibility).toEqual(["app"]);
  });

  it("#885 v6 — pure app-only auth tools pass the auth-visibility check", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify(agentPluginsDocument({
        id: "test-validator",
        name: "Validator Test",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [
          { name: "auth_status", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
          { name: "auth_login", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        ],
        auth: {
          statusTool: "auth_status",
          loginTool: "auth_login",
        },
        description: "Validator UI action auth test plugin",
      })),
      "utf-8");

    const validator = await buildManifestValidator();
    const manifest = await parsePluginJson(manifestPath, validator);
    expect(manifest.auth).toMatchObject({ statusTool: "auth_status", loginTool: "auth_login" });
    expect((manifest as Record<string, unknown>).uiActions).toBeUndefined();
    // auth tools resolve to EXACTLY ["app"] (host-managed, never model-callable —
    // the #1554 invariant, now enforced at the tool-object level).
    expect(manifest.tools.find((t) => t.name === "auth_status")?._meta?.ui?.visibility).toEqual(["app"]);
    expect(manifest.tools.find((t) => t.name === "auth_login")?._meta?.ui?.visibility).toEqual(["app"]);
  });
});
