import { vi } from "vitest";

/** Guard the actual I/O boundary, including calls through reloaded modules. */
export async function installWindowsNativeTripwire(
  host: NodeJS.Platform,
  currentSuite: () => string | undefined,
): Promise<{ restore(): void; takeViolation(): Error | undefined }> {
  let violation: Error | undefined;
  if (host === "win32") return { restore() {}, takeViolation: () => undefined };

  const nativeHost = await import("../../shared/windows-native-host.js");
  const report = (): never => {
    const error = new Error(
      `Native Windows access from ${currentSuite() ?? "an unknown suite"} on host ${host}. `
      + "Install the per-file factories from src/__tests__/support/simulated-win32-drive.ts.",
    );
    violation ??= error;
    throw error;
  };
  const assertion = vi.spyOn(nativeHost, "assertWindowsNativeHost").mockImplementation(report);
  const execution = vi.spyOn(nativeHost, "runWindowsNative").mockImplementation(report);
  return {
    restore() {
      assertion.mockRestore();
      execution.mockRestore();
    },
    takeViolation() {
      const error = violation;
      violation = undefined;
      return error;
    },
  };
}
