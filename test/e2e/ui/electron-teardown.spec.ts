import { test, expect } from "@playwright/test";
import { launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("releases automation after an explicitly terminated fixture", async () => {
  const testInfo = test.info();
  const ctx = await launchSeededElectron({ historyRows: [] });
  const child = ctx.app.process();
  const events: unknown[] = [];
  let closeRequestsAfterExit = 0;
  const close = ctx.app.close.bind(ctx.app);
  ctx.app.close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) closeRequestsAfterExit++;
    await close();
  };
  child.once("exit", (code, signal) => {
    events.push({ event: "exit", code, signal });
    console.log("teardown process exit", { code, signal });
  });
  child.once("close", (code, signal) => {
    events.push({ event: "process-close", code, signal });
    console.log("teardown process close", { code, signal });
  });
  ctx.app.once("close", () => { events.push({ event: "automation-close" }); console.log("teardown automation close"); });
  try {
    await teardownSeededElectron(ctx, { terminate: true });
    expect(child.signalCode).toBe("SIGKILL");
    expect(closeRequestsAfterExit).toBe(0);
  } finally {
    await testInfo.attach("teardown-events", { body: JSON.stringify(events, null, 2), contentType: "application/json" });
  }
});
