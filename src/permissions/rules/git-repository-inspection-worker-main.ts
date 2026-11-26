import "../../main/bare-program-lookup.js";
import { parentPort, workerData } from "node:worker_threads";
import { adoptHostResources } from "../../main/host-resources.js";
import { inspectGitRepository } from "./git-repository-inputs.js";

// Runs the synchronous evidence walk off the main thread, check for check as in process.
const port = parentPort;
if (port === null) throw new Error("Repository inspection worker requires a parent port");
adoptHostResources((workerData as { hostResources?: unknown } | null)?.hostResources);
port.on("message", (message: unknown) => {
  const request = message as { id?: unknown; cwd?: unknown } | null;
  if (request === null || typeof request !== "object" || !Number.isSafeInteger(request.id) || typeof request.cwd !== "string") {
    throw new Error("Malformed repository inspection request");
  }
  port.postMessage({ id: request.id, result: inspectGitRepository(request.cwd) });
});
