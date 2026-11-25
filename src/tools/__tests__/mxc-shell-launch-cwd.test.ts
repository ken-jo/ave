import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerMxcShellLaunchAdmissionFixture } from "../../__tests__/support/mxc-shell-launch-admission.js";

const h = vi.hoisted(() => ({ root: "" }));
const PAST_THE_CHECK = "reached the listener, past the working-directory check";
vi.mock("../../permissions/egress-host-listener.js", () => ({
  openHostEgressListener: async () => { throw new Error(PAST_THE_CHECK); },
}));
vi.mock("../../permissions/mxc-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/mxc-windows.js")>(),
  resolveHostWxcExecPath: async () => "C:\\Ave\\resources\\mxc\\x64\\wxc-exec.exe",
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
  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-cwd-")));
    h.root = join(base, "cache", "mxc-runtime");
    mkdirSync(join(h.root, "homes"), { recursive: true });
    mkdirSync(`${h.root}-other`);
    symlinkSync(h.root, join(base, "link"), "junction");
  });
  afterAll(() => { rmSync(base, { recursive: true, force: true }); });

  const launch = async (cwd: string): Promise<unknown> => {
    const lifecycle = createContainedShellLifecycle();
    try {
      return await prepareMxcShellLaunch({ egressToken: "tok", commandLine: "cmd.exe /d /c echo hi", cwd,
        filesystem: { allowWrite: [cwd], allowRead: [], denyRead: [], denyWrite: [] },
        env: { SYSTEMROOT: "C:\\Windows" }, timeoutMs: 5_000, exists: () => true, list: () => [] }, lifecycle).catch((error: unknown) => error);
    } finally {
      await lifecycle.dispose();
    }
  };

  it.each([
    ["through a junction", () => join(base, "link", "homes")],
    ["in another case", () => join(h.root.toUpperCase(), "HOMES")],
    ["below the root, not yet created", () => join(h.root, "staging", "next")],
  ])("refuses one inside it %s", async (_case, cwd) => {
    expect(await launch(cwd())).toMatchObject({ message: "Container shell working directory is inside the sandbox runtime root" });
  });

  it("admits one beside it whose name only starts like it", async () => {
    expect(await launch(`${h.root}-other`)).toMatchObject({ message: PAST_THE_CHECK });
  });
});
