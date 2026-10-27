import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import type { DocumentEngineInstallationError, DocumentEngineInstallationState } from "../shared/document-engine.js";
import { fetchPublicHttpResponse } from "../core/network-guard.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "./storage/feature-namespace.js";
import { assertCodexLocations } from "./codex-executable-location.js";
import { hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { DOCUMENT_ENGINE_IMPORT_EXTENSION, documentEngineReleaseFor, documentEngineSignatureUrl,
  type DocumentEngineRelease } from "./document-engine-release-pins.js";
import { verifyDocumentEnginePlatformSignature, verifyDocumentEngineReleaseSignature } from "./document-engine-signature.js";
import { documentEnginePayloadPaths, documentEngineTreeDigest, extractDocumentEnginePayload,
  readDocumentEngineTree, reconstructDocumentEngineTree, assertDocumentEnginePathIdentities,
  captureDocumentEnginePathIdentity, type DocumentEnginePathIdentity } from "./document-engine-payload.js";

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
  verifyBeforeSpawn(signal: AbortSignal): Promise<void>;
}

interface InstallationReceipt { schema: 1; version: string; platform: string; arch: string; slot: string }
interface DownloadPin { url: string; bytes: number; sha256?: string }

const namespace = openFeatureNamespace("document-engine");
const installations = new Map<string, Promise<VerifiedDocumentEngineInstallation>>();
let networkFetch: typeof fetch | undefined;
let installing = false;
let uninstalling = false;
let lifecycleGeneration = 0;
let transientState: { root: string; state: DocumentEngineInstallationState } | undefined;

/** The host supplies its proxy-aware, credential-free single-hop transport. */
export function initializeDocumentEngineInstallationNetwork(fetchImpl: typeof fetch): void {
  networkFetch = fetchImpl;
}

function releaseState(phase: DocumentEngineInstallationState["phase"], release = documentEngineReleaseFor()): DocumentEngineInstallationState {
  return { phase, version: release?.version ?? "26.8.1", downloadBytes: (release?.bytes ?? 0) + DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes,
    downloadedBytes: phase === "ready" ? (release?.bytes ?? 0) + DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes : 0,
    installedBytes: release?.installedBytes ?? 0 };
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
    const release = documentEngineReleaseFor();
    if (!release || Object.keys(receipt).length !== 5 || receipt.schema !== 1 || receipt.version !== release.version
      || receipt.platform !== release.platform || receipt.arch !== release.arch
      || typeof receipt.slot !== "string" || !/^slot-[a-f0-9-]{36}$/.test(receipt.slot)) throw new Error("Invalid receipt identity");
    return receipt as unknown as InstallationReceipt;
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

async function readSignature(path: string): Promise<string> {
  const handle = await openExecutableFile(path);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > 16_384n) throw new Error("Document engine signature is too large");
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytesRead) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Document engine signature changed during read");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function verifyArchive(slot: string, release: DocumentEngineRelease, signal: AbortSignal): Promise<void> {
  const archive = join(slot, release.filename);
  await verifyFile(archive, release.bytes, release.sha256, signal);
  try { await verifyDocumentEngineReleaseSignature(archive, await readSignature(`${archive}.asc`), signal); }
  catch (error) {
    signal.throwIfAborted();
    throw new DocumentEngineInstallError("signature-failed", "Document engine release signature verification failed", { cause: error });
  }
  if (release.platform === "win32") {
    try { await verifyDocumentEnginePlatformSignature(archive, "win32", signal); }
    catch (error) { throw new DocumentEngineInstallError("signature-failed", "Document engine installer signer is invalid", { cause: error }); }
  }
}

async function withVerifiedArchive<T>(slot: string, release: DocumentEngineRelease, signal: AbortSignal,
  consume: (path: string) => Promise<T>): Promise<T> {
  const path = join(slot, release.filename);
  const held = await openExecutableFile(path);
  try {
    const opened = await held.stat({ bigint: true });
    const identity = captureDocumentEnginePathIdentity(path);
    if (identity.stat.dev !== opened.dev || identity.stat.ino !== opened.ino) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine archive changed during admission");
    }
    await verifyArchive(slot, release, signal);
    assertDocumentEnginePathIdentities([identity]);
    const result = await consume(path);
    assertDocumentEnginePathIdentities([identity]);
    return result;
  } finally { await held.close(); }
}

async function createVerifiedInstallation(receipt: InstallationReceipt, signal: AbortSignal): Promise<VerifiedDocumentEngineInstallation> {
  const generation = lifecycleGeneration;
  const namespaceRoot = namespace.dir;
  let verifiedIdentities: readonly DocumentEnginePathIdentity[] | undefined;
  const assertCurrent = (): void => {
    if (generation !== lifecycleGeneration || namespace.dir !== namespaceRoot || uninstalling) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine installation is no longer current");
    }
    if (verifiedIdentities) {
      try { assertDocumentEnginePathIdentities(verifiedIdentities); }
      catch (error) { throw new DocumentEngineInstallError("integrity-failed", "Document engine payload changed after verification", { cause: error }); }
    }
  };
  const release = documentEngineReleaseFor();
  if (!release) throw new DocumentEngineInstallError("unsupported-platform", "Document engine platform is unsupported");
  const slot = join(namespace.dir, receipt.slot);
  const payload = join(slot, "payload");
  const paths = documentEnginePayloadPaths(payload, release);
  const extensionPath = join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename);
  await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" },
    { path: payload, kind: "private-directory", routeKind: "native" }]);
  const expected = await withVerifiedArchive(slot, release, signal, (archive) => reconstructDocumentEngineTree(archive, release, signal));
  const expectedDigest = documentEngineTreeDigest(expected);
  const installation: VerifiedDocumentEngineInstallation = Object.freeze({ ...paths, version: release.version, assertCurrent,
    extensionPath, extensionSha256: DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256,
    async verifyBeforeSpawn(currentSignal: AbortSignal): Promise<void> {
      try {
        assertCurrent();
        currentSignal.throwIfAborted();
        if (verifiedIdentities) return;
        const identities: DocumentEnginePathIdentity[] = [Object.freeze({ ...captureDocumentEnginePathIdentity(namespaceRoot), ancestor: true }),
          ...[slot, payload, join(slot, release.filename), `${join(slot, release.filename)}.asc`, extensionPath].map(captureDocumentEnginePathIdentity)];
        await verifyArchive(slot, release, currentSignal);
        await verifyFile(extensionPath, DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes, DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256, currentSignal);
        await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" },
          { path: paths.root, kind: "directory", routeKind: "native" },
          { path: paths.executable, kind: "executable", routeKind: release.platform === "linux" ? "guarded-script" : "native" },
          { path: paths.unopkg, kind: "executable", routeKind: release.platform === "linux" ? "guarded-script" : "native" }]);
        if (documentEngineTreeDigest(await readDocumentEngineTree(paths.root, currentSignal, (identity) => identities.push(identity))) !== expectedDigest) {
          throw new DocumentEngineInstallError("integrity-failed", "Document engine payload differs from its authenticated archive");
        }
        try { await verifyDocumentEnginePlatformSignature(paths.executable, release.platform, currentSignal); }
        catch (error) {
          currentSignal.throwIfAborted();
          throw new DocumentEngineInstallError("signature-failed", "Document engine executable signer is invalid", { cause: error });
        }
        assertDocumentEnginePathIdentities(identities);
        verifiedIdentities ??= Object.freeze(identities);
        assertCurrent();
      } catch (error) {
        currentSignal.throwIfAborted();
        if (error instanceof DocumentEngineInstallError) throw error;
        throw new DocumentEngineInstallError("integrity-failed", "Document engine payload verification failed", { cause: error });
      }
    },
  });
  await installation.verifyBeforeSpawn(signal);
  return installation;
}

export async function getVerifiedDocumentEngineInstallation(signal: AbortSignal): Promise<VerifiedDocumentEngineInstallation | null> {
  signal.throwIfAborted();
  if (installing || uninstalling) throw new DocumentEngineInstallError("install-failed", "Document engine installation is changing");
  const generation = lifecycleGeneration;
  const receipt = await readReceipt();
  if (!receipt) return null;
  const key = join(namespace.dir, receipt.slot);
  let pending = installations.get(key);
  if (!pending) {
    pending = createVerifiedInstallation(receipt, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if (error instanceof DocumentEngineInstallError) throw error;
      throw new DocumentEngineInstallError("integrity-failed", "Document engine installation could not be verified", { cause: error });
    });
    installations.set(key, pending);
    pending.catch(() => { if (installations.get(key) === pending) installations.delete(key); });
  }
  const installation = await pending;
  if (generation !== lifecycleGeneration || installing || uninstalling) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation changed during admission");
  installation.assertCurrent();
  return installation;
}

export async function getDocumentEngineInstallationState(): Promise<DocumentEngineInstallationState> {
  if (transientState?.root === namespace.dir && transientState.state.phase !== "ready" && transientState.state.phase !== "absent") {
    return { ...transientState.state };
  }
  if (!documentEngineReleaseFor()) return releaseState("unsupported");
  const receipt = await readReceipt();
  if (receipt) {
    const installation = await getVerifiedDocumentEngineInstallation(new AbortController().signal);
    if (!installation) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation disappeared during verification");
    installation.assertCurrent();
  }
  return releaseState(receipt ? "ready" : "absent");
}

function assertDownloadOrigin(url: URL, extension: boolean): void {
  const allowed = url.protocol === "https:" && !url.username && !url.password && !url.port && (
    extension ? (url.hostname === "github.com" && url.pathname === "/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt")
      || (url.hostname === "release-assets.githubusercontent.com" && url.pathname.startsWith("/github-production-release-asset/"))
      : url.hostname === "download.documentfoundation.org" && url.pathname.startsWith("/libreoffice/stable/26.8.1/"));
  if (!allowed) throw new DocumentEngineInstallError("download-failed", "Document engine download destination is not allowed");
}

async function downloadArtifact(ns: FeatureNamespaceHandle, name: string, pin: DownloadPin, extension: boolean,
  onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  if (!networkFetch) throw new DocumentEngineInstallError("download-failed", "Document engine network transport is not initialized");
  const response = await fetchPublicHttpResponse(pin.url, { fetchImpl: networkFetch, method: "GET", credentials: "omit",
    signal, timeoutMs: TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, maxRedirects: extension ? 2 : 0,
    authorizeTarget: async (url) => assertDownloadOrigin(url, extension), headers: { accept: "application/octet-stream" } });
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

async function downloadSignature(ns: FeatureNamespaceHandle, name: string, release: DocumentEngineRelease, signal: AbortSignal): Promise<void> {
  if (!networkFetch) throw new DocumentEngineInstallError("download-failed", "Document engine network transport is not initialized");
  const response = await fetchPublicHttpResponse(documentEngineSignatureUrl(release), { fetchImpl: networkFetch,
    method: "GET", credentials: "omit", signal, timeoutMs: TOOL_TIMEOUT_POLICY.networkFetchDefaultMs, maxRedirects: 0,
    authorizeTarget: async (url) => assertDownloadOrigin(url, false) });
  if (response.status !== 200 || !response.body) throw new DocumentEngineInstallError("download-failed", "Document engine signature is unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => undefined); };
  const armStall = (): void => {
    clearTimeout(stall);
    stall = setTimeout(() => { stalled = true; void reader.cancel(new Error("Document engine signature download stalled")).catch(() => undefined); },
      TOOL_TIMEOUT_POLICY.documentEngineDownloadStallMs);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    armStall();
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (stalled) throw new DocumentEngineInstallError("download-failed", "Document engine signature download stalled");
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16_384) throw new DocumentEngineInstallError("signature-failed", "Document engine release signature exceeded its limit");
      parts.push(next.value);
      armStall();
    }
  } finally {
    clearTimeout(stall);
    signal.removeEventListener("abort", cancel);
    await reader.cancel(); reader.releaseLock();
  }
  const handle = await ns.createFile(name);
  try { await handle.writeFile(Buffer.concat(parts)); await handle.sync(); }
  finally { await handle.close(); }
}

export async function installDocumentEngine(onProgress: (state: DocumentEngineInstallationState) => void, signal: AbortSignal): Promise<void> {
  if (installing || uninstalling) throw new DocumentEngineInstallError("install-failed", "Document engine installation is already running");
  const release = documentEngineReleaseFor();
  if (!release) throw new DocumentEngineInstallError("unsupported-platform", "Document engine platform is unsupported");
  signal.throwIfAborted();
  installing = true;
  const slotName = `slot-${randomUUID()}`;
  let ownedSlot: string | undefined;
  let published = false;
  const state = releaseState("downloading", release);
  const publish = (): void => { transientState = { root: namespace.dir, state: { ...state } }; onProgress({ ...state }); };
  const controller = new AbortController();
  const handleAbort = (): void => controller.abort(signal.reason);
  const deadline = setTimeout(() => controller.abort(new DocumentEngineInstallError("install-failed", "Document engine installation timed out")),
    TOOL_TIMEOUT_POLICY.documentEngineInstallMs);
  signal.addEventListener("abort", handleAbort, { once: true });
  if (signal.aborted) handleAbort();
  try {
    if (await readReceipt()) throw new DocumentEngineInstallError("install-failed", "Document engine is already installed");
    lifecycleGeneration += 1;
    installations.clear();
    ownedSlot = await namespace.childDir(slotName, { exclusive: true });
    await assertNamespace();
    publish();
    const onBytes = (bytes: number): void => { state.downloadedBytes += bytes; publish(); };
    await downloadArtifact(namespace, `${slotName}/${release.filename}`, release, false, onBytes, controller.signal);
    await downloadSignature(namespace, `${slotName}/${release.filename}.asc`, release, controller.signal);
    await downloadArtifact(namespace, `${slotName}/${DOCUMENT_ENGINE_IMPORT_EXTENSION.filename}`, DOCUMENT_ENGINE_IMPORT_EXTENSION, true, onBytes, controller.signal);
    state.phase = "verifying"; publish();
    await verifyArchive(ownedSlot, release, controller.signal);
    state.phase = "installing"; publish();
    const payload = await namespace.childDir(`${slotName}/payload`);
    await withVerifiedArchive(ownedSlot, release, controller.signal,
      (archive) => extractDocumentEnginePayload(archive, payload, release, controller.signal));
    const receipt: InstallationReceipt = { schema: 1, version: release.version, platform: release.platform, arch: release.arch, slot: slotName };
    const installation = await createVerifiedInstallation(receipt, controller.signal);
    controller.signal.throwIfAborted();
    await namespace.writeJson("installation.json", receipt);
    published = true;
    installations.set(join(namespace.dir, slotName), Promise.resolve(installation));
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
    if (!published && ownedSlot) await fs.rm(ownedSlot, { recursive: true, force: true });
    installing = false;
  }
}

/** The runtime owner must drain converter sessions before calling uninstall. */
export async function uninstallDocumentEngine(beforeRemove?: () => Promise<void>): Promise<void> {
  if (installing || uninstalling) throw new DocumentEngineInstallError("install-failed", "Document engine installation is running");
  uninstalling = true;
  lifecycleGeneration += 1;
  installations.clear();
  try {
    await beforeRemove?.();
    const receipt = await readReceipt();
    if (!receipt) { transientState = undefined; return; }
    const slot = join(namespace.dir, receipt.slot);
    const stat = await fs.lstat(slot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation directory is invalid");
      await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" }]);
      await fs.rm(slot, { recursive: true, force: false });
    }
    await fs.unlink(join(namespace.dir, "installation.json"));
    transientState = { root: namespace.dir, state: releaseState("absent") };
  } finally { uninstalling = false; }
}
