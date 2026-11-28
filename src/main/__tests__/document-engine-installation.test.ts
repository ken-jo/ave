// The document engine is the LibreOffice the user installed (owner decision 2026-11-28): Ave finds and verifies it,
// and installs, verifies and removes only its own part, the pinned HWP import extension. The cases set the platform to
// macOS, the only one offered.
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const fixtures = vi.hoisted(() => ({
  extension: new TextEncoder().encode("pinned extension"),
  fetch: vi.fn(), verifyPlatform: vi.fn(), system: vi.fn(),
}));

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

describe("the document engine the user installed", () => {
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
    expect(fixtures.verifyPlatform).toHaveBeenCalledWith(app.executable, expect.anything());
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

// Windows and Linux are not offered (Linux: lead decision 2026-11-28, pending the owner): each behaves exactly as main
// did on Windows, before any discovery, download, signature check or receipt action.
describe.each(["win32", "linux"] as const)("the document engine on %s", (platform) => {
  beforeEach(() => {
    installer._setDocumentEngineAppCandidatesForTest(undefined);
    setProcessPlatform(platform);
  });

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

  it("refuses every receipt, as main did, and removes nothing", async () => {
    const slot = "slot-00000000-0000-4000-8000-000000000000";
    await mkdir(join(home, "document-engine", slot), { recursive: true, mode: 0o700 });
    const receipt = join(home, "document-engine", "installation.json");
    await writeFile(receipt, JSON.stringify({ schema: 3, slot }));
    await expect(installer.uninstallDocumentEngine()).rejects.toMatchObject({ code: "integrity-failed" });
    expect(await readdir(join(home, "document-engine"))).toEqual(expect.arrayContaining([slot, "installation.json"]));
    await expect(installer.getDocumentEngineInstallationState()).resolves.toMatchObject({ phase: "unsupported" });
  });
});
