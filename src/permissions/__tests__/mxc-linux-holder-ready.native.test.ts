// What a Linux holder start proves again after the launcher and the gate (review #758 P2-2, P3-4): the placeholder
// folders at the ready byte, and the staged request's bytes after the launcher read them. The chain is real; only the
// two hooks below reach in between its steps, where a host process could act.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import seccompPins from "../mxc-linux-seccomp-pins.json" with { type: "json" };
import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { spawnMxcConfinedChild, type MxcConfinedChildSpawn, type MxcConfinedChildSpec } from "../confined-child.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { setProvenLinuxHolderRoute } from "../linux-holder-route.js";
import { linuxHolderBwrap, requireMxcLinuxShellPrograms } from "../mxc-linux.js";
import { establishLinuxCaptureFolder } from "../mxc-linux-holder-launch.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } from "../sandbox-capability.js";
import { forgetIssuedContainerHome, recordIssuedContainerHome } from "../sandbox-home-registry.js";

const between = vi.hoisted(() => ({
  /** After the launcher's call was recorded, before Ave reads the staged request again. */
  afterTranslate: undefined as ((requestPath: string) => void) | undefined,
  /** After the ready byte, before the start returns. */
  afterReady: undefined as (() => void) | undefined,
}));

vi.mock("../mxc-linux-holder-launch.js", async (actual) => {
  const real = await actual<typeof import("../mxc-linux-holder-launch.js")>();
  return {
    ...real,
    translateLinuxHolderRequest: async (input: Parameters<typeof real.translateLinuxHolderRequest>[0]) => {
      const call = await real.translateLinuxHolderRequest(input);
      between.afterTranslate?.(input.requestPath);
      return call;
    },
    startLinuxHolder: async (...args: Parameters<typeof real.startLinuxHolder>) => {
      const holder = await real.startLinuxHolder(...args);
      between.afterReady?.();
      return holder;
    },
  };
});

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const BWRAP = "/usr/bin/bwrap";
const PATH = "/usr/bin:/bin";

describe.runIf(NATIVE)("native Linux holder start, proved again after the gate", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  let root: string;
  let data: string;
  let cache: string;
  const started: MxcConfinedChildSpawn[] = [];
  const homes: string[] = [];
  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-ready-"));
    data = join(root, "data");
    mkdirSync(data);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    establishMxcRuntimeRoot();
    setPluginWorkerConfinementRequestedAtBoot(true);
    startEgressRelayService({ ask: async () => false });
    const programs = await requireMxcLinuxShellPrograms(resources);
    setProvenLinuxHolderRoute({
      programs, helperSha256: pin, captureFolder: establishLinuxCaptureFolder(requireMxcContainerStartRoot(), programs.helper, pin),
      bwrap: linuxHolderBwrap(BWRAP),
    });
  });
  afterEach(async () => {
    between.afterTranslate = undefined;
    between.afterReady = undefined;
    await Promise.allSettled(started.splice(0).map(holder => holder.release()));
    for (const home of homes.splice(0)) forgetIssuedContainerHome(home);
    setProvenLinuxHolderRoute(undefined);
    __resetSandboxRequestedAtBootForTest();
    await stopEgressRelayService();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    __resetManagedChildProcessesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  function staging() {
    const parent = join(requireMxcContainerStartRoot(), "staging");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = join(parent, randomBytes(16).toString("hex"));
    const home = join(folder, "home");
    const temp = join(folder, "temp");
    for (const path of [folder, home, temp]) mkdirSync(path, { mode: 0o700 });
    recordIssuedContainerHome(home, requireMxcContainerStartRoot());
    homes.push(home);
    return { folder, home, temp };
  }

  /** A hook holder (one run): an absent protected name under its user-folder write root is held with a placeholder. */
  async function spawnHook(script: string): Promise<MxcConfinedChildSpawn> {
    const tree = staging();
    const spec: MxcConfinedChildSpec = {
      command: "/bin/sh", args: ["-c", script], cwd: data, home: tree.home, temp: tree.temp, stagingRoot: tree.folder,
      holder: {}, label: "test:linux-ready", baseEnv: { PATH }, allowRead: [], allowWrite: [data, tree.folder],
      filesystemOwnership: { readRoots: [], writeRoots: [data, tree.folder], hostStorageRoots: [] },
      egressOwner: { kind: "worker", role: "hook", pluginId: "p" } as never,
    };
    const holder = await spawnMxcConfinedChild(spec);
    started.push(holder);
    return holder;
  }

  it("holds a placeholder for the run and starts when nothing changed (control)", async () => {
    let placeholders: string[] = [];
    between.afterReady = () => { placeholders = readdirSync(data); };
    const holder = await spawnHook("exec /bin/cat");
    expect(holder.confinement).toBe("linux-container");
    expect(placeholders).toContain(".vscode");
  });

  it("stops and refuses by name a start whose placeholder folder the host replaced before the ready byte", async () => {
    const replaced = join(data, ".vscode");
    between.afterReady = () => {
      // Moved aside first, so the new folder cannot take the old one's inode number.
      renameSync(replaced, join(root, "moved-aside"));
      mkdirSync(replaced);
    };
    await expect(spawnHook("exec /bin/cat")).rejects.toThrow(`a placeholder folder changed between the gate and the holder's start: ${replaced}`);
    // Stopped and released: the marker and the holder's own folder are gone.
    const markers = join(requireMxcContainerStartRoot(), "holder-markers");
    expect(existsSync(markers) ? readdirSync(markers) : []).toEqual([]);
    expect(readdirSync(requireMxcContainerStartRoot()).filter(name => /^holder-[A-Za-z0-9]{6}$/u.test(name))).toEqual([]);
  });

  it("refuses a start whose staged request changed after the launcher read it, before anything ran", async () => {
    let ran = false;
    between.afterTranslate = (requestPath) => { appendFileSync(requestPath, " "); };
    between.afterReady = () => { ran = true; };
    await expect(spawnHook("exec /bin/cat")).rejects.toThrow("Container start refused (request-rejected): the staged request changed before the launcher's call was checked");
    expect(ran).toBe(false);
  });
});
