import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../settings-store.js";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
let migrations: string[];
const load = () => new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "settings-documents-"));
  const settings = load();
  await settings.patch({});
  migrations = settings.getAll().appliedMigrations!;
});
afterEach(async () => { await cleanupTmpDir(directory); });

describe("document opening settings", () => {
  it("defaults fresh and legacy settings to direct opening", async () => {
    expect(DEFAULT_SETTINGS).toHaveProperty("documents.openMode", "direct");
    expect(load().getAll()).toHaveProperty("documents.openMode", "direct");
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, chat: { autoCompact: false } }));
    const legacy = load();
    await legacy.patch({});
    const migrated = legacy.getAll();
    expect(migrated).toHaveProperty("documents.openMode", "direct");
    expect(migrated.chat.autoCompact).toBe(false);
  });

  it.each(["direct", "link"] as const)("persists the user's %s choice", async (openMode) => {
    const settings = load();
    await settings.patch({ documents: { openMode } });
    expect(load().getAll()).toHaveProperty("documents.openMode", openMode);
    expect(JSON.parse(readFileSync(join(directory, "ave-settings.json"), "utf8")))
      .toHaveProperty("documents.openMode", openMode);
  });

  it.each([null, [], "link", { openMode: "other" }, { openMode: true }].map((documents) => ({ documents })))("normalizes malformed stored settings $documents", async ({ documents }) => {
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, documents }));
    const settings = load();
    await settings.patch({});
    expect(settings.getAll()).toHaveProperty("documents.openMode", "direct");
  });

  it.each([null, [], "direct", { openMode: "other" }, { openMode: false }].map((documents) => ({ documents })))("rejects malformed patches $documents without resetting the user choice", async ({ documents }) => {
    const settings = load();
    await settings.patch({ documents: { openMode: "link" } });
    await settings.patch({ documents } as never);
    expect(load().getAll()).toHaveProperty("documents.openMode", "link");
  });
});

// Shares the fixture above: one settings file per test, migrations already applied.
describe("work board tool-approval surface setting", () => {
  it("defaults fresh and legacy settings to the run's chat", async () => {
    expect(DEFAULT_SETTINGS).toHaveProperty("workBoard.toolApprovalSurface", "chat");
    expect(load().getAll()).toHaveProperty("workBoard.toolApprovalSurface", "chat");
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, chat: { autoCompact: false } }));
    const legacy = load();
    await legacy.patch({});
    const migrated = legacy.getAll();
    expect(migrated).toHaveProperty("workBoard.toolApprovalSurface", "chat");
    expect(migrated.chat.autoCompact).toBe(false);
  });

  it.each(["chat", "dialog"] as const)("persists the user's %s choice", async (toolApprovalSurface) => {
    const settings = load();
    await settings.patch({ workBoard: { toolApprovalSurface } });
    expect(load().getAll()).toHaveProperty("workBoard.toolApprovalSurface", toolApprovalSurface);
    expect(JSON.parse(readFileSync(join(directory, "ave-settings.json"), "utf8")))
      .toHaveProperty("workBoard.toolApprovalSurface", toolApprovalSurface);
  });

  it.each([null, [], "dialog", { toolApprovalSurface: "other" }, { toolApprovalSurface: true }].map((workBoard) => ({ workBoard })))("normalizes malformed stored settings $workBoard", async ({ workBoard }) => {
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, workBoard }));
    const settings = load();
    await settings.patch({});
    expect(settings.getAll()).toHaveProperty("workBoard.toolApprovalSurface", "chat");
  });

  it.each([null, [], "chat", { toolApprovalSurface: "other" }, { toolApprovalSurface: false }].map((workBoard) => ({ workBoard })))("rejects malformed patches $workBoard without resetting the user choice", async ({ workBoard }) => {
    const settings = load();
    await settings.patch({ workBoard: { toolApprovalSurface: "dialog" } });
    await settings.patch({ workBoard } as never);
    expect(load().getAll()).toHaveProperty("workBoard.toolApprovalSurface", "dialog");
  });
});

describe("app zoom persistence", () => {
 it("persists a zoom patch, notifies appearance observers, and keeps sibling fields", async () => {
  const settings = load();
  const observed: number[] = [];
  settings.onChanged("appearance", () => observed.push(settings.get("appearance").zoomLevel ?? 0));
  await settings.patch({ appearance: { zoomLevel: -4, font: { family: "Example Sans" } } });
  expect(observed).toEqual([-4]);
  expect(load().get("appearance")).toMatchObject({ zoomLevel: -4, font: { family: "Example Sans" } });
  await settings.patch({ appearance: { zoomLevel: 8.5 } });
  expect(load().get("appearance")).toMatchObject({ zoomLevel: 0, font: { family: "Example Sans" } });
 });
});
