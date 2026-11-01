// A shared-account profile grant is broader than the caller's admitted read roots.
export class WindowsProfileReadError extends Error {
  readonly code = "srt-win-profile-read-granted";

  constructor() {
    super("A broad srt-win profile read grant is recorded or could not be ruled out on this machine. End sandbox sessions, run srt-win profile forget using the helper that recorded the grant, then restart Ave.");
    this.name = "WindowsProfileReadError";
  }
}

export function assertWindowsProfileReadAbsent(state: "granted" | "absent" | undefined): void {
  if (state === "granted") throw new WindowsProfileReadError();
  if (state !== "absent") throw new Error("Windows sandbox did not report its profile read state");
}
