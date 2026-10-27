import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const payload = new TextEncoder().encode("pinned archive");
  const extension = new TextEncoder().encode("pinned extension");
  return { payload, extension, signature: "signature", fetch: vi.fn(), verifyRelease: vi.fn(), verifyPlatform: vi.fn(), tamperExtraction: false };
});

vi.mock("../../core/network-guard.js", () => ({ fetchPublicHttpResponse: fixtures.fetch }));
vi.mock("../codex-executable-location.js", async (original) => ({ ...await original<typeof import("../codex-executable-location.js")>(), assertCodexLocations: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../document-engine-release-pins.js", async () => {
  const { createHash } = await import("node:crypto");
  const release = { platform: process.platform, arch: process.arch, version: "26.8.1", filename: "release.bin", bytes: fixtures.payload.length,
    sha256: createHash("sha256").update(fixtures.payload).digest("hex"), installedBytes: 100,
    url: "https://download.documentfoundation.org/libreoffice/stable/26.8.1/mac/aarch64/release.bin?mirrorlist=0" };
  return { documentEngineReleaseFor: () => release,
    documentEngineSignatureUrl: () => "https://download.documentfoundation.org/libreoffice/stable/26.8.1/mac/aarch64/release.bin.asc?mirrorlist=0",
    DOCUMENT_ENGINE_IMPORT_EXTENSION: { filename: "H2Orestart.oxt", bytes: fixtures.extension.length,
      sha256: createHash("sha256").update(fixtures.extension).digest("hex"),
      url: "https://github.com/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt" } };
});
vi.mock("../document-engine-signature.js", () => ({ verifyDocumentEngineReleaseSignature: fixtures.verifyRelease, verifyDocumentEnginePlatformSignature: fixtures.verifyPlatform }));
vi.mock("../document-engine-payload.js", async (original) => {
  const actual = await original<typeof import("../document-engine-payload.js")>();
  const { createHash } = await import("node:crypto");
  const paths = (destination: string) => ({ root: join(destination, "engine"), executable: join(destination, "engine", "soffice"), unopkg: join(destination, "engine", "unopkg") });
  return { ...actual, documentEnginePayloadPaths: paths,
    extractDocumentEnginePayload: vi.fn(async (_archive: string, destination: string) => {
      const result = paths(destination); await mkdir(result.root);
      await writeFile(result.executable, fixtures.tamperExtraction ? "mutated engine" : "engine"); await writeFile(result.unopkg, "package manager");
      return result;
    }), reconstructDocumentEngineTree: vi.fn(async () => [
      { path: "", kind: "directory", size: 0 },
      ...[["soffice", "engine"], ["unopkg", "package manager"]].map(([path, bytes]) => ({ path, kind: "file", size: bytes!.length,
        sha256: createHash("sha256").update(bytes!).digest("hex"), ...(process.platform !== "win32" ? { executable: false } : {}) })),
    ]) };
});

let home: string;
let previousHome: string | undefined;
let installer: typeof import("../document-engine-installation.js");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixtures.verifyRelease.mockResolvedValue(undefined);
  fixtures.verifyPlatform.mockResolvedValue(undefined);
  fixtures.tamperExtraction = false;
  previousHome = process.env.AVE_HOME;
  home = await mkdtemp(join(tmpdir(), "ave-document-install-"));
  process.env.AVE_HOME = home;
  fixtures.fetch.mockImplementation(async (url: string, options: { authorizeTarget: (url: URL) => Promise<void> }) => {
    await options.authorizeTarget(new URL(url));
    return new Response(url.includes(".asc") ? fixtures.signature : url.includes("H2Orestart") ? fixtures.extension : fixtures.payload);
  });
  installer = await import("../document-engine-installation.js");
  installer.initializeDocumentEngineInstallationNetwork(vi.fn());
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("optional document engine installation", () => {
  it("keeps true absence read-only and reports the disclosed download size", async () => {
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "absent", downloadBytes: fixtures.payload.length + fixtures.extension.length });
    expect(await readdir(home)).toEqual([]);
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });

  it("streams pinned downloads, verifies before publication, and removes only its owned slot", async () => {
    const states: string[] = [];
    await installer.installDocumentEngine((state) => states.push(state.phase), new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    expect(installation).not.toBeNull();
    expect(states).toContain("verifying"); expect(states).toContain("installing"); expect(states.at(-1)).toBe("ready");
    expect(fixtures.verifyRelease).toHaveBeenCalled(); expect(fixtures.verifyPlatform).toHaveBeenCalled();
    const options = fixtures.fetch.mock.calls[0]![1];
    expect(options).toMatchObject({ credentials: "omit", maxRedirects: 0 });
    await expect(options.authorizeTarget(new URL("http://download.documentfoundation.org/file"))).rejects.toMatchObject({ code: "download-failed" });
    await expect(options.authorizeTarget(new URL("https://unlisted.example/file"))).rejects.toMatchObject({ code: "download-failed" });
    const marker = join(home, "document-engine", "keep.txt"); await writeFile(marker, "unrelated");
    await installer.uninstallDocumentEngine();
    expect(await readFile(marker, "utf8")).toBe("unrelated");
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    expect(() => installation!.assertCurrent()).toThrow("no longer current");
  });

  it("rejects an artifact mismatch before extraction and leaves no ready receipt", async () => {
    fixtures.fetch.mockResolvedValueOnce(new Response(Buffer.from("wrong archive")));
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    expect(fixtures.verifyRelease).not.toHaveBeenCalled();
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "error", error: "integrity-failed" });
  });

  it("rejects invalid release signatures without publishing an installation", async () => {
    fixtures.verifyRelease.mockRejectedValueOnce(new Error("bad signature"));
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "signature-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
  });

  it("invalidates an authenticated runtime when a payload dependency changes", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    await writeFile(installation!.unopkg, "changed executable");
    await expect(installation!.verifyBeforeSpawn(new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(installer.getDocumentEngineInstallationState()).rejects.toMatchObject({ code: "integrity-failed" });
  });

  it("never reports ready for a missing payload", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    await rm(installation!.root, { recursive: true });
    await expect(installer.getDocumentEngineInstallationState()).rejects.toMatchObject({ code: "integrity-failed" });
  });

  it("reuses cryptographic verification only while every captured identity remains unchanged", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    const count = fixtures.verifyRelease.mock.calls.length;
    await installation!.verifyBeforeSpawn(new AbortController().signal);
    await installation!.verifyBeforeSpawn(new AbortController().signal);
    expect(fixtures.verifyRelease).toHaveBeenCalledTimes(count);
  });

  it("compares a new installation against independently reconstructed authenticated bytes", async () => {
    fixtures.tamperExtraction = true;
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
  });

  it("rejects same-content replacement at the synchronous execution boundary", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    await writeFile(installation!.unopkg, "package manager");
    expect(() => installation!.assertCurrent()).toThrow("payload changed after verification");
  });

  it("invalidates admission before waiting for converter teardown", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    let finishDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolve) => { finishDrain = resolve; });
    const removal = installer.uninstallDocumentEngine(() => drain);
    expect(() => installation!.assertCurrent()).toThrow("no longer current");
    await expect(installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).rejects.toMatchObject({ code: "install-failed" });
    finishDrain!(); await removal;
  });

  it("retries receipt removal after its known installation slot was already removed", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementationOnce(async () => { throw Object.assign(new Error("locked receipt"), { code: "EACCES" }); });
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.stat(installation!.root)).rejects.toMatchObject({ code: "ENOENT" });
    vi.mocked(fs.unlink).mockImplementation(unlink);
    await expect(installer.uninstallDocumentEngine()).resolves.toBeUndefined();
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
  });

  it("does not treat corrupt receipts as engine absence", async () => {
    await mkdir(join(home, "document-engine"));
    await writeFile(join(home, "document-engine", "installation.json"), "{broken");
    await expect(installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(installer.getDocumentEngineInstallationState()).rejects.toMatchObject({ code: "integrity-failed" });
  });

  it("cancels a partial streamed artifact and prevents concurrent installation admission", async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    fixtures.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(fixtures.payload.subarray(0, 2)); started!(); } })));
    const first = installer.installDocumentEngine(() => {}, controller.signal);
    await startedPromise;
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "install-failed" });
    await expect(installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).rejects.toMatchObject({ code: "install-failed" });
    controller.abort(new Error("cancel"));
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
  });

  it("rechecks an extension's immutable bytes before every execution admission", async () => {
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    expect(createHash("sha256").update(await readFile(installation!.extensionPath)).digest("hex")).toBe(installation!.extensionSha256);
    await writeFile(installation!.extensionPath, fixtures.payload);
    await expect(installation!.verifyBeforeSpawn(new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
  });
});
