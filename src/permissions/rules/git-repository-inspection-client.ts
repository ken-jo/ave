import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { mainDir } from "../../main/main-paths.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { GitRepositoryInputs } from "./git-repository-inputs.js";

/** Built next to main.js by scripts/build-main-esbuild.mjs and listed in MAIN_BUNDLE_ROOT_FILES. */
export const GIT_REPOSITORY_INSPECTION_WORKER_FILE = "git-repository-inspection-worker.js";
/** Concurrent inspections beyond this bound are refused instead of queued. */
export const MAX_PENDING_GIT_REPOSITORY_INSPECTIONS = 16;

/** Why an inspection produced no evidence. Every reason is a refusal. */
export type GitRepositoryInspectionRefusal = "queue-full" | "worker-unavailable" | "worker-failed" | "malformed-reply" | "timeout";

interface PendingInspection {
  readonly worker: Worker;
  readonly timer: NodeJS.Timeout;
  readonly settle: (result: GitRepositoryInputs | null) => void;
}

let resident: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<number, PendingInspection>();
let lastRefusal: GitRepositoryInspectionRefusal | undefined;

/** Keeps the process alive only while this worker owes a reply. */
function release(id: number, request: PendingInspection): void {
  pending.delete(id);
  clearTimeout(request.timer);
  if (![...pending.values()].some((other) => other.worker === request.worker)) request.worker.unref();
}

function refuse(id: number, reason: GitRepositoryInspectionRefusal): void {
  const request = pending.get(id);
  if (request === undefined) return;
  release(id, request);
  lastRefusal = reason;
  request.settle(null);
}

/** A failed, exited or misbehaving worker refuses every request it owns; the next request starts a new one. */
function retire(worker: Worker, reason: GitRepositoryInspectionRefusal): void {
  if (resident === worker) resident = undefined;
  for (const [id, request] of [...pending]) if (request.worker === worker) refuse(id, reason);
  void worker.terminate();
}

function isInspectionResult(value: unknown): value is GitRepositoryInputs | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.gitDirectory === "string" && typeof result.workTree === "string"
    && result.referenceBackend === "files" && typeof result.stateFingerprint === "string"
    && Object.keys(result).length === 4;
}

function residentWorker(): Worker {
  if (resident !== undefined) return resident;
  const worker = new Worker(join(mainDir, GIT_REPOSITORY_INSPECTION_WORKER_FILE));
  // An idle inspector never keeps the process alive.
  worker.unref();
  worker.on("message", (message: unknown) => {
    const reply = message as { id?: unknown; result?: unknown } | null;
    const id = reply !== null && typeof reply === "object" && typeof reply.id === "number" ? reply.id : undefined;
    const request = id === undefined ? undefined : pending.get(id);
    if (id === undefined || request === undefined || request.worker !== worker || !isInspectionResult(reply?.result)) {
      retire(worker, "malformed-reply");
      return;
    }
    release(id, request);
    request.settle(reply.result);
  });
  worker.on("error", () => retire(worker, "worker-failed"));
  worker.on("exit", () => retire(worker, "worker-failed"));
  resident = worker;
  return worker;
}

/**
 * Bounded repository evidence without blocking the main thread: the synchronous
 * inspection runs unchanged in one resident worker. Any failure resolves to null.
 */
export function inspectGitRepositoryAsync(cwd: string): Promise<GitRepositoryInputs | null> {
  if (pending.size >= MAX_PENDING_GIT_REPOSITORY_INSPECTIONS) {
    lastRefusal = "queue-full";
    return Promise.resolve(null);
  }
  let worker: Worker;
  try {
    worker = residentWorker();
  } catch {
    lastRefusal = "worker-unavailable";
    return Promise.resolve(null);
  }
  const id = nextRequestId++;
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      refuse(id, "timeout");
      // A worker that missed its deadline may be stuck; replace it.
      retire(worker, "timeout");
    }, TOOL_TIMEOUT_POLICY.gitRepositoryInspectionMs);
    timer.unref();
    pending.set(id, { worker, timer, settle });
    worker.ref();
    try {
      worker.postMessage({ id, cwd });
    } catch {
      retire(worker, "worker-failed");
    }
  });
}

/** The reason for the most recent refusal, for diagnostics and tests. */
export function lastGitRepositoryInspectionRefusal(): GitRepositoryInspectionRefusal | undefined {
  return lastRefusal;
}

/** Stops the resident worker; pending requests are refused and the next request starts a new worker. */
export function disposeGitRepositoryInspectionWorker(): void {
  if (resident !== undefined) retire(resident, "worker-failed");
}
