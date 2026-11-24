import { configureHostResources } from "../../main/host-resources.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { addAllowedDirectoryPersist, readPermissionSettings, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { ensureAveHomePrivate, _resetAveHomePrivacyForTest } from "../ave-home.js";

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

const paths = useTempPaths("configuration-authority-", "config");
const ordinaryPaths = useTempPaths("configuration-authority-", ".ave");
const settingsSource = fileURLToPath(new URL("../../permissions/permission-settings-store.ts", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAveHomePrivacyForTest();
  setAveHomeConfigurationOwner(undefined);
});

function fixture(home = ordinaryPaths()): string {
  setFixtureOwner(dirname(home));
  expect(ensureAveHomePrivate(home).enforcement).not.toBe("none");
  return home;
}

function child(home: string, contents: string): string {
  const script = join(dirname(home), "reader.cjs");
  const initialized = `import { configureHostResources } from ${JSON.stringify(fileURLToPath(new URL("../../main/host-resources.ts", import.meta.url)))};
    configureHostResources({ resourcePath: ${JSON.stringify(resolve("resources"))}, isPackaged: false });\n${contents}`;
  buildSync({ stdin: { contents: initialized, resolveDir: dirname(settingsSource) }, bundle: true, platform: "node", format: "cjs", outfile: script, external: ["electron"] });
  return execFileSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, [script, home], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, AVE_HOME: home },
  }).trim();
}

describe("configuration write authority", () => {
  it("refuses migration without the interactive instance lock", () => {
    const home = fixture();
    writeFileSync(join(home, "settings.json"), '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}');
    expect(() => migrateAveHomeConfiguration(home)).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationNotOwnerError" }));
    expect(readFileSync(join(home, "settings.json"), "utf8")).toContain('"blockReadsOutsideWorkingDirectories":true');
  });

  it("allows the interactive owner while a real child remains read only", async () => {
    const home = fixture();
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
    await writePermissionSettings({ additionalDirectories: [home] });
    const before = readFileSync(join(home, "settings.json"), "utf8");
    const contents = `import { writePermissionSettings } from ${JSON.stringify(settingsSource)};
      writePermissionSettings({ additionalDirectories: [] }).then(() => console.log("wrote"), error => console.log(error.name));`;
    expect(child(home, contents)).toBe("AveHomeConfigurationNotOwnerError");
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
  });

  it("serializes concurrent owner updates without losing a directory", async () => {
    const home = fixture();
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
    await Promise.all([addAllowedDirectoryPersist(join(home, "one")), addAllowedDirectoryPersist(join(home, "two"))]);
    expect(readPermissionSettings().permissions.additionalDirectories).toEqual([join(home, "one"), join(home, "two")]);
  });

  it("refuses writes after the interactive owner loses its instance lock", async () => {
    const home = fixture();
    vi.stubEnv("AVE_HOME", home);
    let held = true;
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => held });
    await writePermissionSettings({ additionalDirectories: [] });
    held = false;
    await expect(writePermissionSettings({ additionalDirectories: [home] })).rejects.toMatchObject({ name: "AveHomeConfigurationNotOwnerError" });
  });
  it("preserves the restriction of a home whose own basename is config", () => {
    const home = fixture(paths());
    vi.stubEnv("AVE_HOME", home);
    writeFileSync(join(home, "settings.json"), '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}');
    expect(readPermissionSettings().permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it("refuses both independent non owner writers before either changes settings", async () => {
    const home = fixture();
    const path = join(home, "settings.json");
    const bytes = '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}';
    writeFileSync(path, bytes);
    const contents = `import { writePermissionSettings } from ${JSON.stringify(settingsSource)};
      writePermissionSettings({ reviewer: { mode: "llm" } }).then(() => console.log("wrote"), error => console.log(error.name));`;
    expect(child(home, contents)).toBe("AveHomeConfigurationNotOwnerError");
    expect(child(home, contents)).toBe("AveHomeConfigurationNotOwnerError");
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("raises a boundary fault when a resolved root settings file disappears before opening", () => {
    const home = fixture();
    writeFileSync(join(home, "settings.json"), '{"permissions":{"blockReadsOutsideWorkingDirectories":true}}');
    const contents = `import { readPermissionSettings } from ${JSON.stringify(settingsSource)};
      const fs = require("node:fs"), path = require("node:path").join(process.argv[2], "settings.json");
      const exists = fs.existsSync, open = fs.openSync, lstat = fs.lstatSync;
      let removed = false;
      let observations = 0;
      const remove = value => { if (!removed && value === path) { removed = true; fs.unlinkSync(path); } };
      fs.existsSync = value => { remove(value); return exists(value); };
      fs.openSync = (value, ...args) => { remove(value); return open(value, ...args); };
      fs.lstatSync = (value, ...args) => { const result = lstat(value, ...args); if (value === path && ++observations === 2) remove(value); return result; };
      try { const result = readPermissionSettings(); console.log(result.fault?.kind ?? "defaults"); }
      catch (error) { console.log(error.name); }`;
    expect(child(home, contents)).toBe("AveHomeConfigurationUntrustedError");
  });

  it("raises a boundary fault for missing settings in a committed home", () => {
    const home = fixture();
    vi.stubEnv("AVE_HOME", home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    expect(() => readPermissionSettings()).toThrowError(expect.objectContaining({ name: "AveHomeConfigurationUntrustedError" }));
  });
});
