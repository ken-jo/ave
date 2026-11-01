import path from "node:path";
import { lstat, readdir, rm, writeFile } from "node:fs/promises";
import { withOrdinaryFilesystem } from "./packaged-filesystem.mjs";

export function packagedProbeOptions(argv) {
  if (argv.length !== 2 || argv[0] !== "--app" || !path.isAbsolute(argv[1]) || !/\.exe$/i.test(argv[1])) throw new Error("Expected --app <absolute packaged executable>");
  return { executable: path.resolve(argv[1]) };
}

export function handleSnapshot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error("Invalid process handle snapshot");
  const count = Number(bytes.readBigUInt64LE(0));
  if (!Number.isSafeInteger(count) || count < 0 || 16 + count * 40 > bytes.length) throw new Error("Invalid process handle snapshot");
  return Array.from({ length: count }, (_, index) => ({ value: bytes.readBigUInt64LE(16 + index * 40), objectTypeIndex: bytes.readUInt32LE(16 + index * 40 + 28), attributes: bytes.readUInt32LE(16 + index * 40 + 32) }));
}

export function stdioObservation(frame) {
  return { ...frame, passed: frame.received === frame.expected && frame.expected === 4 * 1024 * 1024
    && frame.sha256 === frame.expectedSha256 && /^[a-f0-9]{64}$/.test(frame.sha256)
    && frame.stderr === "fixture-input-eof\n" && frame.result?.exitCode === 0 && frame.result?.timedOut === false };
}

export function cancellationObservation(frame, accounting) {
  const container = accounting.processObservations.find((record) => record.role === "container");
  const containerObservationComplete = !!container;
  return { ...frame, ...accounting, containerObservationComplete,
    passed: frame.pending === true && frame.name === "MxcProcessContractError"
      && accounting.exit.code === 0 && !accounting.exit.signal && accounting.processDeathVerified === true
      && containerObservationComplete && container.signaled === true,
    ...(!containerObservationComplete ? { inconclusive: "Native container process object was not independently duplicated" }
      : frame.pending === true ? {} : { inconclusive: "Cancellation did not overlap the native spawn await" }) };
}

export class PackagedImageQueryError extends Error {
  constructor(createdAt, win32Error) {
    super(`Cannot query measured process identity: QueryFullProcessImageNameW failed (${win32Error})`);
    this.name = "PackagedImageQueryError";
    this.createdAt = createdAt;
    this.win32Error = win32Error;
  }
}

export function pinnedProcessIdentity(native, handle, expectedPid, pinTime) {
  const actualPid = native.pid(handle);
  if (actualPid !== expectedPid) throw new Error(`Measured process PID mismatch; possible handle-lifetime race: expected ${expectedPid}, got ${actualPid}`);
  try { return native.identity(handle); }
  catch (error) {
    // Only an image-query failure after a successful native time query can use
    // live pin-time image evidence. A running or unidentifiable object fails.
    if (!(error instanceof PackagedImageQueryError) || !pinTime || native.wait(handle, 0) !== 0) throw error;
    if (pinTime.pid !== expectedPid || typeof error.createdAt !== "bigint" || error.createdAt <= 0n
      || error.createdAt.toString() !== pinTime.createdAt) throw new Error("Duplicated container creation time mismatch", { cause: error });
    if (pinTime.aliveAtPinTime !== true || typeof pinTime.imagePath !== "string"
      || !path.win32.isAbsolute(pinTime.imagePath) || typeof pinTime.expectedImagePath !== "string"
      || !path.win32.isAbsolute(pinTime.expectedImagePath)) throw new Error("Missing live pin-time image evidence", { cause: error });
    if (path.win32.normalize(pinTime.imagePath).toLowerCase() !== path.win32.normalize(pinTime.expectedImagePath).toLowerCase()) {
      throw new Error("Duplicated container pin-time image mismatch", { cause: error });
    }
    return { createdAt: error.createdAt, imagePath: pinTime.imagePath,
      identityEvidence: "exited-before-duplication: pid+createdAt+pin-time image", imageQueryErrorCode: error.win32Error };
  }
}

// Observation pins deliberately lack mutation rights. Emergency cleanup opens
// separate authority and compares the actual objects before terminating one.
export function terminatePinnedProcess(native, pin, exitCode) {
  if (native.wait(pin, 0) === 0) return;
  const handle = native.open(0x101001, false, native.pid(pin));
  if (!handle) {
    if (native.wait(pin, 0) === 0) return;
    throw new Error("Cannot open pinned process for cleanup");
  }
  try {
    if (!native.sameProcess(pin, handle)) throw new Error("Cleanup process object mismatch");
    if (!native.terminate(handle, exitCode) && native.wait(pin, 0) !== 0) throw new Error("Pinned process cleanup termination failed");
  } finally { native.close(handle); }
}

// Only handles of the owner's object type are candidates for inheritance. Some
// unrelated object types cannot be duplicated even by their owning process.
export function inspectOwnerHandleCandidates(owner, candidates, native) {
  if (!Number.isSafeInteger(owner.objectTypeIndex) || owner.objectTypeIndex <= 0) throw new Error("Invalid owner handle object type");
  let inspected = 0;
  for (const item of candidates) {
    if (item.objectTypeIndex !== owner.objectTypeIndex) continue;
    const copied = native.duplicate(item.value);
    if (copied === null) throw new Error("Same-type child handle changed during snapshot; non-inheritance inconclusive");
    try {
      const status = native.compare(copied);
      inspected++;
      if (status === 0) return { inherited: true, inspected };
      if (status !== 0xc00001ac) throw new Error(`Handle comparison failed: 0x${status.toString(16)}`);
    } finally { native.close(copied); }
  }
  if (inspected === 0) throw new Error("No owner-type descendant handles inspected; non-inheritance inconclusive");
  return { inherited: false, inspected };
}

export function ownerHandleObservationPassed(observation) {
  return observation.supervisorInheritable === false && Array.isArray(observation.descendants)
    && observation.descendants.length > 0 && observation.descendants.every((entry) => entry.inherited === false
      && Number.isSafeInteger(entry.inspected) && entry.inspected > 0);
}

export function plantedDllRejected(failure, relativePath) {
  const key = (value) => value.replace(/\\/g, "/").toLowerCase();
  return failure?.name === "MxcIntegrityError" && typeof failure.message === "string"
    && key(failure.message).endsWith(key(relativePath));
}

export async function retainedTreeSize(root, excludedFile) {
  return withOrdinaryFilesystem(() => ordinaryTreeSize(root, excludedFile));
}

async function ordinaryTreeSize(root, excludedFile) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (file === excludedFile) continue;
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("Cannot size redirected retained evidence");
    total += info.isDirectory() ? await ordinaryTreeSize(file, excludedFile) : info.size;
    if (!Number.isSafeInteger(total)) throw new Error("Retained evidence size exceeds integer bound");
  }
  return total;
}

export function exactOwnedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Path is outside the owned probe directory");
  return candidate;
}


// Preserve the measured rows and owned path even when cleanup or diagnostic IO
// fails. A finalization failure can never be converted into a measured verdict.
export async function finalizePackagedObservation(result, root, cleanupVerified, io = { remove: rm, write: writeFile, measure: retainedTreeSize }) {
  // Missing launch evidence is unknown, never proof that no process existed.
  result.spawned = result.spawned !== false;
  result.retainedTempRemovalSafe = result.spawned === false || (cleanupVerified
    && Array.isArray(result.processCleanup) && result.processCleanup.length > 0
    && result.processCleanup.every((record) => record.cleanupDeathVerified === true && !record.cleanupError)
    && Array.isArray(result.unverifiedProcesses) && result.unverifiedProcesses.length === 0);
  result.temp = root;
  result.cleanupVerified = cleanupVerified;
  result.nativeVerified = result.observations.length === 6 && result.observations.every((row) => row.passed) && cleanupVerified;
  result.verdict = result.nativeVerified ? "measured" : "inconclusive";
  result.tempRemoved = false;
  const failed = (stage, error) => {
    result.finalizationErrors ??= [];
    result.finalizationErrors.push({ stage, message: error instanceof Error ? error.message : String(error) });
    result.cleanupVerified = false; result.nativeVerified = false; result.verdict = "inconclusive";
  };
  if (result.nativeVerified) {
    try {
      await withOrdinaryFilesystem(() => io.remove(root, { recursive: true }));
      result.tempRemoved = true;
      result.tempSizeBytes = 0;
      return result;
    } catch (error) { failed("remove-temp", error); }
  }
  const file = path.join(root, "observations.json");
  const measure = io.measure ?? retainedTreeSize;
  let baseSize;
  try {
    baseSize = await measure(root, file);
    result.tempSizeBytes = baseSize;
    // Include the evidence file itself. Only the decimal field width changes
    // between iterations, so the serialized byte count reaches a fixed point.
    for (let count = 0; count < 16; count++) {
      const total = baseSize + Buffer.byteLength(JSON.stringify(result, null, 2) + "\n");
      if (!Number.isSafeInteger(total)) throw new Error("Retained evidence size exceeds integer bound");
      if (total === result.tempSizeBytes) break;
      result.tempSizeBytes = total;
      if (count === 15) throw new Error("Retained evidence size did not settle");
    }
  } catch (error) {
    result.tempSizeBytes = null;
    failed("size-temp", error);
  }
  try {
    await io.write(file, JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    failed("retain-observations", error);
    try { result.tempSizeBytes = await measure(root); }
    catch (sizeError) { result.tempSizeBytes = null; failed("size-temp", sizeError); }
  }
  return result;
}
