import { permissionSettingsPath } from "../../../permissions/permission-settings-store.js";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";
import { spawnWorker, type SpawnedWorker } from "../../../permissions/worker-spawn.js";
import { resolvePluginSocketDir, resolvePluginWorkerRunRoot } from "../../plugin-storage-layout.js";
import { derivePluginChildEnvelope, spawnConfinedPluginChild, type ConfinedPluginChild } from "../../isolation/out-of-process-plugin.js";
import { PluginRuntime, createNoopHostApiForTests } from "../../runtime.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";

const PLUGIN_ID = "sandbox-candidate";
let root: string | undefined;
let previousHome: string | undefined;
let child: ConfinedPluginChild | undefined;
let worker: SpawnedWorker | undefined;

class RunningSandboxRuntime extends PluginRuntime {
  register(path: string, pluginRoot: string, dataDir: string) {
    return this.registerSandboxEnvelope(PLUGIN_ID, [path], pluginRoot, dataDir);
  }

  attach(stop: () => Promise<void>, stopWorker: () => void): void {
    this.plugins.set(PLUGIN_ID, {
      manifest: { id: PLUGIN_ID, name: "Sandbox Candidate", version: "1.0.0", entry: "index.mjs", description: "test", tools: [] },
      instance: { handlers: {}, stop },
      methods: new Map(),
      hostEffects: { retire: () => { stopWorker(); return []; } },
    } as never);
  }

  failureKind(): string | undefined {
    return this.loadFailureInfo.get(PLUGIN_ID)?.installFailureKind;
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (existsSync(path) && readFileSync(path, "utf8").includes("ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`confined process did not open ${path}`);
}

afterEach(async () => {
  worker?.stop();
  child?.link.terminate("test cleanup");
  await child?.waitForExit?.();
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  child = undefined;
  worker = undefined;
});

describe("real sandbox ceiling withdrawal", () => {
  for (const retarget of [false, true]) {
    it.runIf(process.platform === "darwin" || process.platform === "linux")(
      retarget
        ? "retires a child and worker with open files after their granted directory is retargeted"
        : "retires a confined child and a delegated worker holding the withdrawn directory",
      async () => {
        if (!(await asrtCanInitialize())) {
          if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT sandbox cannot initialize");
          return;
        }
        root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp", "ave-sr-"));
        previousHome = process.env.AVE_HOME;
        const home = join(root, "home");
        process.env.AVE_HOME = home;
        const approved = join(root, "approved");
        const other = join(root, "other");
        const chosen = retarget ? join(approved, "index") : approved;
        const held = join(approved, "held");
        const pluginRoot = join(home, "plugins", PLUGIN_ID);
        const dataDir = join(pluginRoot, "data");
        mkdirSync(dataDir, { recursive: true });
        mkdirSync(chosen, { recursive: true });
        if (retarget) mkdirSync(other, { recursive: true });
        const settingsPath = permissionSettingsPath(home);
        mkdirSync(join(home, "config"), { mode: 0o700 });
        writeFileSync(settingsPath, JSON.stringify({ permissions: { additionalDirectories: retarget ? [approved, other] : [approved] } }));
        const childFile = join(chosen, "child.txt");
        const workerFile = join(chosen, "worker.txt");
        const childEntryPath = join(pluginRoot, "entry.mjs");
        const workerEntryPath = join(pluginRoot, "worker.cjs");
        writeFileSync(childEntryPath, `import fs from "node:fs"; const fd = fs.openSync(${JSON.stringify(childFile)}, "a"); fs.writeSync(fd, "ready\\n"); setInterval(() => fs.writeSync(fd, "tick\\n"), 20);`);
        writeFileSync(workerEntryPath, `const fs = require("node:fs"); const fd = fs.openSync(${JSON.stringify(workerFile)}, "a"); fs.writeSync(fd, "ready\\n"); setInterval(() => fs.writeSync(fd, "tick\\n"), 20);`);
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        const subject = new RunningSandboxRuntime({
          childEntryPath: pluginChildEntryPath(),
          hostRoot: root,
          manifestPaths: [],
          encryption: unavailableSecretEncryption,
          createHostApi: createNoopHostApiForTests,
        });
        const declaration = { write: [{ kind: "userChosenDirectory" as const, configKey: "workspace", why: "Store project data" }] };
        const chosenPaths: string[] = [];
        const envelope = derivePluginChildEnvelope({
          pluginId: PLUGIN_ID,
          sandbox: declaration,
          pluginRoot,
          pluginDataDir: dataDir,
          configValue: () => chosen,
          onUserChosenDirectory: (path) => chosenPaths.push(path),
        });
        const registration = subject.register(chosenPaths[0]!, pluginRoot, dataDir);
        child = await spawnConfinedPluginChild({
          pluginId: PLUGIN_ID,
          envelope,
          socketDir: resolvePluginSocketDir(dataDir),
          workerRunRoot: resolvePluginWorkerRunRoot(dataDir),
          launch: { kind: "entry", childEntryPath },
          assertStillValid: registration.assertCurrent,
        });
        worker = await spawnWorker({
          pluginId: PLUGIN_ID,
          workerId: "hold",
          command: process.execPath,
          args: [workerEntryPath],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          allowReadPaths: [workerEntryPath, chosen],
          allowWritePaths: [chosen],
        });
        const workerExited = new Promise<void>((resolve) => worker!.onExit(() => resolve()));
        await Promise.all([waitForFile(childFile), waitForFile(workerFile)]);
        subject.attach(async () => {
          child!.link.terminate("approved root withdrawn");
          await child!.waitForExit?.();
          registration.dispose();
        }, () => worker!.stop());
        if (retarget) {
          renameSync(chosen, held);
          symlinkSync(other, chosen, "dir");
          const heldFiles = [join(held, "child.txt"), join(held, "worker.txt")];
          const openSizes = heldFiles.map((path) => readFileSync(path).length);
          await new Promise((resolve) => setTimeout(resolve, 100));
          heldFiles.forEach((path, index) => expect(readFileSync(path).length).toBeGreaterThan(openSizes[index]!));
        }
        writeFileSync(settingsPath, JSON.stringify({ permissions: { additionalDirectories: retarget ? [other] : [] } }));
        expect(registration.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
        expect(await subject.retireSandboxGrantsOutsideCeiling()).toEqual([PLUGIN_ID]);
        await workerExited;
        expect(subject.failureKind()).toBe("sandbox-grant-outside-ceiling");
        const stoppedFiles = retarget ? [join(held, "child.txt"), join(held, "worker.txt")] : [childFile, workerFile];
        const afterRetirement = stoppedFiles.map((path) => readFileSync(path, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(stoppedFiles.map((path) => readFileSync(path, "utf8"))).toEqual(afterRetirement);
      },
      60_000,
    );
  }
});
