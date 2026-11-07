vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// The sandbox read deny covers the Ave home as one directory: no per-file rows, every child denied unless re-allowed.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/policy-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  const os = await import("node:os");
  return { ...actual, policyHomeAnchors: () => [os.homedir()] };
});

import { aveHome } from "../../shared/ave-home.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { AVE_HOME_READ_REALLOWS, isAveHomeReadReallowed } from "../ave-home-read-boundary.js";
import {
  aveHomeReadBoundaryCovering,
  buildPerCommandSandboxCustomConfig,
  buildSandboxConfig,
  getBuiltinShellReadPolicy,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  getProtectedReadDenyFloor,
} from "../asrt-sandbox.js";
import { SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import { windowsReadDenyEvidence } from "../../shared/windows-read-deny-evidence.js";

useVerifiedAveHomePrivacy();

const HOST_PLATFORM = process.platform;
const trim = (path: string): string => path.replace(/[\\/]+$/, "");
const spelled = (entries: readonly unknown[]): string[] => entries.map((entry) => trim(typeof entry === "string" ? entry : (entry as { path: string }).path));
const aveFileRows = (): string[] => SENSITIVE_PATH_ENTRIES
  .filter((entry) => entry.anchor === "ave-home" && entry.kind === "file").map((entry) => join(aveHome(), ...entry.segments));
const dotfileRows = (): string[] => SENSITIVE_PATH_ENTRIES
  .filter((entry) => entry.anchor === "home" && entry.kind === "file").map((entry) => join(homedir(), ...entry.segments));
const reallowed = (): string[] => [
  join(aveHome(), "workspace", "alice-project"),
  join(aveHome(), "plugins", "alice-plugin", "data"),
  join(aveHome(), "plugins", ".cache", "alice-plugin"),
  join(aveHome(), "agent-plugin-data", "bob-agent"),
  join(aveHome(), "packages", "agent-plugin", "bob-agent", "1.0.0"),
  join(aveHome(), "mcp", "example-server", "sandbox"),
  join(aveHome(), "runtime", "python-envs", "example"),
  join(aveHome(), "runtime", "uv"),
  join(aveHome(), "mxc-staging", "alice"),
];
const withheld = (): string[] => [
  aveHome(),
  join(aveHome(), "logs"),
  join(aveHome(), "traces", "alice.jsonl"),
  join(aveHome(), "plugins"),
  join(aveHome(), "plugins", "registry.json"),
  join(aveHome(), "plugins", ".cache"),
  join(aveHome(), "mcp", "servers.json"),
  join(aveHome(), "mcp", "servers.json.bak"),
  join(aveHome(), "mcp", ".cache"),
  join(aveHome(), "packages", "ledger.json"),
  join(aveHome(), "runtime"),
  join(aveHome(), "runtime", "example-tool"),
  join(aveHome(), "future-child", "alice.txt"),
];

afterEach(() => setProcessPlatform(HOST_PLATFORM));

describe("the Ave home re-allow table", () => {
  it("re-opens only named children, never the root or a sibling file", () => {
    expect(isAveHomeReadReallowed([])).toBe(false);
    expect(isAveHomeReadReallowed(["workspace"])).toBe(true);
    expect(isAveHomeReadReallowed(["plugins"])).toBe(false);
    expect(isAveHomeReadReallowed(["plugins", "registry.json"])).toBe(false);
    expect(isAveHomeReadReallowed(["mcp", "servers.json"])).toBe(false);
    expect(isAveHomeReadReallowed(["mcp", ".cache"])).toBe(false);
    expect(isAveHomeReadReallowed(["logs"])).toBe(false);
    expect(AVE_HOME_READ_REALLOWS.every((row) => row.why.length > 0)).toBe(true);
  });
});

describe.each(["linux", "darwin", "win32"] as const)("the Ave home read boundary on %s", (platform) => {
  it("denies the Ave home root and none of its file rows; home dotfile rows are unchanged", () => {
    setProcessPlatform(platform);
    const floor = spelled(getDefaultSensitiveReadDenyPaths());
    expect(floor).toContain(trim(aveHome()));
    for (const row of aveFileRows()) expect(floor).not.toContain(row);
    for (const row of dotfileRows()) expect(floor).toContain(row);
  });

  it("keeps the Ave home file rows on the protected floor and the write floor", () => {
    setProcessPlatform(platform);
    const write = spelled(getDefaultSensitiveWriteDenyPaths());
    const floor = spelled(getProtectedReadDenyFloor());
    for (const row of aveFileRows()) {
      expect(write).toContain(row);
      expect(floor).toContain(row);
    }
    expect(write).not.toContain(trim(aveHome()));
    expect(floor).not.toContain(trim(aveHome()));
  });

  it("covers every path outside a re-allowed child, the root included", () => {
    setProcessPlatform(platform);
    for (const path of reallowed()) expect(aveHomeReadBoundaryCovering(path), path).toBeUndefined();
    for (const path of withheld()) expect(trim(aveHomeReadBoundaryCovering(path) ?? ""), path).toBe(trim(aveHome()));
    expect(aveHomeReadBoundaryCovering(join(homedir(), "alice-project"))).toBeUndefined();
  });

  it("drops a shell read grant outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const policy = getBuiltinShellReadPolicy([...reallowed(), ...withheld()], homedir());
    const granted = spelled(policy.allowRead);
    for (const path of reallowed()) expect(granted).toContain(trim(path));
    for (const path of withheld()) expect(granted).not.toContain(trim(path));
    expect(spelled(policy.denyRead)).toContain(trim(aveHome()));
  });
});

describe.each(["linux", "darwin"] as const)("the Ave home read boundary in %s wraps", (platform) => {
  it("withholds a per-command read grant outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const config = buildPerCommandSandboxCustomConfig({
      allowRead: [...reallowed(), ...withheld()],
      denyRead: getDefaultSensitiveReadDenyPaths(),
    });
    const granted = spelled(config?.filesystem?.allowRead ?? []);
    for (const path of reallowed()) expect(granted).toContain(trim(path));
    for (const path of withheld()) expect(granted).not.toContain(trim(path));
  });

  it.runIf(platform === "linux")("withholds a Linux write root outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const keep = join(aveHome(), "workspace", "alice-project");
    const drop = join(aveHome(), "logs");
    const config = buildPerCommandSandboxCustomConfig({ allowWrite: [keep, drop], denyRead: getDefaultSensitiveReadDenyPaths() });
    const roots = spelled(config?.filesystem?.allowWrite ?? []);
    expect(roots).toContain(trim(keep));
    expect(roots).not.toContain(trim(drop));
  });

  it.runIf(platform === "darwin")("spells the root deny exactly so a nested re-allow survives late deny emission", () => {
    setProcessPlatform(platform);
    const denies = spelled(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true }).filesystem.denyRead);
    expect(denies).not.toContain(trim(aveHome()));
    expect(denies.some((path) => path.endsWith("]") && path.includes("["))).toBe(true);
  });
});

describe.runIf(HOST_PLATFORM === "win32")("the Ave home read boundary on a Windows host", () => {
  const rootDeny = (config: ReturnType<typeof buildSandboxConfig>): string | undefined => config.filesystem.denyRead
    .map((entry) => typeof entry === "string" ? entry : entry.path)
    .find((path) => trim(path).toLowerCase() === trim(aveHome()).toLowerCase());

  it("stamps the root in directory form when a grant lies beneath it", () => {
    const workspace = join(aveHome(), "workspace");
    mkdirSync(workspace, { recursive: true });
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true, allowWrite: [workspace] });
    expect(rootDeny(config)).toBe(`${trim(aveHome())}\\`);
    expect(spelled(config.filesystem.denyRead)).not.toContain(join(aveHome(), "settings.json"));
  });

  it("leaves a private or missing home to its own DACL when no grant lies beneath it", () => {
    const status = windowsReadDenyEvidence(`${trim(aveHome())}\\`).status;
    const kept = rootDeny(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true })) !== undefined;
    expect(kept).toBe(status !== "private" && status !== "missing");
  });
});
