import { randomUUID } from "node:crypto";
import type { DocumentObservationEngine } from "../shared/agent-observation.js";
import { acquireParseSlot } from "../tools/preview-document-process.js";
import { parseObservedTextDocument } from "./text-document.js";

/** Reuse the existing bounded parser process; the observer has no serializer. */
export function createTableObservationEngine(): DocumentObservationEngine {
  const owner = `observation:${randomUUID()}`;
  let request = 0;
  return {
    id: "table-reader",
    async parse(bytes, format, sheetIndex, signal, context) {
      signal.throwIfAborted();
      if (format === "text") {
        if (sheetIndex !== 0) throw new Error("Invalid observed text selection.");
        return parseObservedTextDocument(bytes);
      }
      if (context?.parse) return context.parse(bytes, format, sheetIndex, signal);
      const controller = new AbortController();
      const handleAbort = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) handleAbort();
      try {
        const slot = await acquireParseSlot(`${owner}:${++request}`, controller);
        try { return await slot.parse(bytes, format, sheetIndex); }
        finally { slot.release(); }
      } finally {
        signal.removeEventListener("abort", handleAbort);
      }
    },
  };
}
