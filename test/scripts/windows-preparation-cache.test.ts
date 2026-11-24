import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  restoreWindowsPreparation, sealWindowsPreparation, windowsPreparationInputs, windowsPreparationKey,
  type WindowsPreparationManifest,
} from "../../scripts/lib/windows-preparation-cache.mjs";
import { readInstalledPtyHeaders, verifyInstalledPackagingInputs } from "../../scripts/check-mxc-packaging.mjs";
import { createTmpDirTracker } from "../../src/__tests__/support/tmp-dir-teardown.js";

const tracker = createTmpDirTracker();
const makeDir = () => tracker.track(mkdtempSync(join(tmpdir(), "win-preparation-")));
afterAll(() => tracker.cleanup());
const identity = { image: "windows", imageVersion: "1", compiler: { msvc: "14.44", sdk: "10.0.26100" } } satisfies WindowsPreparationManifest["identity"];

describe("Windows preparation inputs", () => {
  it("changes the key when an installed input is changed or removed", async () => {
    const root = makeDir();
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    writeFileSync(join(root, "bun.lock"), "lock");
    execFileSync("git", ["-C", root, "add", "bun.lock"]);
    const header = "node_modules/node-pty/node_modules/node-addon-api/package.json";
    mkdirSync(dirname(join(root, header)), { recursive: true });
    const manifest = () => windowsPreparationInputs(root, identity, [header]);
    writeFileSync(join(root, header), '{"name":"node-addon-api","version":"1"}');
    const first = await manifest();
    expect(first.files[header]).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(root, header), '{"name":"node-addon-api","version":"2"}');
    const second = await manifest();
    expect(windowsPreparationKey(second)).not.toBe(windowsPreparationKey(first));
    const output = join(root, "verified");
    mkdirSync(output);
    writeFileSync(join(output, "package.bin"), "verified output");
    await sealWindowsPreparation(output, windowsPreparationKey(second), ["package.bin"]);
    rmSync(join(root, header));
    expect(windowsPreparationKey(await manifest())).not.toBe(windowsPreparationKey(second));
    const cold = await readInstalledPtyHeaders(join(root, "node_modules")).catch((error: Error) => error.message);
    expect(cold).toMatch(/ENOENT.*node-addon-api/);
    const verifyIdentity = vi.fn();
    await expect(restoreWindowsPreparation(output, windowsPreparationKey(second), ["package.bin"], true, verifyIdentity,
      () => verifyInstalledPackagingInputs(root, ["x64"]))).rejects.toThrow(cold);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it("changes the key when a tracked source, lockfile, runner image, compiler or SDK changes", async () => {
    const root = makeDir();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "--quiet");
    mkdirSync(join(root, "native"));
    const source = join(root, "native", "helper.cpp");
    const lockfile = join(root, "bun.lock");
    writeFileSync(source, "original");
    writeFileSync(lockfile, "lock");
    git("add", "native/helper.cpp", "bun.lock");
    const manifest = await windowsPreparationInputs(root, identity);
    const key = windowsPreparationKey(manifest);
    expect(Object.keys(manifest.files)).toEqual(["bun.lock", "native/helper.cpp"]);
    for (const changed of [
      { ...identity, imageVersion: "2" },
      { ...identity, compiler: { ...identity.compiler, msvc: "14.45" } },
      { ...identity, compiler: { ...identity.compiler, sdk: "10.0.26200" } },
    ]) expect(windowsPreparationKey(await windowsPreparationInputs(root, changed))).not.toBe(key);
    writeFileSync(source, "changed");
    expect(windowsPreparationKey(await windowsPreparationInputs(root, identity))).not.toBe(key);
    writeFileSync(source, "original");
    writeFileSync(lockfile, "changed lock");
    expect(windowsPreparationKey(await windowsPreparationInputs(root, identity))).not.toBe(key);
  });
});

describe("Windows preparation output cache", () => {
  const key = windowsPreparationKey({ identity, files: { "bun.lock": "digest" } });
  const helper = "native/helper.exe";
  const required = [helper, "payload/x64/app.exe"];
  async function sealed() {
    const root = makeDir();
    for (const file of required) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file);
    }
    await sealWindowsPreparation(root, key, required);
    return root;
  }

  it("uses an exact entry after its bytes and identity both pass", async () => {
    const root = await sealed();
    const verifyIdentity = vi.fn();
    expect(await restoreWindowsPreparation(root, key, required, true, verifyIdentity)).toBe(true);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(existsSync(join(root, helper))).toBe(true);
  });

  it.each(["changed", "partial", "extra", "wrong key", "not an exact hit"])("rebuilds on a %s restore before using any outputs", async (problem) => {
    const root = await sealed();
    const path = join(root, helper);
    if (problem === "changed") writeFileSync(path, "changed bytes");
    if (problem === "partial") rmSync(path);
    if (problem === "extra") writeFileSync(join(root, "extra"), "extra bytes");
    const verifyIdentity = vi.fn();
    expect(await restoreWindowsPreparation(root, problem === "wrong key" ? "other-key" : key, required,
      problem !== "not an exact hit", verifyIdentity)).toBe(false);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it("rebuilds when the current signature or identity check rejects sealed bytes", async () => {
    const root = await sealed();
    const verifyIdentity = vi.fn(() => { throw new Error("identity changed"); });
    expect(await restoreWindowsPreparation(root, key, required, true, verifyIdentity)).toBe(false);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
  });
});
