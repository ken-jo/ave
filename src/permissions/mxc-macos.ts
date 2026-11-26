import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { SandboxMacContainerShellSupport, SandboxMacContainerShellUnavailableReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { launcherPathFor, pinnedLauncherSha256 } from "./mxc-launcher.js";
import { posixPolicyLookups, rankPosixContainerRows } from "./mxc-posix.js";
import { requireMxcContainerStartRoot } from "./mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "./policy-model.js";
import { buildSeatbeltDenySuffix } from "./seatbelt-deny-suffix.js";

const PROFILE_BEGIN = "Seatbelt: --- begin generated profile ---";
const PROFILE_END = "Seatbelt: --- end generated profile ---";

class SeatbeltProfileError extends Error {
  readonly code = "profile-unreadable";

  constructor() {
    super("Could not read the generated container profile");
    this.name = "SeatbeltProfileError";
  }
}

export function parseSeatbeltProfile(output: string): string {
  let begin = -1;
  let end = -1;
  const lines = output.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === PROFILE_BEGIN) {
      if (begin !== -1 || end !== -1) throw new SeatbeltProfileError();
      begin = index;
    } else if (line === PROFILE_END) {
      if (begin === -1 || end !== -1) throw new SeatbeltProfileError();
      end = index;
    }
  }

  if (begin === -1 || end === -1) throw new SeatbeltProfileError();
  const profile = `${lines.slice(begin + 1, end).join("\n")}\n`;
  if (!profile.startsWith("(version 1)\n(deny default)\n")) throw new SeatbeltProfileError();
  return profile;
}

type CanaryVerdict = "available" | "request-rejected" | "shell-start-failed";

interface MacShellProbeDependencies {
  readonly arch: string;
  launcherPath(): string | undefined;
  exists(path: string): boolean;
  verifyPin(path: string): Promise<boolean>;
  requireRuntimeRoot(): string;
  canary(launcher: string, root: string): Promise<CanaryVerdict>;
}

async function detectMxcMacShellSupport(deps: MacShellProbeDependencies): Promise<SandboxMacContainerShellSupport> {
  const unavailable = (reason: SandboxMacContainerShellUnavailableReason): SandboxMacContainerShellSupport =>
    ({ state: "unavailable", reason });
  if (deps.arch !== "arm64") return unavailable("unsupported-arch");
  const launcher = deps.launcherPath();
  if (launcher === undefined || !deps.exists(launcher)) return unavailable("binary-missing");
  if (!await deps.verifyPin(launcher)) return unavailable("launcher-mismatch");
  let root: string;
  try {
    root = deps.requireRuntimeRoot();
  } catch {
    return unavailable("runtime-root-unproved");
  }
  const verdict = await deps.canary(launcher, root);
  return verdict === "available" ? { state: "available" } : unavailable(verdict);
}

const verifiedLaunchers = new Map<string, Promise<boolean>>();

function verifyLauncher(launcher: string): Promise<boolean> {
  const previous = verifiedLaunchers.get(launcher);
  if (previous !== undefined) return previous;
  const verified = readFile(launcher).then(
    bytes => createHash("sha256").update(bytes).digest("hex") === pinnedLauncherSha256("darwin-arm64"),
    () => false,
  );
  verifiedLaunchers.set(launcher, verified);
  return verified;
}

export function detectHostMxcMacShellSupport(resourcePath: string, signal?: AbortSignal): Promise<SandboxMacContainerShellSupport> {
  signal?.throwIfAborted();
  if (!isAbsolute(resourcePath)) throw new Error("Container launcher resources must be absolute");
  return detectMxcMacShellSupport({
    arch: process.arch,
    launcherPath: () => launcherPathFor(resourcePath, "darwin", process.arch),
    exists: existsSync,
    verifyPin: verifyLauncher,
    requireRuntimeRoot: requireMxcContainerStartRoot,
    async canary(launcher, root) {
      try {
        return await runSeatbeltCanary(launcher, root, signal);
      } catch {
        signal?.throwIfAborted();
        return "shell-start-failed";
      }
    },
  });
}

const CANARY_CONTROL = "container-shell-control\n";

interface SeatbeltCanaryEvidence {
  readonly status: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly control: string | null;
  readonly outsideWrite: boolean;
  readonly otherPortConnected: boolean;
  readonly protectedParentInPlace: boolean;
}

function seatbeltCanaryPassed(evidence: SeatbeltCanaryEvidence): boolean {
  return evidence.status === 0 && !evidence.timedOut && evidence.stdout === CANARY_CONTROL
    && evidence.control === CANARY_CONTROL && !evidence.outsideWrite
    && !evidence.otherPortConnected && evidence.protectedParentInPlace;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Invalid container probe listener"));
      else resolve(address.port);
    });
  });
}

const canaryShellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function runCanaryRequest(launcher: string, config: string, flags: readonly string[], signal?: AbortSignal):
Promise<Pick<SeatbeltCanaryEvidence, "status" | "timedOut" | "stdout"> & { stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(launcher, [...flags, "--config", config], {
      cwd: dirname(launcher),
      env: buildSafeChildEnv(),
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_POLICY.mxcMacShellProbeMs + TOOL_TIMEOUT_POLICY.mxcMacShellProbeGraceMs,
      signal,
    }, (error, stdout, stderr) => {
      if (signal?.aborted || (error && typeof error.code !== "number" && !error.killed)) {
        reject(error);
      } else {
        resolve({
          status: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          timedOut: error?.killed === true,
          stdout, stderr,
        });
      }
    });
  });
}

async function runSeatbeltCanary(launcher: string, root: string, signal?: AbortSignal): Promise<CanaryVerdict> {
  let scratch: string | undefined;
  let otherPortConnected = false;
  const proxy = createServer(socket => socket.destroy());
  const other = createServer(socket => { otherPortConnected = true; socket.destroy(); });
  try {
    scratch = await mkdtemp(join(root, "shell-probe-"));
    const fixture = join(scratch, "fixture");
    const working = join(fixture, "project");
    const sealed = join(fixture, "sealed");
    const opened = join(sealed, "open");
    const parent = join(working, "control-parent");
    const protectedChild = join(parent, "protected");
    await mkdir(protectedChild, { recursive: true, mode: 0o700 });
    await mkdir(opened, { recursive: true, mode: 0o700 });
    const protectedFile = join(sealed, "secret");
    const outsideWrite = join(sealed, "new-file");
    const control = join(working, "control");
    const renamed = join(working, "renamed");
    await writeFile(protectedFile, "canary-sealed-file\n", { flag: "wx", mode: 0o600 });

    const lookups = posixPolicyLookups(working, existsSync(join(scratch, "FIXTURE")));
    const floors = [
      policyFloorRow(sealed, "denied", "read-boundary", true),
      policyFloorRow(protectedChild, "ro", "protected-name", true),
    ];
    const grants = rankPosixContainerRows(buildPolicyModel({
      floors, userGrants: [], extensionManifests: [],
      launchGrants: [
        policyGrantRow(fixture, "ro", "launch-grant", true),
        policyGrantRow(working, "rw", "launch-grant", true),
        policyGrantRow(opened, "ro", "launch-grant", true),
      ],
    }), "seatbelt", lookups);
    const suffix = buildSeatbeltDenySuffix({ literals: floors, patterns: [], writeRoots: [working], lookups });
    const proxyPort = await listenOnLoopback(proxy);
    const otherPort = await listenOnLoopback(other);
    const config = join(scratch, "canary.json");
    const request = {
      version: "1.0.0",
      containment: "seatbelt",
      process: {
        commandLine: "/usr/bin/true", cwd: working, timeout: TOOL_TIMEOUT_POLICY.mxcMacShellProbeMs,
        inheritDefaultEnv: false, env: [`HOME=${working}`, "PATH=/usr/bin:/bin"],
      },
      filesystem: { readwritePaths: grants.readwrite, readonlyPaths: grants.readonly, deniedPaths: grants.denied },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      runtimeConfig: { networkProxy: `http://127.0.0.1:${proxyPort}` },
      seatbelt: { nestedPty: false },
      ui: { disable: true, clipboard: "none", injection: false },
    };

    const commandLine = [
      `printf '%s' ${canaryShellArg(CANARY_CONTROL)} > ${canaryShellArg(control)} || exit 11`,
      `/bin/cat ${canaryShellArg(control)} || exit 12`,
      `if /bin/cat ${canaryShellArg(protectedFile)}; then exit 13; fi`,
      `if (printf x > ${canaryShellArg(outsideWrite)}); then exit 14; fi`,
      `/usr/bin/nc -z -w 1 127.0.0.1 ${proxyPort} || exit 15`,
      `if /usr/bin/nc -z -w 1 127.0.0.1 ${otherPort}; then exit 16; fi`,
      `if /bin/mv ${canaryShellArg(parent)} ${canaryShellArg(renamed)}; then exit 17; fi`,
    ].join("\n");
    await writeFile(config, JSON.stringify({ ...request, process: { ...request.process, commandLine } }), {
      flag: "wx", mode: 0o600,
    });
    const dryRun = await runCanaryRequest(launcher, config, ["--dry-run"], signal).catch(() => {
      signal?.throwIfAborted();
      return null;
    });
    if (dryRun === null || dryRun.status !== 0 || dryRun.timedOut) return "request-rejected";

    await writeFile(config, JSON.stringify(request));
    const debugRun = await runCanaryRequest(launcher, config, ["--debug"], signal);
    if (debugRun.status !== 0 || debugRun.timedOut) return "shell-start-failed";
    const profileOverride = parseSeatbeltProfile(`${debugRun.stdout}\n${debugRun.stderr}`) + suffix;
    await writeFile(config, JSON.stringify({
      ...request, process: { ...request.process, commandLine },
      seatbelt: { ...request.seatbelt, profileOverride },
    }));
    const start = await runCanaryRequest(launcher, config, [], signal);
    return seatbeltCanaryPassed({
      ...start,
      control: existsSync(control) ? await readFile(control, "utf8") : null,
      outsideWrite: lstatSync(outsideWrite, { throwIfNoEntry: false }) !== undefined,
      otherPortConnected,
      protectedParentInPlace: existsSync(protectedChild) && !existsSync(renamed),
    }) ? "available" : "shell-start-failed";
  } finally {
    proxy.close();
    other.close();
    if (scratch !== undefined) await rm(scratch, { recursive: true });
  }
}

export {
  detectMxcMacShellSupport as _detectMxcMacShellSupportForTest,
  runSeatbeltCanary as _runSeatbeltCanaryForTest,
  seatbeltCanaryPassed as _seatbeltCanaryPassedForTest,
};
