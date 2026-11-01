import path from "node:path";
import { rm, writeFile } from "node:fs/promises";

export function packagedProbeOptions(argv) {
  if (argv.length !== 2 || argv[0] !== "--app" || !path.isAbsolute(argv[1]) || !/\.exe$/i.test(argv[1])) throw new Error("Expected --app <absolute packaged executable>");
  return { executable: path.resolve(argv[1]) };
}

export function handleSnapshot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) throw new Error("Invalid process handle snapshot");
  const count = Number(bytes.readBigUInt64LE(0));
  if (!Number.isSafeInteger(count) || count < 0 || 16 + count * 40 > bytes.length) throw new Error("Invalid process handle snapshot");
  return Array.from({ length: count }, (_, index) => ({ value: bytes.readBigUInt64LE(16 + index * 40), attributes: bytes.readUInt32LE(16 + index * 40 + 32) }));
}

export function stdioObservation(frame) {
  return { ...frame, passed: frame.received === frame.expected && frame.expected === 4 * 1024 * 1024
    && frame.sha256 === frame.expectedSha256 && /^[a-f0-9]{64}$/.test(frame.sha256)
    && Number.isInteger(frame.backpressureWrites) && frame.backpressureWrites > 0
    && frame.stderr === "fixture-input-eof\n" && frame.result?.exitCode === 0 && frame.result?.timedOut === false };
}

export function exactOwnedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Path is outside the owned probe directory");
  return candidate;
}


// Preserve the measured rows and owned path even when cleanup or diagnostic IO
// fails. A finalization failure can never be converted into a measured verdict.
export async function finalizePackagedObservation(result, root, cleanupVerified, io = { remove: rm, write: writeFile }) {
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
  if (cleanupVerified) {
    try {
      await io.remove(root, { recursive: true });
      result.tempRemoved = true;
      return result;
    } catch (error) { failed("remove-temp", error); }
  }
  try {
    await io.write(path.join(root, "observations.json"), JSON.stringify(result, null, 2) + "\n");
  } catch (error) { failed("retain-observations", error); }
  return result;
}
