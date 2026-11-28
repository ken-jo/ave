import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _LINUX_HOLDER_BRIDGE_CHECK_FOR_TEST, _runLinuxHolderCanaryForTest, detectHostMxcLinuxHolderSupport, detectHostMxcLinuxShellSupport,
} from "../mxc-linux.js";

// Paths the canary must find missing, though the host has them (review #758 P3-6).
const missing = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  return {
    ...fs,
    accessSync: ((path: string, mode?: number) => {
      if (missing.has(String(path))) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
      return fs.accessSync(path, mode);
    }) as typeof fs.accessSync,
  };
});
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const ADD_LINK = `
import ctypes, fcntl, os, sys
libc = ctypes.CDLL(None, use_errno=True)
pid = sys.argv[1]
user = os.open(f"/proc/{pid}/ns/user", os.O_RDONLY)
net = os.open(f"/proc/{pid}/ns/net", os.O_RDONLY)
parent = fcntl.ioctl(user, 0xb702)
for fd, kind in ((parent, 0x10000000), (net, 0x40000000)):
    if libc.setns(fd, kind) != 0:
        raise OSError(ctypes.get_errno(), "setns")
os.execv("/usr/sbin/ip", ["ip", "link", "add", "ave-n22", "type", "dummy"])
`;

describe.runIf(NATIVE)("native Linux holder canary (design 6.3)", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  let root: string;
  let cache: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-canary-"));
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
  });
  afterEach(() => {
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function leftovers(): string[] {
    const start = requireMxcContainerStartRoot();
    const markers = join(start, "holder-markers");
    return [
      ...readdirSync(start).filter(name => name.startsWith("holder-canary-")),
      ...(existsSync(markers) ? readdirSync(markers) : []),
    ];
  }

  it("proves the route with one real holder and measures its raw IP as blocked, evidence measured", async () => {
    establishMxcRuntimeRoot();
    const result = await detectHostMxcLinuxHolderSupport(resources);
    expect(result.support).toEqual({
      state: "available",
      rawIpProbe: { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" },
    });
    expect(result.route).toMatchObject({ bwrap: { path: expect.stringMatching(/\/bwrap$/) }, captureFolder: expect.stringMatching(/bwrap-capture$/) });
    expect(leftovers()).toEqual([]);
  });

  // Design 2.5: holders need only bwrap. CI's second run hides slirp4netns: the shells then have no container, yet the
  // holder route is proven. In the normal run both are available.
  it("proves the holder route whether or not the host has slirp4netns", async () => {
    establishMxcRuntimeRoot();
    const shell = await detectHostMxcLinuxShellSupport(resources);
    if (process.env.AVE_EXPECT_NO_SLIRP4NETNS === "1") {
      expect(shell).toMatchObject({ state: "unavailable", reason: "tools-missing", detail: expect.arrayContaining(["slirp4netns"]) });
    } else {
      expect(shell).toMatchObject({ state: "available" });
    }
    await expect(detectHostMxcLinuxHolderSupport(resources)).resolves.toMatchObject({ support: { state: "available" } });
  });

  it("reports the first failure: no runtime root, then missing programs", async () => {
    await expect(detectHostMxcLinuxHolderSupport(resources)).resolves.toEqual({ support: { state: "unavailable", reason: "runtime-root-unproved" } });
    establishMxcRuntimeRoot();
    await expect(detectHostMxcLinuxHolderSupport({ resourcePath: join(root, "none"), isPackaged: false }))
      .resolves.toEqual({ support: { state: "unavailable", reason: "binary-missing" } });
  });

  // Review #758 P3-6: a tool the canary's checks run is a named prerequisite, not a check that passes for want of it.
  it.each([["/usr/bin/unshare"], ["/bin/bash"], ["/usr/bin/timeout"]])("names %s missing instead of passing or failing its check", async (tool) => {
    establishMxcRuntimeRoot();
    missing.add(tool);
    try {
      await expect(detectHostMxcLinuxHolderSupport(resources)).resolves.toEqual({ support: { state: "unavailable", reason: "tools-missing", detail: [tool] } });
    } finally {
      missing.delete(tool);
    }
  });

  it("is unknown when the namespace holds a second interface while it runs (N22)", async () => {
    establishMxcRuntimeRoot();
    const proven = await detectHostMxcLinuxHolderSupport(resources);
    if (proven.route === undefined) throw new Error("the holder route was not proven");
    const verdict = await _runLinuxHolderCanaryForTest(requireMxcContainerStartRoot(), proven.route, undefined, {
      whileRunning: async (pid) => {
        // bwrap nests the holder's user namespace (no nested namespaces inside), so the network namespace belongs to
        // the outer one, where no process lives. Enter it through the holder's user namespace parent (NS_GET_PARENT),
        // where the same user holds CAP_NET_ADMIN, then add a second link to the holder's network namespace.
        const [child = ""] = execFileSync("pgrep", ["-P", String(pid)]).toString().trim().split("\n");
        execFileSync("python3", ["-I", "-c", ADD_LINK, child]);
      },
    });
    expect(verdict).toMatchObject({ rawIp: "unknown", reason: "no-evidence" });
    expect(leftovers()).toEqual([]);
  });
});

// Review #758 P3-6: the bridge check needs the host listener's answer; a port that only accepts is no bridge.
describe.runIf(process.platform !== "win32")("the holder canary's bridge check", () => {
  async function check(answer: string | undefined): Promise<number | null> {
    const server = createServer(socket => { if (answer !== undefined) socket.end(answer); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise(done => {
        const child = spawn("/bin/bash", ["-c", _LINUX_HOLDER_BRIDGE_CHECK_FOR_TEST, "bridge", String(port), "n-bridge.localhost"], { timeout: 3_000, stdio: "ignore" });
        child.once("exit", done);
      });
    } finally {
      server.close();
    }
  }

  it("passes on the host listener's refusal, and not on a port that accepts and says nothing", async () => {
    expect(await check("HTTP/1.1 403 Forbidden\r\n\r\n")).toBe(0);
    expect(await check("HTTP/1.1 200 OK\r\n\r\n")).toBe(1);
    expect(await check("")).toBe(1);
  });
});
