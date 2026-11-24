// Native enforcement of the extension container request the host builds: the production request builder and supervisor
// environment, run through the installed SDK. An unconfined run of the same script is the working control.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireMxcCapability } from "../../__tests__/support/mxc-capability.js";
import { configureHostResources } from "../../main/host-resources.js";
import { buildMxcConfinedChildRequest } from "../mxc-confined-child-request.js";
import { mxcSupervisorEnvironment } from "../mxc-extension-process.js";

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

      const request = buildMxcConfinedChildRequest({
        command: shell,
        args,
        cwd: granted,
        home,
        temp,
        grants: { readwrite: [granted, staging], readonly: [protectedDirectory, shellDirectory], denied: [denied] },
        baseEnv: { SystemRoot: systemRoot, PATH: join(systemRoot, "System32") },
        proxyUrl: "http://127.0.0.1:9",
      });
      const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const environment = mxcSupervisorEnvironment(base, state);
      const snapshot = (): string => [root, granted, protectedDirectory, outside, denied, staging]
        .map((directory) => spawnSync(join(systemRoot, "System32", "icacls.exe"), [directory], { encoding: "utf8", windowsHide: true }).stdout).join("\n");
      const run = (env: Record<string, string>, body: unknown = request): { exitCode?: number; stdout?: string; threw?: string } => {
        const child = spawnSync(process.execPath, ["-e", RUNNER], { input: JSON.stringify(body), env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
        try {
          return JSON.parse(child.stdout) as { exitCode?: number; stdout?: string; threw?: string };
        } catch {
          throw new Error(`Container runner produced no result: status ${String(child.status)} ${child.stderr.slice(0, 400)}`);
        }
      };

      const before = snapshot();
      const confined = run(environment);
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
      const refused = run(environment, { ...request, network: { ...request.network, runtimeConfig: { networkProxy: "http://192.0.2.1:8080" } } });
      expect(refused.threw !== undefined || refused.exitCode !== 0, JSON.stringify(refused)).toBe(true);
      expect(refused.stdout ?? "").not.toContain("GRANTED_WRITE");
      expect(hostFacts()).toEqual({ granted: false, outside: [], protected: ["keep.txt"], staging: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
