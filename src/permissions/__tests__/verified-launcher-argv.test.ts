import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installations = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: installations.resolve }));

import { proveVerifiedLauncherArgv } from "../rules/verified-launcher-argv.js";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const GUARDED_ARGUMENTS = ["bash", "--noprofile", "--norc", "-p", "-c", "printf ready"] as const;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "darwin" });
  installations.resolve.mockReset();
  installations.resolve.mockReturnValue({ executable: "/bin/bash" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  vi.unstubAllEnvs();
});

describe("verified launcher arguments", () => {
  it.each([
    ["darwin", "/bin/bash"],
    ["linux", "/usr/bin/bash"],
  ] as const)("binds the complete startup form to the proved image on %s", (platform, executable) => {
    Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: platform });
    installations.resolve.mockReturnValue({ executable });

    expect(proveVerifiedLauncherArgv(GUARDED_ARGUMENTS)).toEqual({
      executable,
      args: ["--noprofile", "--norc", "-p", "-c", "printf ready"],
      environment: {},
      proof: { kind: "literal-evaluation", payloadIndexes: [5], changesState: false },
    });
    expect(installations.resolve).toHaveBeenCalledExactlyOnceWith([
      { executable, installationRoots: [executable] },
    ], platform);
  });

  it("refuses the complete startup form without installation proof", () => {
    installations.resolve.mockReturnValue(null);
    expect(proveVerifiedLauncherArgv(GUARDED_ARGUMENTS)).toBeNull();
    expect(installations.resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps candidate authority independent of an inherited search path", () => {
    vi.stubEnv("PATH", "/agent-controlled/bin");
    expect(proveVerifiedLauncherArgv(GUARDED_ARGUMENTS)?.executable).toBe("/bin/bash");
    expect(installations.resolve).toHaveBeenCalledExactlyOnceWith([
      { executable: "/bin/bash", installationRoots: ["/bin/bash"] },
    ], "darwin");
  });

  it.each([
    [],
    ["bash"],
    ["bash", "-c", "printf ready"],
    ["bash", "--noprofile", "--norc", "-c", "printf ready"],
    ["bash", "--noprofile", "-p", "-c", "printf ready"],
    ["bash", "--norc", "-p", "-c", "printf ready"],
    ["bash", "--norc", "--noprofile", "-p", "-c", "printf ready"],
    ["bash", "--noprofile", "--norc", "-pc", "printf ready"],
    ["bash", "--noprofile", "--norc", "-p", "-lc", "printf ready"],
    ["bash", "--noprofile", "--norc", "-p", "-i", "-c", "printf ready"],
    ["bash", "--noprofile", "--norc", "-p", "--login", "-c", "printf ready"],
    ["bash", "--noprofile", "--norc", "-p", "--rcfile", "startup", "-c", "printf ready"],
    ["bash", "--noprofile", "--norc", "-p", "-c"],
    ["bash", "--noprofile", "--norc", "-p", "-c", ""],
    ["bash", "--noprofile", "--norc", "-p", "-c", "printf\0ready"],
    ["bash", "--noprofile", "--norc", "-p", "-c", "printf ready", "argument"],
    ["bash", "--noprofile", "--norc", "-p", "script.sh"],
    ["/bin/bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["/usr/bin/bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["/agent-controlled/bin/bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["./bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["BASH", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["bash.exe", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["env", "bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["command", "bash", "--noprofile", "--norc", "-p", "-c", "printf ready"],
    ["python", "-I", "-S", "-c", "print('ready')"],
    ["python3", "-I", "-S", "-B", "-c", "print('ready')"],
    ["fish", "--no-config", "--private", "-c", "printf ready"],
    ["node", "--no-addons", "--no-global-search-paths", "-e", "console.log('ready')"],
    ["pwsh", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ready"],
    ["pwsh", "-NoProfile", "-SettingsFile", "/settings.json", "-Command", "Write-Output ready"],
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ready"],
    ["zsh", "-f", "-c", "printf ready"],
    ["sh", "--noprofile", "--norc", "-p", "-c", "printf ready"],
  ])("refuses an unregistered argument form: %j", (...argv) => {
    expect(proveVerifiedLauncherArgv(argv)).toBeNull();
    expect(installations.resolve).not.toHaveBeenCalled();
  });

  it.each(["win32", "freebsd", "openbsd", "aix"] as const)("refuses a platform without a complete registered installation: %s", (platform) => {
    Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: platform });
    expect(proveVerifiedLauncherArgv(GUARDED_ARGUMENTS)).toBeNull();
    expect(installations.resolve).not.toHaveBeenCalled();
  });

  it("preserves the opaque literal payload for downstream evaluation", () => {
    const payload = "printf '%s' '$HOME';\nprintf '%s' '$(command)'";
    const plan = proveVerifiedLauncherArgv(["bash", "--noprofile", "--norc", "-p", "-c", payload]);
    expect(plan?.args).toEqual(["--noprofile", "--norc", "-p", "-c", payload]);
    expect(plan?.proof).toEqual({ kind: "literal-evaluation", payloadIndexes: [5], changesState: false });
  });

  it("captures immutable arguments independently of the input array", () => {
    const argv: string[] = [...GUARDED_ARGUMENTS];
    const plan = proveVerifiedLauncherArgv(argv);
    argv[5] = "printf changed";
    expect(plan?.args).toEqual(["--noprofile", "--norc", "-p", "-c", "printf ready"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.args)).toBe(true);
    expect(Object.isFrozen(plan?.environment)).toBe(true);
    expect(Object.isFrozen(plan?.proof)).toBe(true);
    expect(plan?.proof.kind).toBe("literal-evaluation");
    if (plan?.proof.kind !== "literal-evaluation") throw new Error("Expected an evaluation proof");
    expect(Object.isFrozen(plan?.proof.payloadIndexes)).toBe(true);
  });
});
