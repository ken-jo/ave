import { checkAdminPolicyPath } from "./ave-home-test-guard.js";
import { admitWindowsReparse, readWindowsDacls, windowsPolicyDescriptor, windowsPolicyTrustFailure } from "./windows-path-facts.js";

export { windowsPolicyTrustFailure, type WindowsPolicyDescriptor } from "./windows-path-facts.js";

export class WindowsPolicyReadError extends Error {
  readonly code: string;
  constructor(path: string, cause: string, code = "untrusted-policy") {
    super(`untrusted policy file at ${path} (${cause})`);
    this.name = "WindowsPolicyReadError";
    this.code = code;
  }
}

export async function readWindowsAdminPolicy(path: string): Promise<Buffer> {
  checkAdminPolicyPath(path);
  try {
    const row = readWindowsDacls([path], { parent: true, content: true })[0]!;
    if (!admitWindowsReparse(row, "evidence")) throw new WindowsPolicyReadError(path, "Reparse point refused");
    if (row.exists === false) throw new WindowsPolicyReadError(path, "File not found", "ENOENT");
    if (!row.dacl || !row.parent || row.directory || row.contentHex == null) throw new WindowsPolicyReadError(path, "Incomplete policy snapshot");
    const failure = windowsPolicyTrustFailure(windowsPolicyDescriptor(row.dacl), windowsPolicyDescriptor(row.parent));
    if (failure !== null) throw new WindowsPolicyReadError(path, failure);
    return Buffer.from(row.contentHex, "hex");
  } catch (error) {
    if (error instanceof WindowsPolicyReadError) throw error;
    throw new WindowsPolicyReadError(path, "Policy snapshot could not be read");
  }
}
