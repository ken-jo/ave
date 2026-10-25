import type { App } from "electron";
import policy from "../shared/app-relaunch-policy.json" with { type: "json" };

export function relaunchDesktopHost(
  app: Pick<App, "relaunch" | "quit"> & { once(event: "quit", listener: () => void): unknown },
  devLauncher = process.env.AVE_DEV_LAUNCHER === "1",
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (devLauncher) {
    // Return the launcher code only after normal quit cleanup completes.
    app.once("quit", () => exit(policy.devExitCode));
  } else {
    app.relaunch();
  }
  app.quit();
}
