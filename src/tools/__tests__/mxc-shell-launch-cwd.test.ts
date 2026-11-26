import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerMxcShellLaunchAdmissionFixture } from "../../__tests__/support/mxc-shell-launch-admission.js";
import { configureHostResources } from "../../main/host-resources.js";
import { forgetIssuedContainerHome, recordIssuedContainerHome } from "../../permissions/sandbox-home-registry.js";

const h = vi.hoisted(() => ({ root: "" }));
const PAST_THE_CHECK = "reached the listener, past the working-directory check";
vi.mock("../../permissions/egress-host-listener.js", () => ({
  openHostEgressListener: async () => { throw new Error(PAST_THE_CHECK); },
}));
vi.mock("../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => String.raw`C:\Ave\resources\mxc\x64\wxc-exec.exe`,
}));
vi.mock("../../permissions/mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => h.root,
}));
// The real matcher against a runtime root this suite owns.
vi.mock("../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/asrt-sandbox.js")>(),
  appOwnedSandboxPrivateRoots: () => [`${h.root}\\`],
}));

import { prepareMxcShellLaunch } from "../mxc-shell-launch.js";
import { createContainedShellLifecycle } from "../contained-shell-lifecycle.js";

registerMxcShellLaunchAdmissionFixture("tok");

describe.runIf(process.platform === "win32")("a container shell's working directory against the real runtime root", () => {
  let base = "";
  const own = (): string => join(h.root, "homes", "ave-sandbox-home-own");
  const other = (): string => join(h.root, "homes", "ave-sandbox-home-other");
  beforeAll(() => {
    // Filesystem admission pins the real paths through the native helpers.
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-cwd-")));
    h.root = join(base, "cache", "mxc-runtime");
    for (const home of [own(), other()]) {
      mkdirSync(home, { recursive: true });
      recordIssuedContainerHome(home, h.root);
    }
    mkdirSync(`${h.root}-other`);
    symlinkSync(h.root, join(base, "link"), "junction");
    symlinkSync(own(), join(base, "to-own"), "junction");
  });
  afterAll(() => {
    forgetIssuedContainerHome(own());
    forgetIssuedContainerHome(other());
    rmSync(base, { recursive: true, force: true });
  });

  const launch = async (cwd: string): Promise<unknown> => {
    const lifecycle = createContainedShellLifecycle();
    try {
      return await prepareMxcShellLaunch({ egressToken: "tok", commandLine: "cmd.exe /d /c echo hi", cwd, sandboxHome: own(),
        filesystem: { allowWrite: [cwd], allowRead: [], denyRead: [], denyWrite: [] },
        env: { SYSTEMROOT: String.raw`C:\Windows` }, timeoutMs: 5_000, exists: () => true }, lifecycle).catch((error: unknown) => error);
    } finally {
      await lifecycle.dispose();
    }
  };

  it.each([
    ["through a junction", () => join(base, "link", "homes")],
    ["in another case", () => join(h.root.toUpperCase(), "HOMES")],
    ["below the root, not yet created", () => join(h.root, "staging", "next")],
    ["at another invocation's HOME", other],
    ["at the HOME parent", () => join(h.root, "homes")],
  ])("refuses one inside it %s", async (_case, cwd) => {
    expect(await launch(cwd())).toMatchObject({ message: "Container shell working directory is inside the sandbox runtime root" });
  });

  it.each([
    ["one beside it whose name only starts like it", () => `${h.root}-other`],
    ["its own issued HOME", own],
    ["a junction to its own issued HOME, by the target's identity", () => join(base, "to-own")],
  ])("admits %s", async (_case, cwd) => {
    expect(await launch(cwd())).toMatchObject({ message: PAST_THE_CHECK });
  });

  it("refuses its own issued HOME with the named reason once the HOME parent is moved away and a junction to it is left in its place", async () => {
    const homes = join(h.root, "homes");
    renameSync(homes, `${homes}.moved`);
    symlinkSync(`${homes}.moved`, homes, "junction");
    try {
      expect(await launch(own())).toMatchObject({ code: "sandbox-home-unavailable" });
    } finally {
      unlinkSync(homes);
      renameSync(`${homes}.moved`, homes);
    }
  });
});
