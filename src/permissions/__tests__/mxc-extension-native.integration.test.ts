// Native enforcement of the extension container request the host builds: the production request builder and supervisor
// environment, run through the installed SDK. An unconfined run of the same script is the working control.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { MXC_RELEASE_GATE_EVIDENCE } from "../../__tests__/support/mxc-supervisor.js";
import { configureHostResources } from "../../main/host-resources.js";
import { spawnMxcPluginChild } from "../../plugins/isolation/mxc-plugin-child.js";
import { prepareMxcPluginChildLaunch } from "../../plugins/isolation/mxc-plugin-child-launch.js";
import { spawnMxcBundledHolder } from "../../sandbox/wrap-bundled-command.js";
import { resolveHostProgram } from "../../shared/host-program-path.js";
import { windowsSystemRoot } from "../../shared/windows-system-path.js";
import { admitMxcExtensionFilesystem } from "../asrt-sandbox.js";
import { buildMxcConfinedChildRequest } from "../mxc-confined-child-request.js";
import { registerMxcReleaseGateEvidence } from "../mxc-extension-admission.js";
import { mxcSupervisorEnvironment, spawnMxcExtensionProcess, type OwnedMxcExtensionProcess } from "../mxc-extension-process.js";
import { mxcRequestDigest } from "../mxc-extension-protocol.js";
import { planWindowsExtensionHolder } from "../mxc-extension-readiness.js";
import { establishMxcRuntimeRoot } from "../mxc-runtime-root.js";
import { rankMxcFilesystem } from "../mxc-windows.js";
import * as sandboxCapability from "../sandbox-capability.js";

vi.mock("../egress-host-listener.js", async (original) => ({
  ...await original<typeof import("../egress-host-listener.js")>(),
  openMxcEgressLease: async () => ({ url: "http://127.0.0.1:9", port: 9, close: async () => {} }),
}));

vi.mock("../mxc-extension-process.js", async (original) => ({
  ...await original<typeof import("../mxc-extension-process.js")>(),
  spawnMxcExtensionProcess: vi.fn(),
}));

const RUNNER = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk)).on("end", async () => {
  const out = {};
  try {
    const sdk = await import("@microsoft/mxc-sdk/v1");
    const result = await sdk.run({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), timeoutMs: 60000 });
    out.exitCode = result.exitCode;
    out.stdout = result.stdout;
  } catch (error) {
    out.threw = String(error && error.message).slice(0, 400);
  }
  process.stdout.write(JSON.stringify(out));
});`;

function runMxcRequest(env: Record<string, string>, request: unknown): { exitCode?: number; stdout?: string; threw?: string } {
  const child = spawnSync(process.execPath, ["-e", RUNNER], { input: JSON.stringify(request), env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  try {
    return JSON.parse(child.stdout) as ReturnType<typeof runMxcRequest>;
  } catch {
    throw new Error(`Container runner produced no result: status ${String(child.status)} ${child.stderr.slice(0, 400)}`);
  }
}

describe.runIf(process.platform === "win32")("native extension container filesystem boundary", () => {
  it("denies writes outside the grant, through a grandchild and through a junction, and leaves nothing behind", { timeout: 240_000 }, async (context) => {
    configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false });
    await requireMxcCapability(context.skip);
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const shellDirectory = join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
    const shell = join(shellDirectory, "powershell.exe");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-mxc-extension-native-")));
    const granted = join(root, "granted");
    const protectedDirectory = join(granted, "protected");
    const outside = join(root, "outside");
    const denied = join(granted, "denied");
    const staging = join(root, "staging");
    const home = join(staging, "home");
    const temp = join(staging, "temp");
    const junction = join(granted, "link");
    const state = join(root, "supervisor-state");
    try {
      for (const directory of [protectedDirectory, outside, denied, home, temp]) mkdirSync(directory, { recursive: true });
      writeFileSync(join(protectedDirectory, "keep.txt"), "KEEP\n");
      writeFileSync(join(denied, "secret.txt"), "SECRET\n");
      symlinkSync(outside, junction, "junction");

      const write = (label: string, file: string): string =>
        `try { Set-Content -LiteralPath '${file}' -Value x -ErrorAction Stop; '${label}:OK' } catch { '${label}:DENIED' }`;
      const read = (label: string, file: string): string =>
        `try { $null = Get-Content -LiteralPath '${file}' -ErrorAction Stop; '${label}:OK' } catch { '${label}:DENIED' }`;
      const script = [
        write("GRANTED_WRITE", join(granted, "in.txt")),
        write("OUTSIDE_WRITE", join(outside, "direct.txt")),
        `& "$env:SystemRoot\\System32\\cmd.exe" /d /c "echo x> ""${join(outside, "grandchild.txt")}""" 2>$null; 'GRANDCHILD_RAN'`,
        write("JUNCTION_WRITE", join(junction, "through.txt")),
        read("PROTECTED_READ", join(protectedDirectory, "keep.txt")),
        write("PROTECTED_WRITE", join(protectedDirectory, "new.txt")),
        read("DENIED_READ", join(denied, "secret.txt")),
        write("STAGING_WRITE", join(home, "s.txt")),
      ].join("; ");
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      const hostFacts = () => ({
        granted: existsSync(join(granted, "in.txt")),
        outside: readdirSync(outside).sort(),
        protected: readdirSync(protectedDirectory).sort(),
        staging: existsSync(join(home, "s.txt")),
      });
      const reset = (): void => {
        for (const file of [join(granted, "in.txt"), join(outside, "direct.txt"), join(outside, "grandchild.txt"), join(outside, "through.txt"),
          join(protectedDirectory, "new.txt"), join(home, "s.txt")]) rmSync(file, { force: true });
      };
      const lines = (stdout: string): string[] => stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

      // Working control: unconfined, every write and read succeeds.
      const control = spawnSync(shell, args, { encoding: "utf8", windowsHide: true });
      expect(lines(control.stdout)).toEqual(["GRANTED_WRITE:OK", "OUTSIDE_WRITE:OK", "GRANDCHILD_RAN", "JUNCTION_WRITE:OK", "PROTECTED_READ:OK",
        "PROTECTED_WRITE:OK", "DENIED_READ:OK", "STAGING_WRITE:OK"]);
      expect(hostFacts()).toEqual({ granted: true, outside: ["direct.txt", "grandchild.txt", "through.txt"], protected: ["keep.txt", "new.txt"], staging: true });
      reset();

      // The grants come from the production chain: holder admission, ranking, then the validated request.
      const admitted = admitMxcExtensionFilesystem(
        { allowRead: [protectedDirectory, shellDirectory], allowWrite: [granted, staging], denyRead: [denied], denyWrite: [], denyPluginsRoot: true, pinWriteRoots: true },
        { readRoots: [], writeRoots: [granted, staging], hostStorageRoots: [] },
      );
      const grants = rankMxcFilesystem(admitted.model, existsSync);
      expect(grants.denied).toContain(denied);
      const request = buildMxcConfinedChildRequest({
        command: shell,
        args,
        cwd: granted,
        home,
        temp,
        grants,
        baseEnv: { SystemRoot: systemRoot, PATH: join(systemRoot, "System32") },
        proxyUrl: "http://127.0.0.1:9",
      });
      const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const environment = mxcSupervisorEnvironment(base, state);
      const snapshot = (): string => [root, granted, protectedDirectory, outside, denied, staging]
        .map((directory) => spawnSync(join(systemRoot, "System32", "icacls.exe"), [directory], { encoding: "utf8", windowsHide: true }).stdout).join("\n");
      const before = snapshot();
      const confined = runMxcRequest(environment, request);
      expect(confined.threw).toBeUndefined();
      expect(lines(confined.stdout ?? "")).toEqual(["GRANTED_WRITE:OK", "OUTSIDE_WRITE:DENIED", "GRANDCHILD_RAN", "JUNCTION_WRITE:DENIED", "PROTECTED_READ:OK",
        "PROTECTED_WRITE:DENIED", "DENIED_READ:DENIED", "STAGING_WRITE:OK"]);
      expect(hostFacts()).toEqual({ granted: true, outside: [], protected: ["keep.txt"], staging: true });
      expect(readFileSync(join(protectedDirectory, "keep.txt"), "utf8")).toBe("KEEP\n");
      // Nothing is materialised on the host: the access lists are unchanged and the SDK kept its state under the given directory.
      expect(snapshot()).toBe(before);
      expect(readdirSync(root).sort()).toEqual(["granted", "outside", "staging", "supervisor-state"]);

      // A request the backend cannot honour (an egress relay that is not loopback) is refused, not run unconfined.
      reset();
      const refused = runMxcRequest(environment, { ...request, network: { ...request.network, runtimeConfig: { networkProxy: "http://192.0.2.1:8080" } } });
      // Refused for that reason before anything ran: no exit code, no output.
      expect(refused).toEqual({ threw: expect.stringContaining("networkProxy must use localhost") });
      expect(hostFacts()).toEqual({ granted: false, outside: [], protected: ["keep.txt"], staging: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.for(["worker", "mcp-server", "hook", "plugin-child"] as const)(
    "starts a %s with the three exact denies and only its staging write grant", { timeout: 120_000 }, async (role, context) => {
      configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false });
      await requireMxcCapability(context.skip);
      establishMxcRuntimeRoot();
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-holder-native-")));
      const cwd = join(root, "generation");
      mkdirSync(cwd);
      const systemRoot = windowsSystemRoot();
      const command = realpathSync.native(process.env.AVE_TEST_NODE_EXEC_PATH ?? resolveHostProgram("node"));
      const entry = join(cwd, "entry.cjs");
      writeFileSync(entry, `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const root = dirname(process.env.HOME);
writeFileSync(join(root, "ordinary.txt"), "keep");
writeFileSync(join(root, ".ave", "ordinary.txt"), "keep");
for (const leaf of [".agents", ".ave/commands", ".ave/hooks"]) {
  try { mkdirSync(join(root, leaf)); } catch { continue; }
  throw new Error("Created a protected entry: " + leaf);
}
`);
      const args = [entry];
      const baseEnv = { SYSTEMROOT: systemRoot, PATH: join(systemRoot, "System32") };
      const plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
        fallback: { version: "", ready: false } });
      const getPlan = vi.spyOn(sandboxCapability, "getWindowsExtensionBackendPlan").mockReturnValue(plan);
      const unregister = registerMxcReleaseGateEvidence(MXC_RELEASE_GATE_EVIDENCE);
      let release: (() => Promise<void>) | undefined;
      const start = vi.mocked(spawnMxcExtensionProcess);
      start.mockImplementationOnce(async (request, options) => {
        options.beforeSpawn();
        const home = request.environment?.HOME;
        if (home === undefined) throw new Error("The admitted holder request has no HOME");
        const staging = dirname(home);
        const carrier = join(staging, ".ave");
        const protectedPaths = [join(staging, ".agents"), join(carrier, "commands"), join(carrier, "hooks")];
        expect(request.filesystem?.readwritePaths).toEqual([staging]);
        expect(request.filesystem?.deniedPaths).toEqual(expect.arrayContaining(protectedPaths));
        expect(readdirSync(carrier)).toEqual([]);
        const result = runMxcRequest(mxcSupervisorEnvironment({ ...baseEnv, TEMP: tmpdir(), TMP: tmpdir() }, join(root, "state")), request);
        expect(result).toMatchObject({ exitCode: 0 });
        expect(readFileSync(join(staging, "ordinary.txt"), "utf8").trim()).toBe("keep");
        expect(readFileSync(join(carrier, "ordinary.txt"), "utf8").trim()).toBe("keep");
        expect(protectedPaths.some(existsSync)).toBe(false);
        const owned: OwnedMxcExtensionProcess = {
          id: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          completion: new Promise(() => {}),
          diagnostics: { nodeVersion: "", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" },
          startEvidence: { requestDigest: mxcRequestDigest(request), evidence: {
            installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
            uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true,
          } },
          dispose: async () => {},
        };
        options.onOwned?.(owned);
        return owned;
      });
      try {
        if (role === "plugin-child") {
          const intent = { pluginId: "example", cwd, command, args, envelope: { read: [cwd], write: [] }, baseEnv, floorPierces: [] };
          const launch = await prepareMxcPluginChildLaunch({ ...intent, pluginDataDir: join(root, "data") });
          const child = await spawnMxcPluginChild(launch, intent);
          release = async () => { child.link.terminate("fixture complete"); await child.waitForExit(); };
        } else {
          const holder = await spawnMxcBundledHolder({
            label: role, command, args, baseEnv, holderEnv: {}, allowRead: [cwd], ownedReadRoots: [cwd], allowWrite: [],
            egressOwner: { kind: "worker", role, pluginId: role === "worker" ? "example" : undefined },
            ...(role === "worker" ? { workerTransport: "stdio-control-v1" } : {}),
          });
          release = holder.release;
        }
        expect(start).toHaveBeenCalledOnce();
      } finally {
        await release?.();
        start.mockReset();
        getPlan.mockRestore();
        unregister();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
