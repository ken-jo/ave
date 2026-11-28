import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _detectMxcLinuxShellSupportForTest as detect, _trustedLinuxPathForTest, buildBubblewrapShellRequest, linuxHolderBwrap } from "../mxc-linux.js";
import seccompPins from "../mxc-linux-seccomp-pins.json" with { type: "json" };
import { posixPolicyLookups } from "../mxc-posix.js";

function probeInputs() {
  return {
    supportedHelper: true, launcherExists: true,
    verifyLauncher: vi.fn(async () => true),
    requireRuntimeRoot: vi.fn(() => "/private/runtime"),
    missingTools: vi.fn<() => readonly string[]>(() => []),
    listBackends: vi.fn<() => Promise<unknown>>(async () => [{ backend: "bubblewrap", capabilities: ["proxyEnforcement"] }]),
    canary: vi.fn<Parameters<typeof detect>[0]["canary"]>(async () => ({ state: "available", rawIpProbe: TIMED_OUT })),
  };
}


const TIMED_OUT = { rawIp: "unknown", reason: "timeout", reachableTargets: [], udpArrival: "absent" } as const;
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
    deps.canary.mockResolvedValueOnce(verdict === "available" ? { state: verdict, rawIpProbe: TIMED_OUT } : { state: verdict });
    expect(await detect(deps)).toEqual(verdict === "available"
      ? { state: "available", rawIpProbe: TIMED_OUT } : { state: "unavailable", reason: verdict });
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
  const { request, environment } = buildBubblewrapShellRequest(input);
  expect(`${JSON.stringify(request, null, 2)}\n`).toBe(readFileSync(new URL("./fixtures/bubblewrap-shell-request.json", import.meta.url), "utf8"));
  // The launcher would put a request's env on bwrap's command line, so the request carries none: the shell sources it.
  expect(request.process.env).toEqual([]);
  expect(environment).toBe("export HOME='/work/sandbox-home'\nexport TMPDIR='/work/sandbox-home/temp'\nexport PATH='/usr/bin'\n");
  expect(buildBubblewrapShellRequest({ ...input, env: { TOKEN: "it's" } }).environment).toBe("export TOKEN='it'\"'\"'s'\n");
  // A name sh cannot export, or one a shell owns (read-only in bash), is refused by name, never dropped.
  for (const name of ["BAD-NAME", "UID", "SHELLOPTS", "BASH_ENV", "BASH_FUNC_x%%", "1X"]) {
    expect(() => buildBubblewrapShellRequest({ ...input, env: { [name]: "x" } }), name).toThrow(JSON.stringify(name));
  }
  expect(() => buildBubblewrapShellRequest({ ...input, cwd: "/work/.ave/hooks" })).toThrow("outside its filesystem grants");
});

describe("checked-in Linux shell filters", () => {
  // A line-ending conversion on checkout (autocrlf, a text attribute) would change the bytes packaging hashes. The
  // checked-out bytes must match the pin, and the attributes file must mark each filter binary, so no checkout converts
  // it. Both are read from the tree, so a source tree without `.git` proves the same.
  it.each(Object.entries(seccompPins))("keeps the %s filter byte-identical to its pin and marked binary", (arch, pin) => {
    const path = `resources/linux-shell-seccomp/${arch}/apply-seccomp`;
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(pin);
    const rules = readFileSync(".gitattributes", "utf8").split("\n").map(line => line.trim().split(/\s+/u));
    // Attribute patterns here use `*` within one path segment only.
    const matches = (pattern: string) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*")}$`, "u").test(path);
    expect(rules.some(([pattern, ...attributes]) => pattern !== undefined && matches(pattern) && attributes.includes("binary"))).toBe(true);
  });
});

// Review #758 P3-1: a run's marker is compared with `/proc/<pid>/exe`, so bwrap is recorded as the file a link names.
describe.runIf(process.platform !== "win32")("the holder route's bwrap", () => {
  it("is recorded as the file an alternatives-style link resolves to", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-bwrap-link-")));
    try {
      const real = join(root, "bwrap.real");
      writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
      symlinkSync(real, join(root, "bwrap"));
      expect(linuxHolderBwrap(join(root, "bwrap")).path).toBe(real);
      expect(linuxHolderBwrap(join(root, "bwrap")).identity).toBe(linuxHolderBwrap(real).identity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
