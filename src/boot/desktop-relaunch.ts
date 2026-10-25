import type { App } from "electron";
import policy from "../shared/app-relaunch-policy.json" with { type: "json" };

const scheduledRelaunches = new WeakSet<object>();

export function relaunchDesktopHost(
  app: Pick<App, "relaunch" | "quit"> & { once(event: "quit", listener: () => void): unknown },
  devLauncher = process.env.AVE_DEV_LAUNCHER === "1",
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (scheduledRelaunches.has(app)) throw new Error("relaunch-in-progress");
  scheduledRelaunches.add(app);
  try {
    if (devLauncher) {
      // Return the launcher code only after normal quit cleanup completes.
      app.once("quit", () => exit(policy.devExitCode));
    } else {
      app.relaunch();
    }
  } catch (error) {
    scheduledRelaunches.delete(app);
    throw error;
  }
  try {
    app.quit();
  } catch (error) {
    throw new Error("relaunch-in-progress", { cause: error });
  }
}
