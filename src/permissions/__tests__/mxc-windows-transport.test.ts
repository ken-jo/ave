import net from "node:net";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import * as policyHome from "../../shared/policy-home.js";
import * as hostEgress from "../egress-host-listener.js";
import { getProtectedReadDenyFloor, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { requireMxcPolicyPipeHelper, requireMxcPrerequisites } from "../../__tests__/support/mxc-capability.js";
import * as policyPipe from "../mxc-policy-pipe.js";
import { prepareMxcShellLaunch } from "../../tools/mxc-shell-launch.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { WINDOWS_COMMAND_LINE_LIMIT, WINDOWS_COMMAND_LINE_MARGIN, windowsCommandLineLength } from "../../shared/windows-command-line.js";
import { buildMxcShellRequest, isWindowsPathAtOrUnder, mxcRequestArgs, MXC_REQUEST_CHARACTER_LIMIT, openMxcRequestTransport, parseMxcDryRunOutput, rankMxcFilesystem, resolveHostWxcExecPath } from "../mxc-windows.js";

const LAUNCHER = String.raw`C:\Program Files\Ave\resources\mxc\x64\wxc-exec.exe`;
function request(padding = 0) {
  return buildMxcShellRequest({
    commandLine: "cmd.exe /d /c exit 0", cwd: "C:\\work",
    grants: { readwrite: ["C:\\work"], readonly: [], denied: [] },
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\work", PAD: "x".repeat(padding) },
    proxyUrl: "http://127.0.0.1:9", timeoutMs: 1000,
  });
}

function readPipe(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { text += chunk; });
    socket.once("end", () => resolve(text));
    socket.once("error", reject);
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("request size admission", () => {
  it("counts quoting, trailing backslashes, empty arguments and UTF-16 units", () => {
    expect(windowsCommandLineLength("x", ["", "a b", 'a"b', "a b\\", "😀"]))
      .toBe('x "" "a b" "a\\"b" "a b\\\\" 😀'.length + 1);
  });

  it("keeps inline requests strictly inside the margin and rejects the boundary", async () => {
    const body = request();
    const args = mxcRequestArgs(body, LAUNCHER);
    const length = windowsCommandLineLength(LAUNCHER, args);
    const padding = WINDOWS_COMMAND_LINE_LIMIT - WINDOWS_COMMAND_LINE_MARGIN - length;
    expect(() => mxcRequestArgs(body, LAUNCHER + "x".repeat(padding - 1))).not.toThrow();
    expect(() => mxcRequestArgs(body, LAUNCHER + "x".repeat(padding))).toThrow("Windows sandbox policy is too large:");
    const inline = await openMxcRequestTransport(body, LAUNCHER);
    expect(inline.args).toEqual(args);
    await inline.release();
  });

  it("refuses oversized JSON before opening any server", async () => {
    const create = vi.spyOn(policyPipe, "openMxcPolicyPipe");
    const body = request(MXC_REQUEST_CHARACTER_LIMIT);
    await expect(openMxcRequestTransport(body, LAUNCHER)).rejects.toThrow(
      `Windows sandbox policy is too large: ${JSON.stringify(body).length} characters, limit ${MXC_REQUEST_CHARACTER_LIMIT}`,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("uses distinct names with 128 random bits and preserves the policy bytes", async () => {
    const open = vi.spyOn(policyPipe, "openMxcPolicyPipe").mockResolvedValue({ bindChild: () => {}, release: async () => {} });
    const body = request(25_000);
    const names = new Set<string>();
    for (let index = 0; index < 32; index++) {
      const transport = await openMxcRequestTransport(body, LAUNCHER);
      expect(transport.args[1]).toMatch(/^\\\\\.\\pipe\\ave-mxc-[a-f0-9]{32}$/);
      names.add(transport.args[1]!);
      await transport.release();
    }
    expect(names.size).toBe(32);
    expect(open.mock.calls.every(([bytes]) => bytes.toString("utf8") === JSON.stringify(body))).toBe(true);
  });

  it("fails closed when the native pipe cannot be opened", async () => {
    vi.spyOn(policyPipe, "openMxcPolicyPipe").mockRejectedValue(new Error("pipe already exists"));
    await expect(openMxcRequestTransport(request(25_000), LAUNCHER)).rejects.toThrow(/^Windows sandbox policy pipe could not be opened:/);
  });
});

describe.skipIf(process.platform !== "win32")("named-pipe policy delivery", () => {
  it("withholds policy bytes from an impostor before delivering to the bound child", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const body = request(25_000);
    const transport = await openMxcRequestTransport(body, LAUNCHER);
    const source = `
      const fs = require('node:fs');
      process.stdin.once('data', () => {
        const fd = fs.openSync(process.argv[1], 'r');
        const chunks = [];
        const buffer = Buffer.alloc(1024);
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        fs.closeSync(fd);
        process.stdout.write(Buffer.concat(chunks).toString('base64'));
      });
    `;
    let child: ReturnType<typeof execFile> | undefined;
    try {
      const received = new Promise<string>((resolveRead, reject) => {
        child = execFile(process.execPath, ["-e", source, transport.args[1]!], {
          windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.mxcRequestTransportMs,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }, (error, stdout) => {
          if (error) reject(error);
          else resolveRead(stdout);
        });
        transport.bindChild(child);
      });
      // The server disconnects an impostor before writing, which Node reports as either an empty read or EPIPE.
      const impostor = await readPipe(transport.args[1]!)
        .then((text) => Buffer.byteLength(text), (error: NodeJS.ErrnoException) => error.code);
      expect([0, "EPIPE"]).toContain(impostor);
      child!.stdin!.end("read");
      expect(Buffer.from(await received, "base64")).toEqual(Buffer.from(JSON.stringify(body)));
    } finally {
      child?.kill();
      await transport.release();
    }
  });

  it("preserves full-floor denial coverage and grants while collapsing nested denies", () => {
    const home = String.raw`C:\Users\example`;
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home]);
    const floor = [...getProtectedReadDenyFloor(), `${home}\\.ssh\\keys`, `${home}\\.SSH\\keys\\future`, "/proc/self/environ"];
    const workspace = `${home}\\work`;
    const policy = { allowWrite: [workspace], allowRead: [home], denyRead: floor, protectedFloor: floor,
      denyWrite: [`${workspace}\\controls`, `${workspace}\\controls\\nested`, `${workspace}\\missing`, `${workspace}\\missing\\nested`] };
    const grants = rankMxcFilesystem(policy, (path) => !path.includes("missing"));
    expect(grants.readwrite).toEqual([workspace]);
    expect(grants.readonly).toEqual([home, `${workspace}\\controls`, `${workspace}\\controls\\nested`]);
    const original = [...floor.filter((path) => isWindowsPathAtOrUnder(path, home)), `${workspace}\\missing`, `${workspace}\\missing\\nested`];
    for (const path of original) {
      for (const probe of [path, win32.join(path, "child"), win32.join(path.toUpperCase(), "future", "secret")]) {
        expect(grants.denied.some((deny) => isWindowsPathAtOrUnder(probe, deny)), probe).toBe(true);
      }
    }
    expect(grants.denied).not.toContain(`${home}\\.ssh\\keys`);
    expect(grants.denied).not.toContain(`${workspace}\\missing\\nested`);
    expect(grants.denied.some((path) => path.startsWith("/"))).toBe(false);
    console.info(`MXC minimisation evidence ${JSON.stringify({ before: original.length, after: grants.denied.length, probes: original.length * 3 })}`);
  });

  it("refuses a pipe name already bound by another server", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const server = net.createServer();
    const open = policyPipe.openMxcPolicyPipe;
    vi.spyOn(policyPipe, "openMxcPolicyPipe").mockImplementation(async (bytes, pipe) => {
      await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(pipe, resolveListen); });
      return open(bytes, pipe);
    });
    try {
      await expect(openMxcRequestTransport(request(25_000), LAUNCHER)).rejects.toThrow(/^Windows sandbox policy pipe could not be opened:/);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("expires an unused pipe without waiting for a launcher", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const transport = await openMxcRequestTransport(request(25_000), LAUNCHER);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
    // Advancing host timers does not wait for the native process close event.
    await transport.release();
    await expect(readPipe(transport.args[1]!)).rejects.toThrow();
  });

  it("removes the pipe name before an unused transport release resolves", async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    const transport = await openMxcRequestTransport(request(25_000), LAUNCHER);
    await transport.release();
    await expect(readPipe(transport.args[1]!)).rejects.toThrow();
  });

  for (const impostor of [false, true]) it(`validates two launcher reads with an impostor first: ${impostor}`, async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    requireMxcPolicyPipeHelper(context.skip);
    await requireMxcPrerequisites(context.skip);
    const launcher = await resolveHostWxcExecPath();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-pipe-")));
    const body = buildMxcShellRequest({ commandLine: "cmd.exe /d /c exit 0", cwd: directory,
      grants: { readwrite: [directory], readonly: [], denied: [] },
      env: { SYSTEMROOT: process.env.SystemRoot!, LOCALAPPDATA: directory, PAD: "x".repeat(25_000) },
      proxyUrl: "http://127.0.0.1:9", timeoutMs: 1000 });
    const transport = await openMxcRequestTransport(body, launcher);
    try {
      let refused: Promise<{ data: string; error: string | undefined }> | undefined;
      if (impostor) {
        const socket = net.connect(transport.args[1]!);
        refused = new Promise((resolveRead) => {
          let data = "";
          let error: string | undefined;
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => { data += chunk; });
          socket.once("close", () => resolveRead({ data, error }));
          socket.once("error", (cause: NodeJS.ErrnoException) => { error = cause.code ?? cause.message; });
        });
        await new Promise<void>((resolveConnect, reject) => { socket.once("connect", resolveConnect); socket.once("error", reject); });
      }
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(launcher, ["--dry-run", ...transport.args], { cwd: win32.dirname(launcher), windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.mxcRequestTransportMs }, (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") { reject(error); return; }
          resolve({ code: error?.code as number | undefined ?? 0, stdout, stderr });
        });
        transport.bindChild(child);
      });
      expect(parseMxcDryRunOutput(result.code, result.stdout, result.stderr), JSON.stringify(result)).toEqual({ ok: true });
      if (refused) {
        const refusal = await refused;
        expect(refusal.data).toBe("");
        expect([undefined, "ECONNRESET", "EPIPE"]).toContain(refusal.error);
      }
      await transport.release();
      await expect(readPipe(transport.args[1]!)).rejects.toThrow();
      console.info(`MXC pipe evidence ${JSON.stringify({ impostor, validation: "passed" })}`);
    } finally { await transport.release(); rmSync(directory, { recursive: true, force: true }); }
  }, TOOL_TIMEOUT_POLICY.shellDefaultMs + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);

  it("measures real launcher argv with the full floor under real and long homes", async () => {
    vi.spyOn(policyPipe, "openMxcPolicyPipe").mockResolvedValue({ bindChild: () => {}, release: async () => {} });
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const launcher = await resolveHostWxcExecPath();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "example-mxc-length-")));
    const longHome = join(directory, "example" + "x".repeat(125));
    mkdirSync(longHome);
    const relay = { port: 9, proxyAuthorization: "Basic eA==", registerPort: () => {}, recordRefusal: () => {}, close: async () => {} };
    vi.spyOn(hostEgress, "openHostEgressListener").mockResolvedValue(relay);
    try {
      const decisions: string[] = [];
      for (const [label, home] of [["real", inject("realAccountHome")], ["long", longHome]]) {
        vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([home!]);
        const floor = getProtectedReadDenyFloor();
        const filesystem = { allowWrite: [directory], allowRead: [home!], denyRead: floor, denyWrite: getDefaultSensitiveWriteDenyPaths() };
        const env = { SYSTEMROOT: process.env.SystemRoot!, LOCALAPPDATA: directory };
        const launch = await prepareMxcShellLaunch({ egressToken: "length", cwd: directory, commandLine: "cmd.exe /d /c exit 0", filesystem, env, timeoutMs: 1000, exists: () => true });
        try {
          const grants = rankMxcFilesystem({ ...filesystem, protectedFloor: floor }, () => true);
          const body = buildMxcShellRequest({ cwd: directory, commandLine: "cmd.exe /d /c exit 0", grants, env, proxyUrl: `http://127.0.0.1:${launch.proxyPort}`, timeoutMs: 31_000 });
          const inlineLength = windowsCommandLineLength(launcher, ["--config-base64", Buffer.from(JSON.stringify(body)).toString("base64")]);
          const length = windowsCommandLineLength(launch.argv[0]!, launch.argv.slice(1));
          const allGrants = [...grants.readwrite, ...grants.readonly];
          const before = new Set(floor.filter((path) => allGrants.some((grant) =>
            isWindowsPathAtOrUnder(path, grant) && win32.normalize(path).toLowerCase() !== win32.normalize(grant).toLowerCase(),
          )).map((path) => win32.normalize(path).replace(/[\\/]+$/, "").toLowerCase())).size;
          const fits = inlineLength + WINDOWS_COMMAND_LINE_MARGIN < WINDOWS_COMMAND_LINE_LIMIT;
          expect(launch.argv[1]).toBe(fits ? "--config-base64" : "--config");
          expect(length + WINDOWS_COMMAND_LINE_MARGIN).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
          decisions.push(launch.argv[1]!);
          console.info(`MXC command-line evidence ${JSON.stringify({ label, homeLength: home!.length, inlineLength, length, margin: WINDOWS_COMMAND_LINE_MARGIN, transport: launch.argv[1], floorCount: floor.length, before, after: grants.denied.length })}`);
        } finally { await launch.release(); }
      }
      expect(decisions).toEqual(["--config-base64", "--config"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
