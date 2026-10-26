import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "./error-message.js";
import { admitWindowsReparse, evaluateWindowsReadDacl, pinWindowsPaths, readWindowsDacls, type WindowsReadDenyPrincipal } from "./windows-path-facts.js";

export type { WindowsReadDenyPrincipal } from "./windows-path-facts.js";

export interface WindowsReadDenyEvidence {
  readonly status: "missing" | "private" | "readable" | "reparse" | "error";
  readonly reason?: string;
  readonly principals?: readonly WindowsReadDenyPrincipal[];
  readonly identity?: { readonly volumeSerialNumber: string; readonly fileId: string };
}

export type WindowsReadDenySnapshot = ReadonlyMap<string, WindowsReadDenyEvidence>;

export function windowsReadDenyKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function windowsReadDenyEvidence(path: string, snapshot?: WindowsReadDenySnapshot): WindowsReadDenyEvidence {
  const evidence = snapshot?.get(windowsReadDenyKey(path));
  if (evidence?.status === "error") return evidence;
  if (snapshot !== undefined && evidence === undefined) return { status: "error", reason: "Target absent from DACL snapshot" };
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) return evidence === undefined || evidence.status === "missing" ? { status: "missing" }
      : { status: "error", reason: "DACL snapshot target no longer exists" };
    if (evidence?.status === "missing") return { status: "error", reason: "DACL snapshot target now exists" };
    if (evidence !== undefined) {
      const pin = pinWindowsPaths([resolve(path)])[0]!;
      if (admitWindowsReparse(pin) && evidence.identity !== undefined
        && stat.dev === BigInt(evidence.identity.volumeSerialNumber) && stat.ino === BigInt(evidence.identity.fileId)
        && pin.exists === true && stat.dev === BigInt(pin.volumeSerialNumber!) && stat.ino === BigInt(pin.fileIndex!)) return evidence;
      return { status: "error", reason: "DACL snapshot target identity is unproven" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (evidence === undefined || evidence.status === "missing")) return { status: "missing" };
    return { status: "error", reason: "DACL snapshot target identity could not be checked" };
  }
  return { status: "error", reason: "DACL snapshot unavailable" };
}

export async function readWindowsReadDenyEvidence(paths: readonly string[]): Promise<WindowsReadDenySnapshot> {
  const targets = [...new Map(paths.map(path => [windowsReadDenyKey(path), resolve(path)])).values()];
  // Each request is atomic: an invalid path cannot erase evidence for other targets.
  return new Map(targets.map(path => {
    let evidence: WindowsReadDenyEvidence;
    try {
      const row = readWindowsDacls([path])[0]!;
      const identity = row.exists === true
        ? { volumeSerialNumber: BigInt(row.volumeSerialNumber!).toString(), fileId: BigInt(row.fileIndex!).toString() } : undefined;
      evidence = !admitWindowsReparse(row) ? { status: "reparse", ...(identity ? { identity } : {}) }
        : row.exists === false ? { status: "missing" } : { ...evaluateWindowsReadDacl(row), identity };
    } catch (error) {
      evidence = { status: "error", reason: errorMessage(error) };
    }
    return [windowsReadDenyKey(path), evidence];
  }));
}
