import { createRequire, syncBuiltinESMExports } from "node:module";

/** Guard the actual I/O boundary, including calls through reloaded modules. */
export function installWindowsNativeTripwire(
  host: NodeJS.Platform,
  currentSuite: () => string | undefined,
): { restore(): void; takeViolation(): Error | undefined } {
  let violation: Error | undefined;
  if (host === "win32") return { restore() {}, takeViolation: () => undefined };

  const require = createRequire(import.meta.url);
  const os = require("node:os") as typeof import("node:os");
  const platform = os.platform;
  os.platform = () => {
    // Only the native host assertion is guarded. Ordinary platform queries and
    // simulated facts backed by host files retain their normal behavior.
    if (!/[/\\]src[/\\]shared[/\\]windows-native-host\.[cm]?[jt]s:/.test(new Error().stack ?? "")) return platform();
    const error = new Error(
      `Native Windows access from ${currentSuite() ?? "an unknown suite"} on host ${host}. `
      + "Install the per-file factories from src/__tests__/support/simulated-win32-drive.ts.",
    );
    violation ??= error;
    throw error;
  };
  syncBuiltinESMExports();
  return {
    restore() {
      os.platform = platform;
      syncBuiltinESMExports();
    },
    takeViolation() {
      const error = violation;
      violation = undefined;
      return error;
    },
  };
}
