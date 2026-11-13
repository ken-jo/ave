import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchSeededElectron, quitElectron, teardownSeededElectron } from "./seeded-electron.js";

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

test("graceful shutdown waits for inherited pipes after the native root exits", async () => {
  const ctx = await launchSeededElectron({ historyRows: [] });
  const child = ctx.app.process();
  const readyPath = join(ctx.tempHome, "pipe-holder-ready");
  const releasePath = join(ctx.tempHome, "pipe-holder-release");
  let pipesClosed = false;
  const closed = new Promise<void>(resolve => child.once("close", () => { pipesClosed = true; resolve(); }));
  let closeRequestsAfterExit = 0;
  const close = ctx.app.close.bind(ctx.app);
  ctx.app.close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) closeRequestsAfterExit++;
    await close();
  };
  let quitting: Promise<void> | undefined;
  try {
    const pid = await ctx.app.evaluate(async (_module, paths) => {
      const { spawn } = process.getBuiltinModule("child_process") as typeof import("node:child_process");
      const code = `const fs = require("node:fs");
        const path = require("node:path");
        const release = process.argv[1];
        const watcher = fs.watch(path.dirname(release), () => {
          if (fs.existsSync(release)) watcher.close();
        });
        fs.writeFileSync(process.argv[2], "ready");`;
      const holder = spawn(process.execPath, ["-e", code, paths.releasePath, paths.readyPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit",
      });
      await new Promise<void>((resolve, reject) => { holder.once("spawn", resolve); holder.once("error", reject); });
      holder.unref();
      return holder.pid;
    }, { releasePath, readyPath });
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => existsSync(readyPath)).toBe(true);
    const exited = once(child, "exit");
    let settled = false;
    quitting = quitElectron(ctx.app);
    void quitting.then(() => { settled = true; }, () => { settled = true; });
    await exited;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child.exitCode).toBe(0);
    expect(pipesClosed).toBe(false);
    expect(settled).toBe(false);
    writeFileSync(releasePath, "release");
    await quitting;
    expect(pipesClosed).toBe(true);
    expect(closeRequestsAfterExit).toBe(0);
  } finally {
    writeFileSync(releasePath, "release");
    quitting ??= quitElectron(ctx.app);
    await quitting;
    await closed;
    await teardownSeededElectron(ctx);
  }
});
