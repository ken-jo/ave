import "../../__tests__/support/trusted-powershell.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { buildPerCommandSandboxCustomConfig, getBuiltinShellSessionReadPolicy, getDefaultSensitiveReadDenyPaths, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { getConfiguredSessionReadPolicy } from "../../permissions/sensitive-paths.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { PowerShellTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

vi.mock("../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/asrt-sandbox.js")>(),
  // Stop at the wrapper boundary: this suite proves wiring, not OS isolation.
  wrapToolCommand: vi.fn(async () => { throw new Error("fixture wrapper boundary"); }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...await importOriginal<typeof import("node:child_process")>(),
    spawn: vi.fn((executable: string) => {
      if (executable !== "/opt/microsoft/powershell/7/pwsh") throw new Error("Unexpected fixture subprocess");
      const parser = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      parser.stdin.on("finish", () => {
        parser.stdout.end(Buffer.from(JSON.stringify({
          errors: [], redirections: [], unsupported: [],
          commands: [{ name: "Write-Output", text: "Write-Output fixture", arguments: [
            { kind: "literal", value: "Write-Output", text: "Write-Output" },
            { kind: "literal", value: "fixture", text: "fixture" },
          ] }],
        })));
        parser.emit("close", 0);
      });
      return parser;
    }),
  };
});

const hostPlatform = process.platform;
let root: string;
let cwd: string;
let profile: string;
let sessions: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-shell-wiring-")));
  cwd = join(root, "workspace");
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  mkdirSync(cwd); mkdirSync(sessions, { recursive: true });
  vi.stubEnv("HOME", root);
  vi.stubEnv("AVE_HOME", profile);
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt", confidence: "verified", platform: process.platform,
    reason: "Controlled wrapper fixture",
    confines: { filesystem: true, process: true, network: true },
  });
  setShellSandboxRequestedAtBoot(true);
  vi.clearAllMocks();
});
afterEach(async () => {
  setProcessPlatform(hostPlatform);
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

async function invoke(dialect: "bash" | "powershell", extraAllowedDirectories: readonly string[] = []) {
  if (dialect === "bash") {
    const command = "printf fixture";
    return spawnWithSandbox(command, cwd, [cwd, ...extraAllowedDirectories], 5, prepareSandboxFixture(command, cwd));
  }
  return new PowerShellTool().execute({ command: "Write-Output fixture", timeoutSeconds: 5 }, {
    cwd, extraAllowedDirectories, blockReadsOutsideWorkingDirectories: true, metadata: {},
  });
}

describe.skipIf(process.platform === "win32")("saved-session native shell policy wiring", () => {
  it.each(["bash", "powershell"] as const)("%s keeps ancestor write scope and broad HOME reads", async (dialect) => {
    const ancestor = dirname(root);
    const alias = join(root, "ancestor-link");
    symlinkSync(ancestor, alias);
    await invoke(dialect, [ancestor, alias]);
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowWrite).toContain(ancestor);
    expect(filesystem.allowRead).toContain(ancestor);
    expect(filesystem.allowRead!.some((path) => realpathSync(path) === realpathSync(alias))).toBe(true);
    expect(filesystem.allowRead).toContain(cwd);
    expect(filesystem.allowRead).toContain(sessions);
    expect(filesystem.denyRead).not.toContain(root);
    expect(filesystem.denyWrite).toContain(sessions);
  });

  it.each([
    ["bash", "linux", false], ["powershell", "linux", false], ["bash", "darwin", true], ["powershell", "darwin", true],
  ] as const)("%s on %s: the wrap grants a protected write root only where the grant stays write-only", async (dialect, platform, granted) => {
    // A bubblewrap write grant is a read-write bind over the deny's mask, so on Linux it would reopen reads the
    // protected floor hides. The shell hands its roots to the wrap unchanged; the wrap's shared layer decides.
    const protectedRoot = join(root, ".ssh", "work"); mkdirSync(protectedRoot, { recursive: true });
    const ordinary = join(root, "ordinary"); mkdirSync(ordinary);
    setProcessPlatform(platform);
    await invoke(dialect, [protectedRoot, ordinary]);
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.denyRead).toContain(join(root, ".ssh"));
    expect(filesystem.allowRead).not.toContain(protectedRoot);
    const allowWrite = buildPerCommandSandboxCustomConfig(filesystem)?.filesystem?.allowWrite ?? [];
    expect(allowWrite).toEqual(expect.arrayContaining([cwd, ordinary]));
    expect(allowWrite.includes(protectedRoot)).toBe(granted);
  });

  it.each(["bash", "powershell"] as const)("%s pairs the configured read grant with nested exclusions and write protection", async (dialect) => {
    const result = await invoke(dialect);
    expect(result.output).toContain("fixture wrapper boundary");
    expect(wrapToolCommand).toHaveBeenCalledTimes(1);
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowRead).toContain(sessions);
    expect(filesystem.allowRead).not.toContain(profile);
    expect(filesystem.allowWrite).not.toContain(sessions);
    expect(filesystem.denyWrite).toContain(sessions);
    expect(filesystem.denyRead).not.toContain(sessions);
    expect(getDefaultSensitiveReadDenyPaths()).toContain(sessions);
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([
      join(profile, "secrets"), join(profile, "audit"), join(profile, "routine"),
      `${sessions}/**/.ssh`, `${sessions}/**/.env`,
    ]));
    const policy = getBuiltinShellSessionReadPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowRead)).toBe(true);
    expect(Object.isFrozen(policy.denyRead)).toBe(true);
    expect(filesystem.denyRead).toEqual(expect.arrayContaining([...policy.denyRead]));
    const sandboxHome = filesystem.allowWrite?.find((path) => path.includes("ave-sandbox-home-"));
    expect(sandboxHome).toBeDefined();
    expect(existsSync(sandboxHome!)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(dialect === "powershell" ? 1 : 0);
  });

  it.each(["bash", "powershell"] as const)("%s grants nothing when the sessions directory escapes through a link", async (dialect) => {
    const outside = join(root, "ungranted"); mkdirSync(outside);
    rmdirSync(sessions); symlinkSync(outside, sessions);
    expect(getConfiguredSessionReadPolicy()).toEqual({ allowRead: [], denyRead: [] });
    const result = await invoke(dialect);
    expect(result.output).toContain("fixture wrapper boundary");
    const filesystem = vi.mocked(wrapToolCommand).mock.calls[0]![1]!.filesystem!;
    expect(filesystem.allowRead).not.toContain(sessions);
    expect(filesystem.allowRead).not.toContain(outside);
    expect(filesystem.allowRead).not.toContain(profile);
    expect(filesystem.denyWrite).toContain(sessions);
  });

  it("keeps a protected alias of the session root outside the builtin exception", () => {
    const protectedAlias = join(profile, "certs");
    symlinkSync(sessions, protectedAlias);
    const policy = getBuiltinShellSessionReadPolicy();
    expect(policy.allowRead).toEqual([]);
    expect(policy.denyRead).toContain(sessions);
    expect(policy.denyRead).toContain(protectedAlias);
  });

  it("preserves both runtime-key spellings while granting ordinary saved-history reads", () => {
    const key = join(sessions, "key-material"); writeFileSync(key, "synthetic-key-fixture");
    const alias = join(root, "runtime-key"); symlinkSync(key, alias);
    vi.stubEnv("AVE_SECRET_KEY_FILE", alias);
    const policy = getBuiltinShellSessionReadPolicy();
    expect(policy.allowRead).toContain(sessions);
    expect(policy.denyRead).toEqual(expect.arrayContaining([key, alias]));
  });
});
