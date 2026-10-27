import { resolveVerifiedExecutable, type VerifiedExecutable } from "./verified-executable.js";
import { win32SystemBinary } from "./windows-system-path.js";

export interface TrustedPowerShellExecutable {
  readonly executable: string;
  readonly kind: "pwsh" | "windows-powershell";
}

const POSIX_INSTALLATIONS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ["/usr/local/microsoft/powershell/7/pwsh"],
  linux: ["/opt/microsoft/powershell/7/pwsh", "/usr/lib/powershell/7/pwsh"],
};
const trustedDescriptors = new WeakMap<VerifiedExecutable, TrustedPowerShellExecutable>();

/** Only fixed, protected installation trees qualify; PATH never supplies authority. */
export function resolveTrustedPowerShellExecutable(platform: NodeJS.Platform = process.platform): TrustedPowerShellExecutable | null {
  const candidates = platform === "win32" ? windowsCandidates() : POSIX_INSTALLATIONS[platform] ?? [];
  const verified = resolveVerifiedExecutable(candidates.map(executable => ({ executable })), platform);
  if (verified === null) return null;
  let descriptor = trustedDescriptors.get(verified);
  if (descriptor === undefined) {
    descriptor = Object.freeze({ ...verified, kind: platform === "win32" ? "windows-powershell" : "pwsh" });
    trustedDescriptors.set(verified, descriptor);
  }
  return descriptor;
}

function windowsCandidates(): readonly string[] {
  try { return [win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe")]; }
  catch { return []; }
}
