import { configureHostResources } from "../../main/host-resources.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { readPermissionSettings, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { savePolicy, userPolicyPath } from "../../permissions/policy-store.js";
import { SecretDocumentStore } from "../../data/secret-document-store.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { ensureAveHomePrivate, _resetAveHomePrivacyForTest, win32SystemBinary } from "../ave-home.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { withAveHomeConfigurationWrite, setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";

import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

useConfigurationOwner();

const paths = useTempPaths("configuration-owners-", ".ave");
const accessSource = fileURLToPath(new URL("../ave-home-configuration-access.ts", import.meta.url));
const migrationSource = fileURLToPath(new URL("../ave-home-configuration.ts", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAveHomePrivacyForTest();
});

function fixture(): string {
  const home = paths();
  setFixtureOwner(dirname(home));
  expect(ensureAveHomePrivate(home).enforcement).not.toBe("none");
  vi.stubEnv("AVE_HOME", home);
  return home;
}

function migrateOtherProcess(home: string): string[] {
  const bundle = join(dirname(home), "migration.cjs");
  buildSync({
    stdin: {
      contents: `
    import { configureHostResources } from ${JSON.stringify(fileURLToPath(new URL("../../main/host-resources.ts", import.meta.url)))};
    configureHostResources({ resourcePath: ${JSON.stringify(resolve("resources"))}, isPackaged: false });import { setAveHomeConfigurationOwner } from ${JSON.stringify(accessSource)}; setAveHomeConfigurationOwner({hasSingleInstanceLock: () => true}); import { migrateAveHomeConfiguration } from ${JSON.stringify(migrationSource)}; console.log(JSON.stringify(migrateAveHomeConfiguration(process.argv[2])));`,
      resolveDir: resolve(dirname(migrationSource)),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    external: ["electron"],
  });
  setAveHomeConfigurationOwner(undefined);
  try { return JSON.parse(execFileSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [bundle, home], {
    encoding: "utf8", windowsHide: true,
  })); } finally { setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true }); }
}

describe("independent configuration owners", () => {

  it("reads supported reviewer settings without migration while an in process writer holds the home", async () => {
    const home = fixture();
    const path = join(home, "settings.json");
    const raw = JSON.stringify({ permissions: { reviewer: { mode: "disabled" } } });
    writeFileSync(path, raw);
    await withAveHomeConfigurationWrite(path, async () => {
      const started = performance.now();
      const result = readPermissionSettings(path);
      expect(result.permissions.reviewer.mode).toBe("disabled");
      expect(readFileSync(path, "utf8")).toBe(raw);
      expect(performance.now() - started).toBeLessThan(5_000);
    });
    readPermissionSettings(path);
    expect(JSON.parse(readFileSync(path, "utf8")).permissions.reviewer.mode).toBe("disabled");
  });


  it("refuses a write when the active home loses its configuration boundary", async () => {
    const home = fixture();
    renameSync(join(home, "config"), join(home, "previous-config"));
    await expect(savePolicy({ requireExplicitApproval: true }, join(home, "policy.json"), join(home, "absent-admin.json")))
      .rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
    expect(existsSync(join(home, "policy.json"))).toBe(false);
  });

  it("keeps a refused home on root files without touching the configuration lock", async () => {
    const home = fixture();
    const lock = join(home, "config", ".ave-config.lock");
    writeFileSync(lock, "unreadable lock");
    expect(migrateAveHomeConfiguration(home, { enforcement: "none", home, category: "not-protected", reason: "Fixture refusal" })).toEqual([]);
    await writePermissionSettings({ reviewer: { mode: "llm" } });
    await savePolicy({ requireExplicitApproval: true }, undefined, join(home, "absent-admin.json"));
    await writePermissionSettings({ reviewer: { mode: "llm" } }, join(home, "config", "settings.json"));
    await savePolicy({ requireExplicitApproval: true }, join(home, "config", "policy.json"), join(home, "absent-admin.json"));
    expect(migrateAveHomeConfiguration(home)).toEqual([]);
    expect(existsSync(join(home, "settings.json"))).toBe(true);
    expect(existsSync(join(home, "policy.json"))).toBe(true);
    expect(existsSync(join(home, "config", "settings.json"))).toBe(false);
    expect(existsSync(join(home, "config", "policy.json"))).toBe(false);
    expect(existsSync(join(home, "config", ".ave-config-migrated"))).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("unreadable lock");
  });








  it("preserves a root reader restriction when a second owner commits migration", () => {
    const home = fixture();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }));
    expect(readPermissionSettings().permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(migrateOtherProcess(home)).toEqual([]);
    expect(readPermissionSettings().permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it("preserves a stricter policy saved by a root era writer", async () => {
    const home = fixture();
    writeFileSync(join(home, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false }));
    expect(userPolicyPath(home)).toBe(join(home, "policy.json"));
    expect(migrateOtherProcess(home)).toEqual([]);
    await savePolicy({ requireExplicitApproval: true }, undefined, join(home, "absent-admin.json"));
    expect(migrateOtherProcess(home)).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, "config", "policy.json"), "utf8")).requireExplicitApproval).toBe(true);
  });

  it("reroutes an explicit root era settings writer after another owner commits", async () => {
    const home = fixture();
    const oldPath = join(home, "settings.json");
    writeFileSync(oldPath, JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } }));
    migrateOtherProcess(home);
    await writePermissionSettings({ additionalDirectories: [] }, oldPath);
    expect(existsSync(oldPath)).toBe(false);
    expect(readPermissionSettings().permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it("reroutes a secret owner constructed before another process commits", async () => {
    const home = fixture();
    const store = new SecretDocumentStore({ path: join(home, "ave-secrets.json"), policy: "development", encryption: unavailableSecretEncryption });
    await store.set("fixture", "before");
    migrateOtherProcess(home);
    expect(store.get("fixture")).toBe("before");
    await store.set("fixture", "after");
    expect(store.get("fixture")).toBe("after");
    expect(store.path).toBe(join(home, "config", "ave-secrets.json"));
    expect(existsSync(join(home, "ave-secrets.json"))).toBe(false);
    expect(migrateOtherProcess(home)).toEqual([]);
  });

  it("preserves a root file first appearing after commit", () => {
    const home = fixture();
    migrateOtherProcess(home);
    writeFileSync(join(home, "settings.json"), "outside edit");
    const diagnostics = migrateOtherProcess(home);
    expect(diagnostics.join("\n")).toContain("settings.json.post-migration-");
    const aside = readdirSync(home).find((name) => name.startsWith("settings.json.post-migration-"));
    expect(readFileSync(join(home, aside!), "utf8")).toBe("outside edit");
    expect(readFileSync(join(home, "config", "settings.json"), "utf8")).toBe("{}\n");
  });

  it("preserves an outside root write after commit with a diagnostic", () => {
    const home = fixture();
    writeFileSync(join(home, "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    migrateOtherProcess(home);
    const outside = '{"version":1,"requireExplicitApproval":true}';
    writeFileSync(join(home, "policy.json"), outside);
    expect(migrateOtherProcess(home).join("\n")).toContain("policy.json.post-migration-");
    const aside = readdirSync(home).find((name) => name.startsWith("policy.json.post-migration-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(home, aside!), "utf8")).toBe(outside);
    expect(JSON.parse(readFileSync(join(home, "config", "policy.json"), "utf8")).requireExplicitApproval).toBe(false);
  });

  it("deletes a byte identical root copy after commit", () => {
    const home = fixture();
    const bytes = '{"version":1,"requireExplicitApproval":false}';
    writeFileSync(join(home, "policy.json"), bytes);
    migrateOtherProcess(home);
    writeFileSync(join(home, "policy.json"), bytes);
    expect(migrateOtherProcess(home)).toEqual([]);
    expect(existsSync(join(home, "policy.json"))).toBe(false);
    expect(readdirSync(home).some((name) => name.startsWith("policy.json.post-migration-"))).toBe(false);
  });

  it("reverifies a replaced configuration directory before reading", () => {
    const home = fixture();
    migrateOtherProcess(home);
    expect(userPolicyPath(home)).toBe(join(home, "config", "policy.json"));
    renameSync(join(home, "config"), join(home, "previous-config"));
    expect(ensureAveHomePrivate(home).enforcement).not.toBe("none");
    writeFileSync(join(home, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    if (process.platform === "win32") {
      execFileSync(win32SystemBinary("icacls"), [join(home, "config"), "/grant", "*S-1-1-0:(OI)(CI)R", "/q"], { windowsHide: true });
    } else chmodSync(join(home, "config"), 0o777);
    expect(() => userPolicyPath(home)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });

  it("reverifies an in place permission change before writing", async () => {
    const home = fixture();
    migrateAveHomeConfiguration(home);
    const target = userPolicyPath(home);
    expect(target).toBe(join(home, "config", "policy.json"));
    if (process.platform === "win32") {
      execFileSync(win32SystemBinary("icacls"), [join(home, "config"), "/grant", "*S-1-1-0:(OI)(CI)R", "/q"], { windowsHide: true });
    } else chmodSync(join(home, "config"), 0o777);
    await expect(savePolicy({ requireExplicitApproval: true }, target, join(home, "absent-admin.json")))
      .rejects.toMatchObject({ name: "AveHomeConfigurationUntrustedError" });
  });
});
