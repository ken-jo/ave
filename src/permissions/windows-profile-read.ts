// A shared-account profile grant is broader than the caller's admitted read roots.
export class WindowsProfileReadError extends Error {
  readonly code = "srt-win-profile-read-granted";

  constructor(options?: ErrorOptions) {
    super("A broad srt-win profile read grant is recorded or could not be ruled out on this machine. End sandbox sessions, run srt-win profile forget using the helper that recorded the grant, then restart Ave.", options);
    this.name = "WindowsProfileReadError";
  }
}

export class WindowsProfileReadContractError extends Error {
  readonly code = "srt-win-profile-read-state-missing";

  constructor() {
    super("The sandbox runtime did not report its profile read state.");
    this.name = "WindowsProfileReadContractError";
  }
}

export class WindowsProfileIsolationVerificationError extends Error {
  readonly code = "srt-win-profile-isolation-unverified";

  constructor(options: ErrorOptions) {
    super("Could not verify profile isolation.", options);
    this.name = "WindowsProfileIsolationVerificationError";
  }
}

export function assertWindowsProfileReadAbsent(state: "granted" | "absent" | undefined): void {
  if (state === undefined) throw new WindowsProfileReadContractError();
  if (state !== "absent") throw new WindowsProfileReadError();
}
