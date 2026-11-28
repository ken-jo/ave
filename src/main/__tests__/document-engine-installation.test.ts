// The document engine is the LibreOffice the user installed (owner decision 2026-11-28): Ave finds and verifies it,
// and installs, verifies and removes only its own part, the pinned HWP import extension. The cases set the platform to
// macOS, the only one offered; discovery checks execute permission with access(X_OK), which a Windows host also answers,
// and the cases also run with no-follow opens absent, as on a Windows host.
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const fixtures = vi.hoisted(() => ({
  extension: new TextEncoder().encode("pinned extension"),
  fetch: vi.fn(), verifyPlatform: vi.fn(), system: vi.fn(),
}));

/**
 * A Windows host has no `O_NOFOLLOW`. These cases simulate macOS through `process.platform` on any host, so the suite
 * also runs them with that constant absent, which reproduces a Windows host on this one.
 */
const host = vi.hoisted(() => ({ noFollow: true }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const constants = { ...actual.constants };
  Object.defineProperty(constants, "O_NOFOLLOW", { enumerable: true,
    get: () => host.noFollow ? actual.constants.O_NOFOLLOW : undefined });
  return { ...actual, constants, default: { ...actual, constants } };
});
// With macOS simulated on a host without no-follow opens, the production opener refuses, fail-closed. The installer's
// opener is therefore replaced on such a host only, by one doing what the opener does on Windows: links refused by
// lstat, then the opened handle's identity checked against it. Everywhere else the production opener runs.
vi.mock("../codex-executable-artifact.js", async (original) => {
  const actual = await original<typeof import("../codex-executable-artifact.js")>();
  const { constants, promises: fs } = await import("node:fs");
  return { ...actual, openExecutableFile: async (path: string) => {
    if (typeof constants.O_NOFOLLOW === "number") return actual.openExecutableFile(path);
    const before = await fs.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new actual.CodexExecutableArtifactError();
    const handle = await fs.open(path, constants.O_RDONLY);
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      await handle.close();
      throw new actual.CodexExecutableArtifactError("Executable changed while opening");
    }
    return handle;
  } };
});
vi.mock("../../core/network-guard.js", () => ({ fetchPublicHttpResponse: fixtures.fetch }));
vi.mock("../codex-executable-location.js", async (original) => ({ ...await original<typeof import("../codex-executable-location.js")>(), assertCodexLocations: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../document-engine-release-pins.js", async () => {
  const { createHash } = await import("node:crypto");
  return { DOCUMENT_ENGINE_IMPORT_EXTENSION: { filename: "H2Orestart.oxt", bytes: fixtures.extension.length,
    sha256: createHash("sha256").update(fixtures.extension).digest("hex"),
    url: "https://github.com/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt" } };
});
vi.mock("../document-engine-signature.js", () => ({ verifyDocumentEngineAppSignature: fixtures.verifyPlatform }));
vi.mock("../document-engine-system-command.js", () => ({ runDocumentEngineSystemCommand: fixtures.system }));

const HOST_PLATFORM = process.platform;
let home: string;
let apps: string;
let previousHome: string | undefined;
let installer: typeof import("../document-engine-installation.js");

/** A LibreOffice.app the way the user installs it: the engine and its package tool, executable. */
async function installApp() {
  const root = join(apps, "LibreOffice.app");
  const executable = join(root, "Contents", "MacOS", "soffice");
  const unopkg = join(root, "Contents", "MacOS", "unopkg");
  await mkdir(join(root, "Contents", "MacOS"), { recursive: true });
  for (const [path, text] of [[executable, "engine"], [unopkg, "package manager"]] as const) {
    await writeFile(path, text);
    await chmod(path, 0o755);
  }
  // What admission sees: the canonical paths of the bundle and of its two executables.
  return { root: await realpath(root), executable: await realpath(executable), unopkg: await realpath(unopkg) };
}


beforeEach(async () => {
  host.noFollow = true;
  vi.resetModules();
  vi.clearAllMocks();
  setProcessPlatform("darwin");
  fixtures.verifyPlatform.mockResolvedValue(undefined);
  fixtures.system.mockResolvedValue("26.8.3.1\n");
  previousHome = process.env.AVE_HOME;
  home = await mkdtemp(join(tmpdir(), "ave-document-install-"));
  apps = await mkdtemp(join(tmpdir(), "ave-document-apps-"));
  process.env.AVE_HOME = home;
  fixtures.fetch.mockImplementation(async (url: string, options: { authorizeTarget: (url: URL) => Promise<void> }) => {
    await options.authorizeTarget(new URL(url));
    return new Response(fixtures.extension);
  });
  installer = await import("../document-engine-installation.js");
  installer.initializeDocumentEngineInstallationNetwork(vi.fn());
  const root = join(apps, "LibreOffice.app");
  installer._setDocumentEngineAppCandidatesForTest([{ root, executable: join(root, "Contents", "MacOS", "soffice"), unopkg: join(root, "Contents", "MacOS", "unopkg") }]);
});

afterEach(async () => {
  installer._setDocumentEngineAppCandidatesForTest(undefined);
  setProcessPlatform(HOST_PLATFORM);
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
  await rm(apps, { recursive: true, force: true });
});

describe.each([
  { hostKind: "a host with no-follow opens", noFollow: true },
  { hostKind: "a host without them, as Windows", noFollow: false },
])("the document engine the user installed, on $hostKind", ({ noFollow }) => {
  beforeEach(() => { host.noFollow = noFollow; });

  it("reports a missing app, downloads nothing and writes nothing", async () => {
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "app-missing" });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "app-missing" });
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it("reports an installed app without Ave's extension as absent, read-only, with only the extension to download", async () => {
    await installApp();
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "absent", downloadBytes: fixtures.extension.length });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.verifyPlatform).not.toHaveBeenCalled();
  });

  it("installs only the pinned extension, verifies the app's publisher, and hands out the app itself", async () => {
    const app = await installApp();
    const phases: string[] = [];
    await installer.installDocumentEngine(state => phases.push(state.phase), new AbortController().signal);
    expect(phases.at(-1)).toBe("ready");
    expect(fixtures.fetch).toHaveBeenCalledOnce();
    const options = fixtures.fetch.mock.calls[0]![1];
    expect(options).toMatchObject({ credentials: "omit" });
    await expect(options.authorizeTarget(new URL("https://download.documentfoundation.org/libreoffice/stable/26.8.1/x.dmg"))).rejects.toMatchObject({ code: "download-failed" });
    expect(fixtures.verifyPlatform).toHaveBeenCalledWith(app.root, expect.anything());
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    expect(installation).toMatchObject({ executable: app.executable, unopkg: app.unopkg, version: "26.8.3.1" });
    expect(await readFile(installation!.extensionPath)).toEqual(Buffer.from(fixtures.extension));
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "ready", version: "26.8.3.1" });
    await expect(installation!.verifyBeforeSpawn(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("refuses an app whose publisher signature fails, publishing nothing", async () => {
    await installApp();
    fixtures.verifyPlatform.mockRejectedValue(new Error("Document engine signature is invalid"));
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "signature-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "error", error: "signature-failed" });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
  });

  // Host-skipped on Windows: creating a file symlink there needs elevated rights or developer mode.
  it.skipIf(HOST_PLATFORM === "win32")("refuses an engine whose executable resolves outside the signed bundle, before any signature check", async () => {
    const app = await installApp();
    // A genuine-looking bundle whose package tool is a link to a binary elsewhere: the seal does not cover that binary.
    const elsewhere = join(apps, "elsewhere-unopkg");
    await writeFile(elsewhere, "other tool");
    await chmod(elsewhere, 0o755);
    await rm(app.unopkg);
    await symlink(elsewhere, app.unopkg);
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "signature-failed" });
    expect(fixtures.verifyPlatform).not.toHaveBeenCalled();
  });

  it("refuses an extension that does not match its pin", async () => {
    await installApp();
    fixtures.fetch.mockImplementation(async () => new Response(new TextEncoder().encode("other extension")));
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
  });

  it("removes only Ave's part on uninstall and leaves the app the user installed", async () => {
    const app = await installApp();
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    const marker = join(home, "document-engine", "keep.txt");
    await writeFile(marker, "unrelated");
    await installer.uninstallDocumentEngine();
    expect(await readFile(marker, "utf8")).toBe("unrelated");
    expect(await readFile(app.executable, "utf8")).toBe("engine");
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "absent" });
    expect(() => installation!.assertCurrent()).toThrow("no longer current");
  });

  it("replaces an engine an earlier Ave installed into its namespace with the user's app", async () => {
    await installApp();
    const legacy = "slot-00000000-0000-4000-8000-000000000000";
    await mkdir(join(home, "document-engine", legacy, "payload"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "document-engine", "installation.json"), JSON.stringify({ schema: 2, version: "26.8.1", platform: "darwin",
      arch: "arm64", slot: legacy, treeDigest: "a".repeat(64), identityDigest: "b".repeat(64) }));
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "absent" });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    expect(await readdir(join(home, "document-engine"))).not.toContain(legacy);
    expect(await installer.getDocumentEngineInstallationState()).toMatchObject({ phase: "ready" });
  });

  it("stops trusting an app replaced after admission, and admits the new one afresh", async () => {
    const app = await installApp();
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    // An update in place: new bytes under the same name.
    await rm(app.executable);
    await writeFile(app.executable, "engine, updated");
    await chmod(app.executable, 0o755);
    expect(() => installation!.assertCurrent()).toThrow(expect.objectContaining({ code: "integrity-failed" }));
    fixtures.system.mockResolvedValue("26.8.4.1\n");
    const updated = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    expect(updated).toMatchObject({ executable: app.executable, version: "26.8.4.1" });
    expect(fixtures.verifyPlatform).toHaveBeenCalledTimes(2);
  });

  it("refuses a spawn once Ave's extension bytes changed, and reports it", async () => {
    await installApp();
    await installer.installDocumentEngine(() => {}, new AbortController().signal);
    const installation = await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal);
    await writeFile(installation!.extensionPath, "changed extension bytes");
    await expect(installation!.verifyBeforeSpawn(new AbortController().signal)).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(installer.getDocumentEngineInstallationState()).rejects.toMatchObject({ code: "integrity-failed" });
  });

  it("does not treat a corrupt receipt as absence", async () => {
    await installApp();
    await mkdir(join(home, "document-engine"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "document-engine", "installation.json"), "{");
    await expect(installer.getDocumentEngineInstallationState()).rejects.toMatchObject({ code: "integrity-failed" });
  });
});

// Windows and Linux are not offered. Windows behaves exactly as main did. Linux (lead decision 2026-11-28, pending the
// owner) loses the engine main offered until the slice 8 flip: it is refused like Windows before any discovery,
// download or signature check, except that the confined payload main installed can still be removed.
const HOST_ARCH = process.arch;
const LEGACY_SLOT = "slot-00000000-0000-4000-8000-000000000000";
/** The receipt main wrote for its confined Linux x64 payload. */
const legacyReceipt = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ schema: 2, version: "26.8.1",
  platform: "linux", arch: "x64", slot: LEGACY_SLOT, treeDigest: "a".repeat(64), identityDigest: "b".repeat(64), ...overrides });

async function placeLegacyPayload(receipt: string): Promise<string> {
  const slot = join(home, "document-engine", LEGACY_SLOT);
  await mkdir(join(slot, "program"), { recursive: true, mode: 0o700 });
  await writeFile(join(slot, "program", "soffice.bin"), "payload");
  await writeFile(join(home, "document-engine", "installation.json"), receipt);
  return slot;
}

describe("the production executable opener", () => {
  it("still refuses, fail-closed, on macOS without a no-follow open", async () => {
    const actual = await vi.importActual<typeof import("../codex-executable-artifact.js")>("../codex-executable-artifact.js");
    const app = await installApp();
    host.noFollow = false;
    await expect(actual.openExecutableFile(app.executable)).rejects.toThrow("No-follow open is unavailable");
    // Control: with the flag present the same open succeeds. A Windows host has no such flag, so the control runs elsewhere.
    host.noFollow = true;
    if (HOST_PLATFORM !== "win32") await (await actual.openExecutableFile(app.executable)).close();
  });
});

describe.each(["win32", "linux"] as const)("the document engine on %s", (platform) => {
  beforeEach(() => {
    installer._setDocumentEngineAppCandidatesForTest(undefined);
    setProcessPlatform(platform);
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
  });
  afterEach(() => { Object.defineProperty(process, "arch", { value: HOST_ARCH, configurable: true }); });

  it("reports main's unsupported payload and offers nothing", async () => {
    expect(await installer.getDocumentEngineInstallationState()).toEqual({ phase: "unsupported", version: "26.8.1",
      downloadBytes: fixtures.extension.length, downloadedBytes: 0, installedBytes: 0 });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    expect(await installer.isDocumentEngineAppInstalled()).toBe(false);
  });

  it("refuses the install before any network step, signature check or write", async () => {
    await expect(installer.installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported-platform" });
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.verifyPlatform).not.toHaveBeenCalled();
    expect(fixtures.system).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

  it("refuses a receipt of this build's own kind and removes nothing", async () => {
    await placeLegacyPayload(JSON.stringify({ schema: 3, slot: LEGACY_SLOT }));
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual(expect.arrayContaining([LEGACY_SLOT, "installation.json"]));
    expect(await installer.getDocumentEngineInstallationState()).toEqual({ phase: "unsupported", version: "26.8.1",
      downloadBytes: fixtures.extension.length, downloadedBytes: 0, installedBytes: 0 });
  });
});

describe("a payload main installed", () => {
  beforeEach(() => {
    installer._setDocumentEngineAppCandidatesForTest(undefined);
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
  });
  afterEach(() => { Object.defineProperty(process, "arch", { value: HOST_ARCH, configurable: true }); });

  it("on Linux is offered for removal, removed by uninstall, and the engine stays unsupported", async () => {
    setProcessPlatform("linux");
    const slot = await placeLegacyPayload(legacyReceipt());
    expect(await installer.getDocumentEngineInstallationState()).toEqual({ phase: "unsupported", version: "26.8.1",
      downloadBytes: fixtures.extension.length, downloadedBytes: 0, installedBytes: 0, legacyPayload: true });
    expect(await installer.getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    await installer.uninstallDocumentEngine();
    expect(await readdir(join(home, "document-engine"))).toEqual([]);
    await expect(readFile(join(slot, "program", "soffice.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await installer.getDocumentEngineInstallationState()).toEqual({ phase: "unsupported", version: "26.8.1",
      downloadBytes: fixtures.extension.length, downloadedBytes: 0, installedBytes: 0 });
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another arch", { arch: "arm64" }],
    ["another version", { version: "26.8.2" }],
    ["an extra key", { extra: true }],
    ["a path in the slot name", { slot: "../outside" }],
  ])("on Linux with %s is refused, kept, and not offered", async (_case, overrides) => {
    setProcessPlatform("linux");
    await placeLegacyPayload(legacyReceipt(overrides));
    expect(await installer.getDocumentEngineInstallationState()).not.toHaveProperty("legacyPayload");
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual(expect.arrayContaining([LEGACY_SLOT, "installation.json"]));
  });

  it("on Windows is refused and kept, exactly as main refused any receipt", async () => {
    setProcessPlatform("win32");
    await placeLegacyPayload(legacyReceipt({ platform: "win32" }));
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual(expect.arrayContaining([LEGACY_SLOT, "installation.json"]));
    await placeLegacyPayload(legacyReceipt());
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await installer.getDocumentEngineInstallationState()).not.toHaveProperty("legacyPayload");
  });
});
