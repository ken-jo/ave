import type { DocumentObservationEngine } from "../shared/agent-observation.js";
import { createDocumentObservationEngine, stopDocumentEngineSessions } from "./libreoffice-engine.js";
import { sweepStaleDocumentEngineRuntimes } from "./libreoffice-process.js";

/**
 * The single composition point that names the concrete document engine. Host code (observation runtime, installation
 * IPC, shutdown, boot hygiene) depends only on `DocumentObservationEngine` and these lifecycle functions, so the
 * engine stays replaceable and its process paths stay inside the engine modules.
 */
export function createHostDocumentObservationEngine(): DocumentObservationEngine {
  return createDocumentObservationEngine();
}

/** Drain every engine session before an installation is removed or the app shuts down. */
export function stopHostDocumentEngineSessions(): Promise<void> {
  return stopDocumentEngineSessions();
}

/** Boot hygiene for engine-private temporary directories left by an earlier, no longer running Ave process. */
export async function cleanupStaleDocumentEngineRuntimes(): Promise<number> {
  return (await sweepStaleDocumentEngineRuntimes()).length;
}
