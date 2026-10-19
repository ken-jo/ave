import { createHash } from "node:crypto";
import { chmodSync, constants, mkdirSync, mkdtempSync, promises as fs, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeExecutableBytes, normalizeFixtureAncestorPermissions, writeNativeExecutable } from "../../__tests__/support/native-executable.js";
import { copyCodexExecutableArtifact, copyExecutableFile, verifyCodexExecutableArtifact } from "../codex-executable-artifact.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(platform: NodeJS.Platform = process.platform) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-artifact-")));
  roots.push(root); normalizeFixtureAncestorPermissions(root);
  const runtime = join(root, "home", "runtime"); mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const source = writeNativeExecutable(join(root, "installed", "bin", "codex"), nativeExecutableBytes(platform));
  return { root, runtime, source };
}

describe("private executable artifacts", () => {
  it("hashes and seals a script copy with exclusive no-follow opens", async () => {
    const { runtime, source } = fixture();
    const script = Buffer.from("#!/usr/bin/env node\nexport const value = 1;\n");
    writeFileSync(source, script);
    const open = vi.spyOn(fs, "open");
    const destination = join(runtime, "module.js");
    const artifact = await copyExecutableFile(source, destination);
    expect(artifact).toEqual({
      executable: destination,
      contentHash: createHash("sha256").update(script).digest("hex"),
    });
    expect(readFileSync(destination)).toEqual(script);
    const creation = open.mock.calls.find(([, flags]) => typeof flags === "number" && (flags & constants.O_CREAT) !== 0)!;
    expect(Number(creation[1]) & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(creation[2]).toBe(0o600);
    if (process.platform !== "win32") {
      const sourceOpen = open.mock.calls.find(([path]) => String(path) === source)!;
      expect(Number(sourceOpen[1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(Number(creation[1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(statSync(destination).mode & 0o777).toBe(0o500);
    }
  });

  it("hashes while copying, uses exclusive no-follow opens and seals the native copy", async () => {
    const { runtime, source } = fixture();
    const open = vi.spyOn(fs, "open");
    const artifact = await copyCodexExecutableArtifact(source, runtime);
    expect(artifact.executable).not.toBe(source);
    expect(artifact.contentHash).toBe(createHash("sha256").update(readFileSync(source)).digest("hex"));
    const create = open.mock.calls.find(([, flags]) => typeof flags === "number" && (flags & constants.O_CREAT) !== 0)!;
    expect(Number(create[1]) & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(create[2]).toBe(0o600);
    if (process.platform !== "win32") {
      expect(Number(create[1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(statSync(dirname(artifact.executable)).mode & 0o777).toBe(0o700);
      expect(statSync(artifact.executable).mode & 0o777).toBe(0o500);
    }
    await expect(verifyCodexExecutableArtifact(artifact)).resolves.toBeUndefined();
  });

  it.each(["linux", "darwin", "win32"] as const)("rejects a signature-only %s file and removes the staging directory", async (platform) => {
    const { runtime, source } = fixture(platform);
    const bytes = nativeExecutableBytes(platform).subarray(0, 4);
    writeFileSync(source, Buffer.concat([bytes, Buffer.from("\necho unsafe\n")]));
    await expect(copyCodexExecutableArtifact(source, runtime, platform)).rejects.toThrow("Invalid native executable");
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("leaves the qualified copy unchanged when the installed file and its parent are replaced", async () => {
    const { runtime, source } = fixture();
    const artifact = await copyCodexExecutableArtifact(source, runtime);
    const bytes = readFileSync(artifact.executable);
    renameSync(dirname(source), `${dirname(source)}-old`);
    mkdirSync(dirname(source)); writeFileSync(source, "#!/bin/sh\necho replacement\n");
    await expect(verifyCodexExecutableArtifact(artifact)).resolves.toBeUndefined();
    expect(readFileSync(artifact.executable)).toEqual(bytes);
  });

  it("refuses same-size changes to copied bytes even with restored modification time", async () => {
    const { runtime, source } = fixture();
    const artifact = await copyCodexExecutableArtifact(source, runtime);
    const stat = statSync(artifact.executable);
    const bytes = readFileSync(artifact.executable); bytes[bytes.length - 1] = 71;
    chmodSync(artifact.executable, 0o700); writeFileSync(artifact.executable, bytes);
    utimesSync(artifact.executable, stat.atime, stat.mtime); chmodSync(artifact.executable, 0o500);
    await expect(verifyCodexExecutableArtifact(artifact)).rejects.toThrow("Executable artifact changed");
  });

  it("refuses a replaced private ancestor before launch", async () => {
    const { runtime, source } = fixture();
    const artifact = await copyCodexExecutableArtifact(source, runtime);
    renameSync(dirname(artifact.executable), `${dirname(artifact.executable)}-old`);
    mkdirSync(dirname(artifact.executable), { mode: 0o700 });
    writeFileSync(artifact.executable, "#!/bin/sh\necho replacement\n", { mode: 0o500 });
    await expect(verifyCodexExecutableArtifact(artifact)).rejects.toThrow("Executable artifact changed");
  });

  it("does not follow an injected destination link or overwrite its target", async () => {
    const { runtime, source } = fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) symlinkSync(source, String(args[0]));
      return open(...args);
    });
    const before = readFileSync(source);
    await expect(copyCodexExecutableArtifact(source, runtime)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(source)).toEqual(before);
    expect(readdirSync(runtime)).toEqual([]);
  });

  it("copies a resource companion ahead of a legacy sibling and rechecks its digest", async () => {
    const { runtime, source } = fixture();
    const name = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
    const resourceBytes = nativeExecutableBytes(); resourceBytes[resourceBytes.length - 1] = 43;
    const resource = writeNativeExecutable(join(dirname(dirname(source)), "codex-resources", name), resourceBytes);
    writeNativeExecutable(join(dirname(source), name));
    const artifact = await copyCodexExecutableArtifact(source, runtime);
    expect(readFileSync(artifact.companion!.executable)).toEqual(readFileSync(resource));
    chmodSync(artifact.companion!.executable, 0o700); writeFileSync(artifact.companion!.executable, nativeExecutableBytes());
    chmodSync(artifact.companion!.executable, 0o500);
    await expect(verifyCodexExecutableArtifact(artifact)).rejects.toThrow("Executable artifact changed");
  });

  it("copies the resource companion beside the application bundle", async () => {
    const { root, runtime } = fixture("darwin");
    const packageDirectory = join(root, "bundle-package");
    const source = writeNativeExecutable(join(packageDirectory, "CodexCLI.app", "Contents", "MacOS", "codex"), nativeExecutableBytes("darwin"));
    const resourceBytes = nativeExecutableBytes("darwin"); resourceBytes[resourceBytes.length - 1] = 43;
    const resource = writeNativeExecutable(join(packageDirectory, "codex-resources", "codex-code-mode-host"), resourceBytes);
    writeNativeExecutable(join(root, "codex-resources", "codex-code-mode-host"), nativeExecutableBytes("darwin"));
    const artifact = await copyCodexExecutableArtifact(source, runtime, "darwin");
    expect(artifact.companion).not.toBeNull();
    expect(readFileSync(artifact.companion!.executable)).toEqual(readFileSync(resource));
    await expect(verifyCodexExecutableArtifact(artifact)).resolves.toBeUndefined();
  });

  it("rejects a non-native companion without retaining an executable artifact", async () => {
    const { runtime, source } = fixture();
    const name = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
    writeFileSync(join(dirname(source), name), "\x7fELF\necho helper\n", { mode: 0o700 });
    await expect(copyCodexExecutableArtifact(source, runtime)).rejects.toThrow("Invalid native executable");
    expect(readdirSync(runtime)).toEqual([]);
  });
});
