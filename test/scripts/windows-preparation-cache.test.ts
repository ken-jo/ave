import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  restoreWindowsPreparation, sealWindowsPreparation, verifyInstalledWindowsPreparation, verifySealedWindowsPreparation, windowsPreparationInputs, windowsPreparationKey,
  type WindowsPreparationManifest,
} from "../../scripts/lib/windows-preparation-cache.mjs";
import { createTmpDirTracker } from "../../src/__tests__/support/tmp-dir-teardown.js";

const tracker = createTmpDirTracker();
const makeDir = () => tracker.track(mkdtempSync(join(tmpdir(), "win-preparation-")));
afterAll(() => tracker.cleanup());
const identity = { image: "windows", imageVersion: "1", compiler: { msvc: "14.44", sdk: "10.0.26100" } } satisfies WindowsPreparationManifest["identity"];

describe("Windows preparation inputs", () => {
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
      { ...identity, srtWin: { nativePatchSha256: "changed" } },
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
  const required = [helper, "native/path-classifier.exe"];
  async function sealed() {
    const root = makeDir();
    for (const file of required) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file);
    }
    await sealWindowsPreparation(root, key, required);
    return root;
  }

  it("refuses to seal packaged output alongside the helper inventory", async () => {
    const root = makeDir();
    mkdirSync(join(root, "native"));
    writeFileSync(join(root, helper), "verified");
    mkdirSync(join(root, "payload"));
    writeFileSync(join(root, "payload", "app.exe"), "package");
    await expect(sealWindowsPreparation(root, key, [helper])).rejects.toThrow("Unexpected preparation output");
  });

  it("rechecks the sealed outputs before publication and refuses a replacement seal", async () => {
    const root = makeDir();
    const output = "helper.exe";
    writeFileSync(join(root, output), "verified");
    const digest = await sealWindowsPreparation(root, key, [output]);
    await expect(verifySealedWindowsPreparation(root, key, [output], digest)).resolves.toBeUndefined();
    writeFileSync(join(root, output), "changed after sealing");
    await expect(verifySealedWindowsPreparation(root, key, [output], digest)).rejects.toThrow("digest mismatch");
    rmSync(join(root, "outputs.json"));
    await sealWindowsPreparation(root, key, [output]);
    await expect(verifySealedWindowsPreparation(root, key, [output], digest)).rejects.toThrow("seal changed");
  });

  it("uses an exact entry after its bytes and identity both pass", async () => {
    const root = await sealed();
    const directory = makeDir();
    const verifyIdentity = vi.fn();
    const install = vi.fn((readVerified: (file: string) => Buffer) => {
      expect(readVerified(helper).toString()).toBe(helper);
    });
    expect(await restoreWindowsPreparation(root, key, required, true, { verifyIdentity, stage: { directory, install } })).toBe(true);
    expect(verifyIdentity).toHaveBeenCalledExactlyOnceWith(directory);
    expect(install).toHaveBeenCalledOnce();
    expect(readFileSync(join(directory, required[1] ?? ""), "utf8")).toBe(required[1]);
  });

  it.each(required)("rejects a changed installed file at the first launcher step: %s", async file => {
    const root = await sealed(), directory = makeDir(), job = makeDir();
    const destinations = Object.fromEntries(required.map(name => [name, join(job, name)]));
    mkdirSync(join(job, "native"));
    let digest: string | undefined;
    expect(await restoreWindowsPreparation(root, key, required, true, {
      verifyIdentity: () => {},
      stage: { directory, install(readVerified, manifestDigest) {
        digest = manifestDigest;
        for (const [name, destination] of Object.entries(destinations)) writeFileSync(destination, readVerified(name));
      } },
    })).toBe(true);
    const launch = vi.fn();
    const firstStep = () => verifyInstalledWindowsPreparation(directory, key, destinations, digest).then(launch);
    await firstStep();
    expect(launch).toHaveBeenCalledOnce();
    launch.mockClear();
    const destination = join(job, file);
    writeFileSync(destination, "changed after verified install");
    await expect(firstStep()).rejects.toThrow(`Installed Windows helper digest mismatch: ${file}`);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["changed", "partial", "extra", "wrong key", "not an exact hit"])("rebuilds on a %s restore before using any outputs", async (problem) => {
    const root = await sealed();
    const path = join(root, helper);
    if (problem === "changed") writeFileSync(path, "changed bytes");
    if (problem === "partial") rmSync(path);
    if (problem === "extra") writeFileSync(join(root, "extra"), "extra bytes");
    const verifyIdentity = vi.fn();
    expect(await restoreWindowsPreparation(root, problem === "wrong key" ? "other-key" : key, required,
      problem !== "not an exact hit", { verifyIdentity })).toBe(false);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it("rebuilds when the current signature or identity check rejects sealed bytes", async () => {
    const root = await sealed();
    const verifyIdentity = vi.fn(() => { throw new Error("identity changed"); });
    expect(await restoreWindowsPreparation(root, key, required, true, { verifyIdentity })).toBe(false);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
  });

  it("rebuilds if the output changes during the identity check", async () => {
    const root = await sealed();
    const directory = makeDir();
    const verifyIdentity = vi.fn(path => writeFileSync(join(path, helper), "changed during verification"));
    const install = vi.fn();
    expect(await restoreWindowsPreparation(root, key, required, true, { verifyIdentity, stage: { directory, install } })).toBe(false);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("rebuilds if a staged helper changes as installation reads its bytes", async () => {
    const root = await sealed();
    const directory = makeDir();
    const use = vi.fn();
    expect(await restoreWindowsPreparation(root, key, required, true, {
      verifyIdentity: () => {},
      stage: { directory, install(readVerified) {
        writeFileSync(join(directory, helper), "changed before copy");
        use(readVerified(helper));
      } },
    })).toBe(false);
    expect(use).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects __proto__ and never verifies identity for an unmanifested file", async () => {
    const root = await sealed();
    writeFileSync(join(root, "__proto__"), "unexpected bytes");
    const verifyIdentity = vi.fn();
    expect(await restoreWindowsPreparation(root, key, required, true, { verifyIdentity })).toBe(false);
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it("refuses to seal a file named __proto__ even inside a helper directory", async () => {
    const root = makeDir();
    mkdirSync(join(root, "native"));
    writeFileSync(join(root, "native/__proto__"), "unexpected bytes");
    await expect(sealWindowsPreparation(root, key, [])).rejects.toThrow("Unexpected preparation output");
  });
});
