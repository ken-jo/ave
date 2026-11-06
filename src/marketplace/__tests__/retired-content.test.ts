import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentLedger, contentLedgerOrigins } from "../content/ledger.js";
import { AppliedDefaults } from "../boot-installs/applied.js";
import { updateHistoryStore } from "../updates/history.js";
import { assertRetiredThemeConsent, parseConsentFingerprint } from "../updates/consent-record.js";
import { validateCachedSnapshotText, validateIndexText } from "../catalog/validate.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../log.js", () => ({ createMarketplaceLogger: () => log }));

const AT = "2026-09-23T00:00:00.000Z";
const INSTALL_ID = "00000000-0000-4000-8000-000000000001";
const COMMIT = "a".repeat(40);
// Released ledger/consent/history/default records retain their version-1 shapes.
const retiredConsent = { kind: "theme", fields: { minAppVersion: "0.12.0" }, unknown: [] };
const retiredEntry = {
  kind: "theme", name: "harbor-theme", version: "1.0.0",
  origin: { sourceId: "ave", sourceOrigin: "official", commit: COMMIT, packagePath: "themes/harbor-theme", version: "1.0.0",
    contentSha256: "b".repeat(64), installedAt: AT, installId: INSTALL_ID, payloadDir: `theme/harbor-theme/.installs/${INSTALL_ID}`, consent: retiredConsent },
};
const survivingEntries = ["language", "font", "skill", "agent", "agent-plugin"].map((kind) => ({
  kind, name: `harbor-${kind}`, version: "1.0.0", origin: { ...retiredEntry.origin, packagePath: `${kind}/harbor-${kind}`,
    payloadDir: `${kind}/harbor-${kind}/.installs/${INSTALL_ID}`, consent: { ...retiredConsent, kind } },
}));

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ave-retired-content-"))); vi.clearAllMocks(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

describe("retired installed content migration", () => {
  it("removes only released theme entries and payloads, preserving all other kinds and origin reads", async () => {
    const path = join(root, "packages", "ledger.json");
    const retired = join(dirname(path), retiredEntry.origin.payloadDir);
    const kept = join(dirname(path), survivingEntries[0]!.origin.payloadDir);
    mkdirSync(retired, { recursive: true });
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(retired, "theme.json"), "{}");
    writeFileSync(join(kept, "language.json"), "{}");
    write(path, { version: 1, packages: [retiredEntry, ...survivingEntries] });
    const ledger = await ContentLedger.open(path);
    expect(ledger.list()).toEqual(survivingEntries);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, packages: survivingEntries });
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(dirname(retired))).toBe(false);
    expect(existsSync(dirname(dirname(retired)))).toBe(false);
    expect(existsSync(join(kept, "language.json"))).toBe(true);
    expect(await contentLedgerOrigins(path)()).toHaveLength(survivingEntries.length);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesRemoved: 1, payloadsRemoved: 1 }, "Retired content migrated");
    expect(await ledger.remove("font", "harbor-font")).toBe(true);
    await ledger.put(survivingEntries[1] as Parameters<ContentLedger["put"]>[0]);
    await ContentLedger.open(path);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it.each(["widget", "plugin"])("rejects an additional %s ledger kind before rewriting or deleting anything", async (kind) => {
    const path = join(root, "packages", "ledger.json");
    const payload = join(dirname(path), retiredEntry.origin.payloadDir);
    mkdirSync(payload, { recursive: true });
    const original = write(path, { version: 1, packages: [retiredEntry, { ...survivingEntries[0], kind }] });
    await expect(ContentLedger.open(path)).rejects.toThrow("packages[1].kind is not a content kind");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(payload)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("validates retired consent before removal and never accepts it as current install authority", async () => {
    expect(() => assertRetiredThemeConsent(retiredConsent, "consent")).not.toThrow();
    expect(() => parseConsentFingerprint(retiredConsent, "consent")).toThrow("kind is not a package kind");
    expect(() => assertRetiredThemeConsent({ ...retiredConsent, kind: "widget" }, "consent")).toThrow("kind is not a package kind");
    const path = join(root, "packages", "ledger.json");
    const original = write(path, { version: 1, packages: [{ ...retiredEntry, origin: { ...retiredEntry.origin,
      consent: { ...retiredConsent, extra: true } } }, ...survivingEntries] });
    await expect(ContentLedger.open(path)).rejects.toThrow("consent has an unknown field");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("migrates retired content through a symlinked packages root", async () => {
    const storeRoot = join(root, "mounted-packages");
    const alias = join(root, "packages");
    mkdirSync(storeRoot);
    symlinkSync(storeRoot, alias, "dir");
    const path = join(alias, "ledger.json");
    const payload = join(storeRoot, retiredEntry.origin.payloadDir);
    const kept = join(storeRoot, survivingEntries[0]!.origin.payloadDir);
    mkdirSync(payload, { recursive: true });
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "keep"), "keep");
    write(path, { version: 1, packages: [retiredEntry, ...survivingEntries] });
    expect((await ContentLedger.open(path)).list()).toEqual(survivingEntries);
    expect(JSON.parse(readFileSync(join(storeRoot, "ledger.json"), "utf8"))).toEqual({ version: 1, packages: survivingEntries });
    expect(existsSync(payload)).toBe(false);
    expect(readFileSync(join(kept, "keep"), "utf8")).toBe("keep");
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    await ContentLedger.open(path);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesRemoved: 1, payloadsRemoved: 1 }, "Retired content migrated");
  });

  it.each([false, true])("does not follow a retired payload ancestor symlink with a linked root: %s", async (linkedRoot) => {
    const path = join(root, "packages", "ledger.json");
    if (linkedRoot) {
      const storeRoot = join(root, "mounted-packages");
      mkdirSync(storeRoot);
      symlinkSync(storeRoot, dirname(path), "dir");
    }
    const outside = join(root, "retained-payload");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep"), "keep");
    mkdirSync(join(dirname(path), "theme", retiredEntry.name), { recursive: true });
    symlinkSync(outside, join(dirname(path), "theme", retiredEntry.name, ".installs"), "dir");
    const original = write(path, { version: 1, packages: [retiredEntry, ...survivingEntries] });
    await expect(ContentLedger.open(path)).rejects.toThrow(`Retired package payload is a symbolic link: ${join(realpathSync(dirname(path)), "theme", retiredEntry.name, ".installs")}`);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
  });

  it.each([".installs", `.installs/${INSTALL_ID}`])("names a non-directory retired payload path at %s", async (relative) => {
    const path = join(root, "packages", "ledger.json");
    const bad = join(dirname(path), "theme", retiredEntry.name, relative);
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, "keep");
    const original = write(path, { version: 1, packages: [retiredEntry] });
    await expect(ContentLedger.open(path)).rejects.toThrow(`Retired package payload is not a directory: ${bad}`);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(bad, "utf8")).toBe("keep");
  });

  it("prunes only empty install and package parents", async () => {
    const path = join(root, "packages", "ledger.json");
    const payload = join(dirname(path), retiredEntry.origin.payloadDir);
    const orphan = join(dirname(payload), "unrecorded-install");
    mkdirSync(payload, { recursive: true });
    mkdirSync(orphan);
    writeFileSync(join(orphan, "keep"), "keep");
    write(path, { version: 1, packages: [retiredEntry] });
    await ContentLedger.open(path);
    expect(existsSync(payload)).toBe(false);
    expect(readFileSync(join(orphan, "keep"), "utf8")).toBe("keep");
    expect(existsSync(dirname(payload))).toBe(true);
    expect(existsSync(dirname(dirname(payload)))).toBe(true);
  });

  it("keeps a nonempty package parent after removing its empty installs directory", async () => {
    const path = join(root, "packages", "ledger.json");
    const payload = join(dirname(path), retiredEntry.origin.payloadDir);
    const packageRoot = dirname(dirname(payload));
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(packageRoot, "keep"), "keep");
    write(path, { version: 1, packages: [retiredEntry] });
    await ContentLedger.open(path);
    expect(existsSync(dirname(payload))).toBe(false);
    expect(readFileSync(join(packageRoot, "keep"), "utf8")).toBe("keep");
  });

  it.each([false, true])("removes the exact released legacy version, preserving other versions when present: %s", async (keepOtherVersion) => {
    const path = join(root, "packages", "ledger.json");
    const { installId: _installId, payloadDir: _payloadDir, ...origin } = retiredEntry.origin;
    const legacy = { ...retiredEntry, origin };
    const payload = join(dirname(path), "theme", legacy.name, legacy.version);
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "theme.json"), "{}");
    const other = join(dirname(payload), "2.0.0");
    if (keepOtherVersion) { mkdirSync(other); writeFileSync(join(other, "keep"), "keep"); }
    write(path, { version: 1, packages: [legacy, ...survivingEntries] });
    expect((await ContentLedger.open(path)).list()).toEqual(survivingEntries);
    expect(existsSync(payload)).toBe(false);
    expect(existsSync(dirname(payload))).toBe(keepOtherVersion);
    if (keepOtherVersion) expect(readFileSync(join(other, "keep"), "utf8")).toBe("keep");
  });

  it("refuses a symlink at a legacy version and names the offending path", async () => {
    const path = join(root, "packages", "ledger.json");
    const { installId: _installId, payloadDir: _payloadDir, ...origin } = retiredEntry.origin;
    const legacy = { ...retiredEntry, origin };
    const payload = join(dirname(path), "theme", legacy.name, legacy.version);
    const outside = join(root, "preserved");
    mkdirSync(dirname(payload), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "keep");
    symlinkSync(outside, payload, "dir");
    const original = write(path, { version: 1, packages: [legacy] });
    await expect(ContentLedger.open(path)).rejects.toThrow(`Retired package payload is a symbolic link: ${payload}`);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
  });

  it("rejects an unsafe legacy version before deleting any payload", async () => {
    const path = join(root, "packages", "ledger.json");
    const { installId: _installId, payloadDir: _payloadDir, ...origin } = retiredEntry.origin;
    const version = "../preserved";
    const legacy = { ...retiredEntry, version, origin: { ...origin, version } };
    const payload = join(dirname(path), retiredEntry.origin.payloadDir);
    mkdirSync(payload, { recursive: true });
    const original = write(path, { version: 1, packages: [legacy] });
    await expect(ContentLedger.open(path)).rejects.toThrow("version is not a safe payload directory");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(payload)).toBe(true);
  });
});

describe("retired update and boot records", () => {
  const historyRecord = { to: "1.0.0", state: "manual", attempts: 0 };
  it("persists removal of released theme history once while preserving discovery and other updates", async () => {
    const path = join(root, "updates.json");
    const retained = { version: 1, discovery: { lastAttemptAt: AT, lastSuccessAt: AT, result: "ok" }, applyCheckAt: AT,
      packages: { "ave:skill:harbor": historyRecord } };
    write(path, { ...retained, packages: { "ave:theme:harbor-theme": historyRecord, ...retained.packages } });
    const store = updateHistoryStore(path);
    expect(await store.load()).toEqual({ history: retained, reset: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(retained);
    await store.load();
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesRemoved: 1 }, "Retired update records migrated");
  });

  it("reports another unknown history kind without applying the retirement rewrite", async () => {
    const path = join(root, "updates.json");
    const original = write(path, { version: 1, discovery: null, applyCheckAt: null,
      packages: { "ave:theme:harbor-theme": historyRecord, "ave:widget:harbor": historyRecord } });
    expect(await updateHistoryStore(path).load()).toMatchObject({ reset: true, reason: expect.stringContaining("widget") });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("persists removal of released theme default records without reinstalling surviving defaults", async () => {
    const path = join(root, "packages", "default-installs.json");
    const retained = { kind: "plugin", name: "meeting", source: "ave", result: "installed", at: AT };
    write(path, { version: 1, applied: [{ ...retained, kind: "theme", name: "harbor-theme" }, retained] });
    const applied = await AppliedDefaults.open(path);
    expect(applied.list()).toEqual([retained]);
    expect(applied.has({ kind: "plugin", name: "meeting", source: "ave" })).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, applied: [retained] });
    await AppliedDefaults.open(path);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesRemoved: 1 }, "Retired default install records migrated");
  });

  it("rejects another unknown default kind without rewriting the file", async () => {
    const path = join(root, "default-installs.json");
    const entry = { name: "harbor", source: "ave", result: "installed", at: AT };
    const original = write(path, { version: 1, applied: [{ ...entry, kind: "theme" }, { ...entry, kind: "widget" }] });
    await expect(AppliedDefaults.open(path)).rejects.toThrow("applied[1].kind is not a package kind");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("retired catalog boundary", () => {
  const retained = { kind: "skill", name: "harbor", path: "skills/harbor", versions: [{ version: "1.0.0", commit: COMMIT, minAppVersion: "0.12.0", publishedAt: AT }] };
  const retired = { ...retained, kind: "theme", name: "harbor-theme", path: "themes/harbor-theme" };
  const snapshot = { formatVersion: 2, sourceId: "ave", commit: COMMIT, fetchedAt: AT, marketplace: { name: "ave", displayName: "Ave" },
    packages: [retired, retained], revocations: [], conditionalRevocations: [], diagnostics: [] };
  it("skips only retired entries in a released retained snapshot", () => {
    expect(validateCachedSnapshotText(JSON.stringify(snapshot))).toEqual({ ok: true, value: { ...snapshot, packages: [retained] } });
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesSkipped: 1 }, "Retired catalog entries skipped");
  });
  it("rejects another unknown or malformed retained snapshot entry", () => {
    for (const invalid of [{ ...retained, kind: "widget" }, { ...retained, versions: [{}] }]) {
      expect(validateCachedSnapshotText(JSON.stringify({ ...snapshot, packages: [retired, invalid] }))).toMatchObject({ ok: false });
    }
  });
  it("skips retired remote index entries while rejecting other invalid packages with diagnostics", () => {
    const result = validateIndexText(JSON.stringify({ schemaVersion: 2, name: "ave", displayName: "Ave", packages: [retired, retained, { ...retained, kind: "widget" }] }), { sourceId: "ave", official: true });
    expect(result).toMatchObject({ ok: true, value: { index: { packages: [retained] }, diagnostics: [{ subject: "widget/harbor" }] } });
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ entriesSkipped: 1 }, "Retired catalog entries skipped");
  });
});
