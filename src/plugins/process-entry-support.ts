import { AVE_EXTENSION_NAMESPACE } from "./public-contract.js";

export const PROCESS_ENTRY_UNSUPPORTED_CODE = "process-entry-unsupported";
export const PROCESS_ENTRY_UNSUPPORTED_MESSAGE = "This app cannot run process-entry extensions yet.";

export class ProcessEntryUnsupportedError extends Error {
  readonly code = PROCESS_ENTRY_UNSUPPORTED_CODE;

  constructor() {
    super(PROCESS_ENTRY_UNSUPPORTED_MESSAGE);
    this.name = "ProcessEntryUnsupportedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A process marker identifies an extension, even before its runtime is available. */
export function hasProcessEntry(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.extensions)) return false;
  const extension = document.extensions[AVE_EXTENSION_NAMESPACE];
  return isRecord(extension) && Object.hasOwn(extension, "process");
}

export function assertProcessEntrySupported(document: unknown): void {
  if (hasProcessEntry(document)) throw new ProcessEntryUnsupportedError();
}
