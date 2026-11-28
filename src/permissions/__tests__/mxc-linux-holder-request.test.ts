import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const floors = vi.hoisted(() => ({ root: "", home: "" }));
vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../asrt-sandbox.js")>(),
  getDefaultSensitiveReadDenyPaths: () => [join(floors.home, ".ssh")],
  aveHomeReadBoundaryRoots: () => [join(floors.home, ".ave")],
  appOwnedSandboxPrivateRoots: () => [],
  getProtectedReadDenyFloor: () => [join(floors.home, ".aws")],
  getDefaultSensitiveWriteDenyEntries: () => [join(floors.home, "work", ".vscode")],
  getUserReadDenies: () => [],
  getUserWriteDenies: () => [],
  runWithSandboxWritePreflight: async (_signal: AbortSignal, run: () => unknown) => run(),
}));
vi.mock("../mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => join(floors.root, "runtime"),
}));

const { buildBubblewrapHolderRequest, linuxContainerPolicyModel, linuxHolderPolicyModel, LINUX_HOLDER_BRIDGE_PORT } = await import("../mxc-linux.js");
const { posixPolicyLookups, rankPosixContainerRows } = await import("../mxc-posix.js");

// POSIX only: a Linux holder request is built over this host's real folders (canonical POSIX paths, owner and mode
// checks), so a Windows host has no paths it could describe; Windows holders build their own request.
describe.runIf(process.platform !== "win32")("Linux holder request", () => {
  let home: string;
  let work: string;
  let programs: { launcher: string; helper: string };
  beforeEach(() => {
    floors.root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-holder-request-")));
    home = join(floors.root, "home");
    floors.home = home;
    work = join(home, "work");
    for (const path of [work, join(home, ".ssh"), join(home, ".ave"), join(home, ".aws"), join(floors.root, "runtime"), join(floors.root, "app", "filter")]) {
      mkdirSync(path, { recursive: true });
    }
    programs = { launcher: join(floors.root, "app", "mxc", "lxc-exec"), helper: join(floors.root, "app", "filter", "apply-seccomp") };
  });
  afterEach(() => { rmSync(floors.root, { recursive: true, force: true }); });

  async function grantsFor(input: { allowRead?: string[]; allowWrite?: string[] } = {}) {
    const lookups = posixPolicyLookups(home, false);
    const { model } = await linuxHolderPolicyModel({ allowRead: input.allowRead ?? [], allowWrite: input.allowWrite ?? [], floorPierces: [], lookups, programs });
    return { lookups, grants: rankPosixContainerRows(model, "bubblewrap", lookups) };
  }

  function build(grants: Awaited<ReturnType<typeof grantsFor>>, proxySocket: string, env: Record<string, string> = {}) {
    return buildBubblewrapHolderRequest({ ...grants, argv: ["/usr/bin/node", "server.js"], cwd: work, env, proxySocket, helper: programs.helper });
  }

  it("has no proxy URL and no timeout, and exactly one proxy socket row, none offline", async () => {
    const grants = await grantsFor({ allowWrite: [work] });
    const socket = join(floors.root, "runtime", "holder-x", "proxy.sock");
    const request = build(grants, socket);
    expect(request).not.toHaveProperty("runtimeConfig");
    expect(request.process).not.toHaveProperty("timeout");
    expect(request.filesystem.readonlyPaths.filter(path => path === socket)).toHaveLength(1);
    expect(request.process.commandLine).toContain(`'--proxy-bridge' '${LINUX_HOLDER_BRIDGE_PORT}' '${socket}'`);
    expect(request.process.commandLine).toContain(`'--env' 'HTTPS_PROXY=http://127.0.0.1:${LINUX_HOLDER_BRIDGE_PORT}'`);
    const offline = build(grants, "offline");
    expect(offline.filesystem.readonlyPaths).not.toContain(socket);
    expect(offline.process.commandLine).not.toContain("--proxy-bridge");
    expect(offline.process.commandLine).not.toContain("--env");
    expect(offline.process.commandLine).toMatch(/^'.*apply-seccomp' '--ready-fd' '4' '--close-other-fds' '--' '\/usr\/bin\/node' 'server.js'$/u);
  });

  it("still denies a sensitive read, a protected-name write and the Ave home when the caller passes no rows", async () => {
    const { grants } = await grantsFor({ allowWrite: [work] });
    expect(grants.denied).toEqual(expect.arrayContaining([join(home, ".ssh"), join(home, ".ave"), join(home, ".aws"), join(floors.root, "runtime")]));
    expect(grants.readwrite).toContain(work);
    // The protected name under the write root is not writable: a read-only or denied row, never under readwrite alone.
    const vscode = join(work, ".vscode");
    expect([...grants.readonly, ...grants.denied, ...(grants.placeholders ?? []).map(row => row.path)]).toContain(vscode);
  });

  it.each([["/"], ["//"], ["/."], ["/usr/.."]])("refuses a caller that passes the read base %s", async (base) => {
    expect(() => linuxContainerPolicyModel({ allowRead: [base], allowWrite: [], denyRead: [], userDenyRead: [], floorPierces: [], derivedRows: [], programs }))
      .toThrow("read base");
    await expect(grantsFor({ allowRead: [base] })).rejects.toThrow("read base");
  });

  it.each([["BASH_FUNC_x%%"], ["BASH_ENV"], ["ENV"]])("refuses an environment with %s", async (name) => {
    const grants = await grantsFor({ allowWrite: [work] });
    expect(() => build(grants, "offline", { [name]: "x" })).toThrow(JSON.stringify(name));
  });

  it("puts the environment in the request, without proxy variables, never on the command line", async () => {
    const grants = await grantsFor({ allowWrite: [work] });
    const request = build(grants, "offline", { TOKEN: "secret", HTTPS_PROXY: "http://elsewhere" });
    expect(request.process.env).toEqual(["TOKEN=secret"]);
    expect(request.process.commandLine).not.toContain("secret");
  });

  it("never carries an absent deny under a read-only grant", async () => {
    const readOnly = join(home, "docs");
    mkdirSync(readOnly);
    const absent = join(readOnly, ".ssh-absent");
    // Control: the same absent deny under a write root is carried.
    const absentInWork = join(work, ".ssh-absent");
    const lookups = posixPolicyLookups(home, false);
    const model = linuxContainerPolicyModel({
      allowRead: [readOnly], allowWrite: [work], denyRead: [absent, absentInWork], userDenyRead: [], floorPierces: [], derivedRows: [], programs,
    });
    const request = build({ lookups, grants: rankPosixContainerRows(model, "bubblewrap", lookups) }, "offline");
    expect(request.filesystem.deniedPaths).not.toContain(absent);
    expect(request.filesystem.deniedPaths).toContain(absentInWork);
  });
});
