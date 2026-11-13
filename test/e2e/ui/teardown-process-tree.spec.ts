import { test, expect } from "@playwright/test";
import { launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("teardown closes the owned process tree when a descendant inherits runtime pipes", async () => {
  const context = await launchSeededElectron({ historyRows: [] });
  try {
    await expect(context.page.getByTestId("main-toolbar")).toBeVisible();
    const pid = await context.app.evaluate(async () => {
      const { spawn } = process.getBuiltinModule("child_process") as typeof import("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      return child.pid;
    });
    expect(pid).toBeGreaterThan(0);
  } finally {
    await teardownSeededElectron(context, { terminate: true });
  }
});
