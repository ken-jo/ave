import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _detectMxcLinuxShellSupportForTest as detect, _trustedLinuxPathForTest, buildBubblewrapShellRequest } from "../mxc-linux.js";
import { posixPolicyLookups } from "../mxc-posix.js";

function probeInputs() {
  return {
    supportedHelper: true, launcherExists: true,
    verifyLauncher: vi.fn(async () => true),
    requireRuntimeRoot: vi.fn(() => "/private/runtime"),
    missingTools: vi.fn<() => readonly string[]>(() => []),
    listBackends: vi.fn<() => Promise<unknown>>(async () => [{ backend: "bubblewrap", capabilities: ["proxyEnforcement"] }]),
    canary: vi.fn<Parameters<typeof detect>[0]["canary"]>(async () => "available"),
  };
}

describe("Linux container shell boot proof", () => {
  it("stops at the first helper, launcher, integrity or runtime-root failure", async () => {
    const deps = probeInputs();
    expect(await detect({ ...deps, supportedHelper: false, launcherExists: false })).toEqual({ state: "unavailable", reason: "unsupported-arch" });
    expect(await detect({ ...deps, launcherExists: false })).toEqual({ state: "unavailable", reason: "binary-missing" });
    expect(deps.verifyLauncher).not.toHaveBeenCalled();
    deps.verifyLauncher.mockResolvedValueOnce(false);
    expect(await detect(deps)).toEqual({ state: "unavailable", reason: "launcher-mismatch" });
    expect(deps.requireRuntimeRoot).not.toHaveBeenCalled();
    deps.requireRuntimeRoot.mockImplementationOnce(() => { throw new Error("unproved"); });
    expect(await detect(deps)).toEqual({ state: "unavailable", reason: "runtime-root-unproved" });
    expect(deps.missingTools).not.toHaveBeenCalled();
  });

  it("reports exact tools before probing namespaces and requires an explicit backend capability", async () => {
    const deps = probeInputs();
    deps.missingTools.mockReturnValueOnce(["bwrap", "iptables"]);
    expect(await detect(deps)).toEqual({ state: "unavailable", reason: "tools-missing", detail: ["bwrap", "iptables"] });
    expect(deps.listBackends).not.toHaveBeenCalled();
    deps.listBackends.mockResolvedValueOnce([{ backend: "bubblewrap", warnings: ["proxyEnforcement"] }]);
    expect(await detect(deps)).toEqual({ state: "unavailable", reason: "namespaces-unavailable" });
    expect(deps.canary).not.toHaveBeenCalled();
  });

  it.each(["request-rejected", "shell-start-failed", "available"] as const)("publishes the canary result %s", async (verdict) => {
    const deps = probeInputs();
    deps.canary.mockResolvedValueOnce(verdict);
    expect(await detect(deps)).toEqual(verdict === "available" ? { state: "available" } : { state: "unavailable", reason: verdict });
    expect(deps.canary).toHaveBeenCalledWith("/private/runtime");
  });

  it("omits untrusted absolute paths and relative entries from the launcher path", () => {
    const planted = mkdtempSync(join(tmpdir(), "planted-launcher-"));
    try {
      const resolved = realpathSync.native(planted);
      expect(_trustedLinuxPathForTest(`${planted}:.:relative`, (path) => path !== resolved)).not.toContain(resolved);
      expect(_trustedLinuxPathForTest(`${planted}:.:relative`, (path) => path === resolved)).toEqual(
        process.platform === "win32" ? [] : [resolved],
      );
    } finally {
      rmSync(planted, { recursive: true });
    }
  });
});

it("keeps the Linux request bytes stable and requires the nearest cwd row to allow it", () => {
  const lookups = { ...posixPolicyLookups("/home/example", false), exists: () => true, canonical: (path: string) => path };
  const input = {
    grants: { readwrite: ["/work", "/work/.ave"], readonly: ["/usr", "/tmp"], denied: ["/work/.ave/hooks"],
      chainFolders: [], ungrantedDenies: [] },
    lookups, cwd: "/work", commandLine: "printf '%s' control", timeoutMs: 3000,
    env: { HOME: "/work/sandbox-home", TMPDIR: "/work/sandbox-home/temp", PATH: "/usr/bin", HTTPS_PROXY: "discard", NO_PROXY: "discard" },
    proxyUrl: "http://127.0.0.1:12345", helper: "/app/filter/apply-seccomp",
  };
  const request = buildBubblewrapShellRequest(input);
  expect(`${JSON.stringify(request, null, 2)}\n`).toBe(readFileSync(new URL("./fixtures/bubblewrap-shell-request.json", import.meta.url), "utf8"));
  expect(() => buildBubblewrapShellRequest({ ...input, cwd: "/work/.ave/hooks" })).toThrow("outside its filesystem grants");
});
