import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "./error-message.js";
import { admitWindowsReparse, evaluateWindowsReadDacl, pinWindowsPaths, readWindowsDacls, type WindowsPathFacts, type WindowsReadDenyPrincipal } from "./windows-path-facts.js";

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
  return recheckWindowsReadDenyEvidence([path], snapshot).get(windowsReadDenyKey(path))!;
}

type WindowsEvidenceRow<T> = { value: T } | { error: unknown };

function readIsolatedWindowsRows<T>(paths: readonly string[], read: (paths: readonly string[]) => readonly T[]): WindowsEvidenceRow<T>[] {
  if (paths.length === 0) return [];
  try { return read(paths).map(value => ({ value })); }
  catch (error) {
    if (paths.length === 1) return [{ error }];
    // Native batches are atomic; retry only failed batches so one invalid target cannot erase other rows.
    return paths.flatMap(path => readIsolatedWindowsRows([path], read));
  }
}

/** Recheck one use boundary together; the returned verdicts must not be retained for later uses. */
export function recheckWindowsReadDenyEvidence(paths: readonly string[], snapshot?: WindowsReadDenySnapshot): WindowsReadDenySnapshot {
  const targets = [...new Map(paths.map(path => [windowsReadDenyKey(path), path])).values()];
  const candidates = targets.filter(path => {
    const evidence = snapshot?.get(windowsReadDenyKey(path));
    return evidence !== undefined && evidence.status !== "error" && evidence.status !== "missing";
  });
  const rows = readIsolatedWindowsRows(candidates.map(path => resolve(path)), pinWindowsPaths);
  const pins = new Map(candidates.map((path, index) => [windowsReadDenyKey(path), rows[index]!]));
  return new Map(targets.map(path => [windowsReadDenyKey(path), checkedWindowsReadDenyEvidence(path, snapshot, pins.get(windowsReadDenyKey(path)))]));
}

function checkedWindowsReadDenyEvidence(path: string, snapshot: WindowsReadDenySnapshot | undefined, pinRow?: WindowsEvidenceRow<WindowsPathFacts>): WindowsReadDenyEvidence {
  const evidence = snapshot?.get(windowsReadDenyKey(path));
  if (evidence?.status === "error") return evidence;
  if (snapshot !== undefined && evidence === undefined) return { status: "error", reason: "Target absent from DACL snapshot" };
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) return evidence === undefined || evidence.status === "missing" ? { status: "missing" }
      : { status: "error", reason: "DACL snapshot target no longer exists" };
    if (evidence?.status === "missing") return { status: "error", reason: "DACL snapshot target now exists" };
    if (evidence !== undefined) {
      if (pinRow === undefined || "error" in pinRow) return { status: "error", reason: "DACL snapshot target identity could not be checked" };
      const pin = pinRow.value;
      if (admitWindowsReparse(pin, "evidence") && evidence.identity !== undefined
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
  const rows = readIsolatedWindowsRows(targets, readWindowsDacls);
  return new Map(targets.map((path, index) => {
    let evidence: WindowsReadDenyEvidence;
    try {
      const result = rows[index]!;
      if ("error" in result) throw result.error;
      const row = result.value;
      const identity = row.exists === true
        ? { volumeSerialNumber: BigInt(row.volumeSerialNumber!).toString(), fileId: BigInt(row.fileIndex!).toString() } : undefined;
      evidence = !admitWindowsReparse(row, "evidence") ? { status: "reparse", ...(identity ? { identity } : {}) }
        : row.exists === false ? { status: "missing" } : { ...evaluateWindowsReadDacl(row), identity };
    } catch (error) {
      evidence = { status: "error", reason: errorMessage(error) };
    }
    return [windowsReadDenyKey(path), evidence];
  }));
}
