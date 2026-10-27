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
  assertDocumentEngineArchiveUnchanged, captureDocumentEnginePathIdentity, readDocumentEngineIdentityDigest,
  type DocumentEnginePathIdentity, type DocumentEnginePayloadPaths } from "./document-engine-payload.js";
import { offlineProcessConfinementImplemented } from "../permissions/offline-confinement-platforms.js";

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

/**
 * Schema 2 records what the one full verification at install time proved: the installed tree's content digest
 * (equal to the authenticated archive's tree) and its metadata identity digest taken around that hash.
 */
interface InstallationReceipt {
  schema: 2; version: string; platform: string; arch: string; slot: string; treeDigest: string; identityDigest: string;
}
interface PayloadDigests { treeDigest: string; identityDigest: string }
interface Admission { readonly promise: Promise<VerifiedDocumentEngineInstallation>; settled: boolean }
interface DownloadPin { url: string; bytes: number; sha256?: string }

const namespace = openFeatureNamespace("document-engine");
/** Per-slot runtime admission; a failed admission stays failed until install or uninstall changes the lifecycle. */
const installations = new Map<string, Admission>();
let networkFetch: typeof fetch | undefined;
let installing = false;
let uninstalling = false;
let lifecycleGeneration = 0;
let transientState: { root: string; state: DocumentEngineInstallationState } | undefined;

/** A release is offered only where its engine can also execute under offline confinement. */
function supportedRelease(): DocumentEngineRelease | undefined {
  return offlineProcessConfinementImplemented() ? documentEngineReleaseFor() ?? undefined : undefined;
}

/** The host supplies its proxy-aware, credential-free single-hop transport. */
export function initializeDocumentEngineInstallationNetwork(fetchImpl: typeof fetch): void {
  networkFetch = fetchImpl;
}

function releaseState(phase: DocumentEngineInstallationState["phase"], release = supportedRelease()): DocumentEngineInstallationState {
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
    const release = supportedRelease();
    const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (!release || Object.keys(receipt).length !== 7 || receipt.schema !== 2 || receipt.version !== release.version
      || receipt.platform !== release.platform || receipt.arch !== release.arch
      || typeof receipt.slot !== "string" || !/^slot-[a-f0-9-]{36}$/.test(receipt.slot)
      || !digest(receipt.treeDigest) || !digest(receipt.identityDigest)) throw new Error("Invalid receipt identity");
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

async function verifyArchiveSignatures(archive: string, release: DocumentEngineRelease, signal: AbortSignal): Promise<void> {
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

/** Hash the pinned archive through a held descriptor, verify its release signature, then let `consume` read it. */
async function withVerifiedArchive<T>(slot: string, release: DocumentEngineRelease, signal: AbortSignal,
  consume: (path: string) => Promise<T>): Promise<T> {
  const path = join(slot, release.filename);
  const held = await openExecutableFile(path);
  try {
    const opened = await held.stat({ bigint: true });
    const identity = captureDocumentEnginePathIdentity(path, "archive");
    if (identity.stat.dev !== opened.dev || identity.stat.ino !== opened.ino) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine archive changed during admission");
    }
    signal.throwIfAborted();
    if (opened.nlink !== 1n || opened.size !== BigInt(release.bytes) || await hashExecutableFile(held) !== release.sha256) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine artifact hash does not match its release pin");
    }
    signal.throwIfAborted();
    await verifyArchiveSignatures(path, release, signal);
    assertDocumentEnginePathIdentities([identity]);
    const result = await consume(path);
    try { await assertDocumentEngineArchiveUnchanged(held, identity, release.sha256); }
    catch (error) { throw new DocumentEngineInstallError("integrity-failed", "Document engine archive changed while it was read", { cause: error }); }
    return result;
  } finally { await held.close(); }
}

async function verifyPlatformSignature(paths: DocumentEnginePayloadPaths, release: DocumentEngineRelease,
  assess: boolean, signal: AbortSignal): Promise<void> {
  try { await verifyDocumentEnginePlatformSignature(paths.executable, release.platform, signal, { assess }); }
  catch (error) {
    signal.throwIfAborted();
    throw new DocumentEngineInstallError("signature-failed", "Document engine executable signer is invalid", { cause: error });
  }
}

async function assertPayloadLocations(slot: string, paths: DocumentEnginePayloadPaths, release: DocumentEngineRelease): Promise<void> {
  await assertCodexLocations([{ path: slot, kind: "private-directory", routeKind: "native" },
    { path: join(slot, "payload"), kind: "private-directory", routeKind: "native" },
    { path: paths.root, kind: "directory", routeKind: "native" },
    { path: paths.executable, kind: "executable", routeKind: release.platform === "linux" ? "guarded-script" : "native" },
    { path: paths.unopkg, kind: "executable", routeKind: release.platform === "linux" ? "guarded-script" : "native" }]);
}

async function assertIdentityDigest(paths: DocumentEnginePayloadPaths, expected: string, signal: AbortSignal): Promise<void> {
  if (await readDocumentEngineIdentityDigest(paths.root, signal) !== expected) {
    throw new DocumentEngineInstallError("integrity-failed", "Document engine payload changed after verification");
  }
}

/**
 * The one full verification, at install time: every payload byte is hashed and compared with the authenticated
 * archive's tree, the executable signer is assessed, and the metadata identity digest taken before the hash must
 * still hold afterwards, binding the recorded identity to the hashed bytes.
 */
async function verifyInstalledPayload(slot: string, release: DocumentEngineRelease, expectedTreeDigest: string,
  signal: AbortSignal): Promise<PayloadDigests> {
  const paths = documentEnginePayloadPaths(join(slot, "payload"), release);
  await assertPayloadLocations(slot, paths, release);
  const identityDigest = await readDocumentEngineIdentityDigest(paths.root, signal);
  const treeDigest = documentEngineTreeDigest(await readDocumentEngineTree(paths.root, signal));
  if (treeDigest !== expectedTreeDigest) {
    throw new DocumentEngineInstallError("integrity-failed", "Document engine payload differs from its authenticated archive");
  }
  await verifyFile(join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename), DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes,
    DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256, signal);
  await verifyPlatformSignature(paths, release, true, signal);
  await assertIdentityDigest(paths, identityDigest, signal);
  return { treeDigest, identityDigest };
}

/**
 * Runtime admission, once per process and slot: the payload's metadata identity must equal the one recorded when
 * its bytes were hashed. macOS additionally relies on the TDF code-signing seal (`codesign --deep --strict` plus the
 * pinned team), which covers every sealed byte without Ave rereading the archive. Platforms without a payload seal
 * reconstruct the authenticated tree from the archive again, so the receipt is never a self-attesting trust root.
 */
async function admitInstalledPayload(slot: string, release: DocumentEngineRelease, receipt: InstallationReceipt,
  signal: AbortSignal): Promise<void> {
  const paths = documentEnginePayloadPaths(join(slot, "payload"), release);
  await assertPayloadLocations(slot, paths, release);
  await verifyFile(join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename), DOCUMENT_ENGINE_IMPORT_EXTENSION.bytes,
    DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256, signal);
  await assertIdentityDigest(paths, receipt.identityDigest, signal);
  if (release.platform === "darwin") await verifyPlatformSignature(paths, release, false, signal);
  else {
    const expected = documentEngineTreeDigest(await withVerifiedArchive(slot, release, signal,
      (archive) => reconstructDocumentEngineTree(archive, release, signal)));
    if (expected !== receipt.treeDigest || documentEngineTreeDigest(await readDocumentEngineTree(paths.root, signal)) !== receipt.treeDigest) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine payload differs from its authenticated archive");
    }
  }
  await assertIdentityDigest(paths, receipt.identityDigest, signal);
}

function bindInstallation(receipt: InstallationReceipt, release: DocumentEngineRelease): {
  installation: VerifiedDocumentEngineInstallation; markAdmitted(): void;
} {
  const generation = lifecycleGeneration;
  const namespaceRoot = namespace.dir;
  const slot = join(namespace.dir, receipt.slot);
  const paths = documentEnginePayloadPaths(join(slot, "payload"), release);
  const extensionPath = join(slot, DOCUMENT_ENGINE_IMPORT_EXTENSION.filename);
  let anchors: readonly DocumentEnginePathIdentity[] | undefined;
  // Synchronous and constant-size: the whole tree is compared asynchronously in verifyBeforeSpawn.
  const assertCurrent = (): void => {
    if (generation !== lifecycleGeneration || namespace.dir !== namespaceRoot || uninstalling) {
      throw new DocumentEngineInstallError("integrity-failed", "Document engine installation is no longer current");
    }
    if (!anchors) throw new DocumentEngineInstallError("integrity-failed", "Document engine installation was not admitted");
    try { assertDocumentEnginePathIdentities(anchors); }
    catch (error) { throw new DocumentEngineInstallError("integrity-failed", "Document engine payload changed after verification", { cause: error }); }
  };
  const installation: VerifiedDocumentEngineInstallation = Object.freeze({ ...paths, version: release.version, assertCurrent,
    extensionPath, extensionSha256: DOCUMENT_ENGINE_IMPORT_EXTENSION.sha256,
    async verifyBeforeSpawn(signal: AbortSignal): Promise<void> {
      try {
        assertCurrent();
        signal.throwIfAborted();
        await assertIdentityDigest(paths, receipt.identityDigest, signal);
        assertCurrent();
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof DocumentEngineInstallError) throw error;
        throw new DocumentEngineInstallError("integrity-failed", "Document engine payload verification failed", { cause: error });
      }
    },
  });
  return {
    installation,
    markAdmitted() {
      anchors = Object.freeze([Object.freeze({ ...captureDocumentEnginePathIdentity(namespaceRoot), ancestor: true as const }),
        ...[slot, join(slot, "payload"), paths.root, paths.executable, paths.unopkg, extensionPath].map((path) => captureDocumentEnginePathIdentity(path))]);
    },
  };
}

function admissionFor(receipt: InstallationReceipt, release: DocumentEngineRelease): Admission {
  const key = join(namespace.dir, receipt.slot);
  const existing = installations.get(key);
  if (existing) return existing;
  const bound = bindInstallation(receipt, release);
  const signal = new AbortController().signal;
  const admission: Admission = {
    settled: false,
    promise: admitInstalledPayload(key, release, receipt, signal).then(() => {
      bound.markAdmitted();
      bound.installation.assertCurrent();
      return bound.installation;
    }, (error: unknown) => {
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
 * An installation being installed or removed is absent to its consumers, which therefore keep the admitted reader;
 * only a present installation that fails verification is an error.
 */
export async function getVerifiedDocumentEngineInstallation(signal: AbortSignal): Promise<VerifiedDocumentEngineInstallation | null> {
  signal.throwIfAborted();
  if (installing || uninstalling) return null;
  const release = supportedRelease();
  if (!release) return null;
  const generation = lifecycleGeneration;
  const receipt = await readReceipt();
  if (!receipt || installing || uninstalling || generation !== lifecycleGeneration) return null;
  let installation: VerifiedDocumentEngineInstallation;
  try { installation = await awaitAdmission(admissionFor(receipt, release).promise, signal); }
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

/** Never blocks on runtime admission: while it runs the installation reports `verifying-installation`. */
export async function getDocumentEngineInstallationState(): Promise<DocumentEngineInstallationState> {
  if (transientState?.root === namespace.dir && transientState.state.phase !== "ready" && transientState.state.phase !== "absent") {
    return { ...transientState.state };
  }
  const release = supportedRelease();
  if (!release) return releaseState("unsupported");
  if (uninstalling) return releaseState("absent");
  const receipt = await readReceipt();
  if (!receipt) return releaseState("absent");
  const admission = admissionFor(receipt, release);
  if (!admission.settled) return releaseState("verifying-installation", release);
  (await admission.promise).assertCurrent();
  return releaseState("ready", release);
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
  const release = supportedRelease();
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
    const payload = await namespace.childDir(`${slotName}/payload`);
    const slot = ownedSlot;
    const extracted = await withVerifiedArchive(slot, release, controller.signal, (archive) => {
      state.phase = "installing"; publish();
      return extractDocumentEnginePayload(archive, payload, release, controller.signal);
    });
    const expected = extracted.sourceTree ?? await withVerifiedArchive(slot, release, controller.signal,
      (archive) => reconstructDocumentEngineTree(archive, release, controller.signal));
    const digests = await verifyInstalledPayload(slot, release, documentEngineTreeDigest(expected), controller.signal);
    const receipt: InstallationReceipt = { schema: 2, version: release.version, platform: release.platform, arch: release.arch,
      slot: slotName, ...digests };
    const bound = bindInstallation(receipt, release);
    bound.markAdmitted();
    controller.signal.throwIfAborted();
    await namespace.writeJson("installation.json", receipt);
    published = true;
    const admission: Admission = { promise: Promise.resolve(bound.installation), settled: true };
    installations.set(join(namespace.dir, slotName), admission);
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
