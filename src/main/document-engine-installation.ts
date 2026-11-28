import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, promises as fs, readlinkSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DocumentEngineInstallationError, DocumentEngineInstallationState } from "../shared/document-engine.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "./storage/feature-namespace.js";
import { assertCodexLocations } from "./codex-executable-location.js";
import { hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { DOCUMENT_ENGINE_IMPORT_EXTENSION } from "./document-engine-release-pins.js";
import { verifyDocumentEngineAppSignature } from "./document-engine-signature.js";
import { runDocumentEngineSystemCommand } from "./document-engine-system-command.js";

/**
 * The document engine is LibreOffice as the user installed it, like any other app (owner decision 2026-11-28): Ave
 * neither downloads nor confines it, and the document feature runs only while it is installed. Ave verifies the app it
 * finds (the publisher's code signature on macOS, a system-owned location on Linux) and supplies only the
 * pinned HWP import extension, which it downloads into its own namespace.
 */

export class DocumentEngineInstallError extends Error {
  constructor(readonly code: DocumentEngineInstallationError, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentEngineInstallError";
  }
}

export interface VerifiedDocumentEngineInstallation {
  readonly root: string;
  readonly executable: string;
  readonly unopkg: string;
  readonly version: string;
  readonly extensionPath: string;
  readonly extensionSha256: string;
  assertCurrent(): void;
  /** Verifies the app's recorded identity and the extension bytes read during the recheck. Same-user in-place writes
   * between the recheck and process creation are outside this guarantee on every platform. */
  verifyBeforeSpawn(signal: AbortSignal): Promise<void>;
}

/** Where the app was found; nothing here is trusted until it is admitted. */
interface InstalledApp { readonly root: string; readonly executable: string; readonly unopkg: string }

/** Schema 3 records only Ave's own part: the slot holding the pinned extension. Schema 2 was the Ave-installed engine. */
interface InstallationReceipt { schema: 2 | 3; slot: string }
interface Admission { readonly promise: Promise<VerifiedDocumentEngineInstallation>; settled: boolean }
interface DownloadPin { url: string; bytes: number; sha256?: string }
interface PathIdentity { readonly path: string; readonly stat: BigIntStats; readonly target?: string }

const namespace = openFeatureNamespace("document-engine");
/** Per app identity and slot; a failed admission stays failed until the app, the slot or the lifecycle changes. */
const installations = new Map<string, Admission>();
let networkFetch: typeof fetch | undefined;
let installing = false;
let uninstalling = false;
let lifecycleGeneration = 0;
let transientState: { root: string; state: DocumentEngineInstallationState } | undefined;

/** The host supplies its proxy-aware, credential-free single-hop transport. */
export function initializeDocumentEngineInstallationNetwork(fetchImpl: typeof fetch): void {
  networkFetch = fetchImpl;
}

let candidatesForTest: readonly InstalledApp[] | undefined;

/** @internal tests only: install locations in place of the platform's standard ones. */
export function _setDocumentEngineAppCandidatesForTest(candidates: readonly InstalledApp[] | undefined): void {
  candidatesForTest = candidates;
}

/**
 * The standard install locations of the app, per platform, in preference order; undefined where the engine does not
 * run. Windows is not offered yet: the session's readiness check knows the POSIX single-instance pipe only.
 */
function appCandidates(platform: NodeJS.Platform = process.platform): readonly InstalledApp[] | undefined {
  if (candidatesForTest !== undefined) return candidatesForTest;
  if (platform === "darwin") {
    return ["/Applications/LibreOffice.app", join(homedir(), "Applications", "LibreOffice.app")].map(root => ({
      root, executable: join(root, "Contents", "MacOS", "soffice"), unopkg: join(root, "Contents", "MacOS", "unopkg"),
    }));
  }
  if (platform === "linux") {
    return ["/usr/lib/libreoffice", "/usr/lib64/libreoffice", "/opt/libreoffice"].map(root => ({
      root, executable: join(root, "program", "soffice"), unopkg: join(root, "program", "unopkg"),
    }));
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => undefined);
  return stat?.isFile() === true && (stat.mode & 0o111) !== 0;
}

/** The first candidate whose engine and package tool both exist, canonicalised; undefined when none is installed. */
async function findInstalledApp(): Promise<InstalledApp | undefined> {
  for (const candidate of appCandidates() ?? []) {
    if (!await isExecutableFile(candidate.executable) || !await isExecutableFile(candidate.unopkg)) continue;
    return { root: await fs.realpath(candidate.root), executable: await fs.realpath(candidate.executable),
      unopkg: await fs.realpath(candidate.unopkg) };
  }
  return undefined;
}

/** Whether the user installed LibreOffice where Ave looks for it; nothing is verified or written. */
export async function isDocumentEngineAppInstalled(): Promise<boolean> {
  return await findInstalledApp() !== undefined;
}

function captureIdentity(path: string): PathIdentity {
  const stat = lstatSync(path, { bigint: true });
  return Object.freeze({ path, stat, ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}) });
}

function assertIdentities(identities: readonly PathIdentity[]): void {
  for (const identity of identities) {
    const current = lstatSync(identity.path, { bigint: true });
    const before = identity.stat;
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size || before.mode !== current.mode
      || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs
      || identity.target !== undefined && readlinkSync(identity.path) !== identity.target) {
      throw new Error("Document engine identity changed after verification");
    }
  }
}

/** The app's identity as found: an update or a replacement makes it a different app, admitted afresh. */
function appKey(app: InstalledApp): string {
  return [app.root, app.executable, app.unopkg].map(path => {
    const stat = lstatSync(path, { bigint: true });
    return `${path}\0${stat.dev}\0${stat.ino}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  }).join("\n");
}

async function readAppVersion(app: InstalledApp, signal: AbortSignal): Promise<string> {
  if (process.platform === "darwin") {
    const version = (await runDocumentEngineSystemCommand("/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", join(app.root, "Contents", "Info.plist")], signal)).trim();
    if (!/^\d+(\.\d+){1,3}$/u.test(version)) throw new Error("Document engine version is unreadable");
    return version;
  }
  const text = await fs.readFile(join(app.root, "program", "versionrc"), "utf8");
  const value = (key: string): string | undefined => new RegExp(`^${key}=([^\\r\\n]+)$`, "mu").exec(text)?.[1]?.trim();
  const version = value("MsiProductVersion") ?? value("ProductVersion") ?? value("buildid")?.slice(0, 12);
  if (!version) throw new Error("Document engine version is unreadable");
  return version;
}

/**
 * Admission of the app the user installed, once per app identity: on macOS the publisher's signature (TDF Developer ID
 * and Gatekeeper), on Linux a location only the system can write.
 */
async function admitInstalledApp(app: InstalledApp, signal: AbortSignal): Promise<string> {
  if (process.platform === "darwin") {
    try { await verifyDocumentEngineAppSignature(app.executable, signal); }
    catch (error) {
      signal.throwIfAborted();
      throw new DocumentEngineInstallError("signature-failed", "Document engine executable signer is invalid", { cause: error });
    }
  } else {
    await assertCodexLocations([{ path: app.root, kind: "directory", routeKind: "native" },
      { path: app.executable, kind: "executable", routeKind: "guarded-script" },
      { path: app.unopkg, kind: "executable", routeKind: "guarded-script" }]);
  }
  return readAppVersion(app, signal);
}

async function assertNamespace(): Promise<boolean> {
  try {
    const info = await fs.lstat(namespace.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DocumentEngineInstallError("integrity-failed", "Document engine namespace is not a plain directory");
    await assertCodexLocations([{ path: namespace.dir, kind: "private-directory", routeKind: "native" }]);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readReceipt(): Promise<InstallationReceipt | null> {
  if (!await assertNamespace()) return null;
  const path = join(namespace.dir, "installation.json");
  let handle;
  try { handle = await fs.open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DocumentEngineInstallError("integrity-failed", "Document engine receipt cannot be opened", { cause: error });
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > 4_096n) throw new Error("Invalid receipt file");
    const buffer = Buffer.alloc(4_097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytesRead) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) {
      throw new Error("Receipt changed during read");
    }
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid receipt");
    const receipt = raw as Record<string, unknown>;
    if ((receipt.schema !== 2 && receipt.schema !== 3) || typeof receipt.slot !== "string" || !/^slot-[a-f0-9-]{36}$/.test(receipt.slot)
      || receipt.schema === 3 && Object.keys(receipt).length !== 2) throw new Error("Invalid receipt identity");
    return { schema: receipt.schema, slot: receipt.slot };
  } catch (error) { throw new DocumentEngineInstallError("integrity-failed", "Document engine receipt is invalid", { cause: error }); }
  finally { await handle.close(); }
}

async function verifyFile(path: string, bytes: number, sha256: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const handle = await openExecutableFile(path);
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.nlink !== 1n || stat.size !== BigInt(bytes) || await hashExecutableFile(handle) !== sha256) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine artifact hash does not match its release pin");
    }
  } finally { await handle.close(); }
  signal.throwIfAborted();
}

function stateFor(phase: DocumentEngineInstallationState["phase"], version = ""): DocumentEngineInstallationState {
  const bytes = DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes;
  return { phase, version, downloadBytes: bytes, downloadedBytes: phase === "ready" ? bytes : 0, installedBytes: bytes };
}

function bindInstallation(app: InstalledApp, version: string, slot: string): {
  installation: VerifiedDocumentEngineInstallation; markAdmitted(): void;
} {
  const generation = lifecycleGeneration;
  const namespaceRoot = namespace.dir;
  const extensionPath = join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename);
  let anchors: readonly PathIdentity[] | undefined;
  let failure: DocumentEngineInstallError | undefined;
  const key = admissionKey(app, slot);
  const current = (): boolean => generation === lifecycleGeneration && namespace.dir === namespaceRoot && !uninstalling;
  /** A change found at execution invalidates this admission, so later uses fail with it instead of trusting it. */
  const invalidate = (error: DocumentEngineInstallError): DocumentEngineInstallError => {
    if (!current()) return error;
    failure ??= error;
    const rejected = Promise.reject(failure);
    rejected.catch(() => undefined);
    installations.set(key, { promise: rejected, settled: true });
    return failure;
  };
  const assertCurrent = (): void => {
    if (!current()) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation is no longer current");
    if (failure) throw failure;
    if (!anchors) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation was not admitted");
    try { assertIdentities(anchors); }
    catch (error) {
      throw invalidate(new DocumentEngineInstallError("integrity-failed", "Document engine changed after verification", { cause: error }));
    }
  };
  const installation: VerifiedDocumentEngineInstallation = Object.freeze({ ...app, version, assertCurrent,
    extensionPath, extensionSha256: DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256,
    async verifyBeforeSpawn(signal: AbortSignal): Promise<void> {
      try {
        assertCurrent();
        await verifyFile(extensionPath, DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes, DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256, signal);
        assertCurrent();
      } catch (error) {
        signal.throwIfAborted();
        const refused = error instanceof DocumentEngineInstallError ? error
          : new DocumentEngineInstallError("integrity-failed", "Document engine verification failed", { cause: error });
        throw refused.code === "integrity-failed" || refused.code === "signature-failed" ? invalidate(refused) : refused;
      }
    },
  });
  return {
    installation,
    markAdmitted() {
      anchors = Object.freeze([app.root, app.executable, app.unopkg, slot, extensionPath].map(captureIdentity));
    },
  };
}

function admissionKey(app: InstalledApp, slot: string): string {
  return `${appKey(app)}\n${slot}`;
}

function admissionFor(app: InstalledApp, receipt: InstallationReceipt): Admission {
  const slot = join(namespace.dir, receipt.slot);
  const key = admissionKey(app, slot);
  const existing = installations.get(key);
  if (existing) return existing;
  const signal = new AbortController().signal;
  const admission: Admission = {
    settled: false,
    promise: (async () => {
      await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" }]);
      await verifyFile(join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename), DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes,
        DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256, signal);
      const version = await admitInstalledApp(app, signal);
      const bound = bindInstallation(app, version, slot);
      bound.markAdmitted();
      bound.installation.assertCurrent();
      return bound.installation;
    })().catch((error: unknown) => {
      if (error instanceof DocumentEngineInstallError) throw error;
      throw new DocumentEngineInstallError("integrity-failed", "Document engine installation could not be verified", { cause: error });
    }),
  };
  admission.promise.then(() => { admission.settled = true; }, () => { admission.settled = true; });
  installations.set(key, admission);
  return admission;
}

function awaitAdmission<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The engine is absent to its consumers while it is not installed, while Ave's extension is being installed or removed,
 * or when an earlier Ave-installed engine is all that is recorded; only a present installation that fails verification
 * is an error.
 */
export async function getVerifiedDocumentEngineInstallation(signal: AbortSignal): Promise<VerifiedDocumentEngineInstallation | null> {
  signal.throwIfAborted();
  if (installing || uninstalling || appCandidates() === undefined) return null;
  const generation = lifecycleGeneration;
  const app = await findInstalledApp();
  if (!app) return null;
  const receipt = await readReceipt();
  if (receipt?.schema !== 3 || installing || uninstalling || generation !== lifecycleGeneration) return null;
  let installation: VerifiedDocumentEngineInstallation;
  try { installation = await awaitAdmission(admissionFor(app, receipt).promise, signal); }
  catch (error) {
    signal.throwIfAborted();
    // A lifecycle change invalidates the admission it raced; the installation is then absent, not corrupt.
    if (generation !== lifecycleGeneration || installing || uninstalling) return null;
    throw error;
  }
  if (generation !== lifecycleGeneration || installing || uninstalling) return null;
  installation.assertCurrent();
  return installation;
}

/** Never blocks on admission: while it runs the installation reports `verifying-installation`. */
export async function getDocumentEngineInstallationState(): Promise<DocumentEngineInstallationState> {
  if (transientState?.root === namespace.dir && transientState.state.phase !== "ready" && transientState.state.phase !== "absent") {
    return { ...transientState.state };
  }
  if (appCandidates() === undefined) return stateFor("unsupported");
  const app = await findInstalledApp();
  if (!app) return stateFor("app-missing");
  if (uninstalling) return stateFor("absent");
  const receipt = await readReceipt();
  if (receipt?.schema !== 3) return stateFor("absent");
  const admission = admissionFor(app, receipt);
  if (!admission.settled) return stateFor("verifying-installation");
  const installation = await admission.promise;
  installation.assertCurrent();
  return stateFor("ready", installation.version);
}

function assertDownloadOrigin(url: URL): void {
  const allowed = url.protocol === "https:" && !url.username && !url.password && !url.port && (
    (url.hostname === "github.com" && url.pathname === "/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt")
      || (url.hostname === "release-assets.githubusercontent.com" && url.pathname.startsWith("/github-production-release-asset/")));
  if (!allowed) throw new DocumentEngineInstallError("download-failed", "Document engine download destination is not allowed");
}

async function downloadArtifact(ns: FeatureNamespaceHandle, name: string, pin: DownloadPin,
  onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  if (!networkFetch) throw new DocumentEngineInstallError("download-failed", "Document engine network transport is not initialized");
  const response = await fetchPublicHttpResponse(pin.url, { fetchImpl: networkFetch, method: "GET", credentials: "omit",
    signal, timeoutMs: TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, maxRedirects: 2,
    authorizeTarget: async (url) => assertDownloadOrigin(url), headers: { accept: "application/octet-stream" } });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new DocumentEngineInstallError("download-failed", "Document engine download did not return an artifact");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== pin.bytes) {
    await response.body.cancel();
    throw new DocumentEngineInstallError("integrity-failed", "Document engine download length differs from its release pin");
  }
  const handle = await ns.createFile(name);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let received = 0;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let complete = false;
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  const armStall = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => { stalled = true; void reader.cancel(new Error("Document engine download stalled")).catch(() => undefined); },
      TOOL_TIMEOUT_POLICY.documentEngineDownloadStallMs);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    armStall();
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (stalled) throw new DocumentEngineInstallError("download-failed", "Document engine download stalled");
      if (next.done) break;
      received += next.value.byteLength;
      if (received > pin.bytes) throw new DocumentEngineInstallError("integrity-failed", "Document engine download exceeded its release pin");
      hash.update(next.value);
      await handle.writeFile(next.value);
      onBytes(next.value.byteLength);
      armStall();
    }
    if (received !== pin.bytes || pin.sha256 !== undefined && hash.digest("hex") !== pin.sha256) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine download hash or length does not match its release pin");
    }
    await handle.sync();
    complete = true;
  } finally {
    clearTimeout(stall);
    signal.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel();
    reader.releaseLock();
    await handle.close();
  }
}

/** Remove a recorded slot Ave owns; a link or a non-directory is refused, never followed. */
async function removeSlot(slotName: string): Promise<void> {
  const slot = join(namespace.dir, slotName);
  const stat = await fs.lstat(slot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation directory is invalid");
  await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" }]);
  await fs.rm(slot, { recursive: true, force: false });
}

/**
 * Installs Ave's part, the pinned HWP import extension, beside the LibreOffice the user installed. An engine an earlier
 * Ave version installed into this namespace is removed first: the app the user installed replaces it.
 */
export async function installDocumentEngine(onProgress: (state: DocumentEngineInstallationState) => void, signal: AbortSignal): Promise<void> {
  if (installing || uninstalling) throw new DocumentEngineInstallError("install-failed", "Document engine installation is already running");
  if (appCandidates() === undefined) throw new DocumentEngineInstallError("unsupported-platform", "Document engine platform is unsupported");
  signal.throwIfAborted();
  installing = true;
  const slotName = `slot-${randomUUID()}`;
  let ownedSlot: string | undefined;
  let published = false;
  const state = stateFor("downloading");
  const publish = (): void => { transientState = { root: namespace.dir, state: { ...state } }; onProgress({ ...state }); };
  const controller = new AbortController();
  const handleAbort = (): void => controller.abort(signal.reason);
  const deadline = setTimeout(() => controller.abort(new DocumentEngineInstallError("install-failed", "Document engine installation timed out")),
    TOOL_TIMEOUT_POLICY.documentEngineInstallMs);
  signal.addEventListener("abort", handleAbort, { once: true });
  if (signal.aborted) handleAbort();
  try {
    const app = await findInstalledApp();
    if (!app) throw new DocumentEngineInstallError("app-missing", "LibreOffice is not installed");
    const previous = await readReceipt();
    if (previous?.schema === 3) throw new DocumentEngineInstallError("install-failed", "Document engine is already installed");
    lifecycleGeneration += 1;
    installations.clear();
    if (previous) {
      await removeSlot(previous.slot);
      await fs.unlink(join(namespace.dir, "installation.json"));
    }
    ownedSlot = await namespace.childDir(slotName, { exclusive: true });
    await assertNamespace();
    publish();
    const onBytes = (bytes: number): void => { state.downloadedBytes += bytes; publish(); };
    await downloadArtifact(namespace, `${slotName}/${DOCUMENT_ENGINE_IMPORT_EXTENSION.filename}`, DOCUMENT_ENGINE_IMPORT_EXTENSION, onBytes, controller.signal);
    state.phase = "verifying"; publish();
    const receipt: InstallationReceipt = { schema: 3, slot: slotName };
    const admission = admissionFor(app, receipt);
    const installation = await awaitAdmission(admission.promise, controller.signal);
    state.version = installation.version;
    controller.signal.throwIfAborted();
    await namespace.writeJson("installation.json", receipt);
    published = true;
    state.phase = "ready"; publish();
  } catch (error) {
    const failure = signal.aborted ? new DocumentEngineInstallError("cancelled", "Document engine installation cancelled", { cause: error })
      : error instanceof DocumentEngineInstallError ? error
      : new DocumentEngineInstallError("install-failed", "Document engine installation failed", { cause: error });
    state.phase = "error"; state.error = failure.code; publish();
    throw failure;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", handleAbort);
    if (!published) {
      installations.clear();
      if (ownedSlot) await fs.rm(ownedSlot, { recursive: true, force: true });
    }
    installing = false;
  }
}

/** Removes Ave's part only; the app stays the user's. The runtime owner must drain converter sessions first. */
export async function uninstallDocumentEngine(beforeRemove?: () => Promise<void>): Promise<void> {
  if (installing || uninstalling) throw new DocumentEngineInstallError("install-failed", "Document engine installation is running");
  uninstalling = true;
  lifecycleGeneration += 1;
  installations.clear();
  try {
    await beforeRemove?.();
    const receipt = await readReceipt();
    if (!receipt) { transientState = undefined; return; }
    await removeSlot(receipt.slot);
    await fs.unlink(join(namespace.dir, "installation.json"));
    transientState = { root: namespace.dir, state: stateFor("absent") };
  } finally { uninstalling = false; }
}
