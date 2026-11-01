import path from "node:path";

export async function finishProcess(record, wait) {
  record.stdin.end();
  const result = await wait(record.completion);
  if (result.error) throw new Error(result.error);
  record.closed = true;
  record.processHandle.dispose();
  record.disposed = true;
  if (result.value.timedOut) throw new Error("SDK process deadline exceeded");
  return { ...result.value, stdout: record.stdout, stderr: record.stderr };
}

export class ProcessIdentityError extends Error {
  constructor(message) { super(message); this.name = "ProcessIdentityError"; }
}

function imageKey(image) {
  return path.win32.normalize(image.replace(/^\\\\\?\\/, "")).toLowerCase();
}

// A failed candidate is closed without becoming eligible for termination.
// The caller supplies a deadline-bound challenge to the toolkit-owned fixture, not untrusted extension code.
export async function pinRuntimeProcesses(native, pids, launchedAfter, runtimePath, confirmLiveness) {
  const candidates = [];
  let lowerBound = launchedAfter;
  try {
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process PID");
      // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE.
      const handle = native.open(0x00101001, false, pid);
      if (!handle) throw new Error("Cannot open fixture process");
      candidates.push(handle);
      const identity = native.identity(handle);
      if (typeof identity.createdAt !== "bigint" || identity.createdAt < lowerBound
        || imageKey(identity.imagePath) !== imageKey(runtimePath) || native.wait(handle, 0) !== 258) {
        throw new Error("Fixture process identity mismatch");
      }
      lowerBound = identity.createdAt;
    }
    // A fresh challenge over the owned child/grandchild pipes also excludes a reused
    // PID belonging to another instance of the same runtime created after launch.
    await confirmLiveness();
    if (candidates.some((handle) => native.wait(handle, 0) !== 258)) throw new Error("Fixture exited before identity confirmation");
    return candidates;
  } catch (error) {
    for (const handle of candidates) native.close(handle);
    throw new ProcessIdentityError(error.message);
  }
}
