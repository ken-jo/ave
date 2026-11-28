import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAveHomeBoundarySnapshot } from "../ave-home-boundary-snapshot.js";
import * as shellReadPolicy from "../asrt-sandbox.js";
import * as shellWritePolicy from "../sandbox-write-jail.js";
import { endUnattendedStage, registerUnattendedStage } from "../unattended-lane-registry.js";

let root: string;
let home: string;
let workspace: string;
let references: string;
let tools: string;
const SESSION = "unattended-shell-policy";

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-unattended-shell-")));
  home = join(root, "home");
  workspace = join(home, "workspace");
  references = join(home, "references");
  tools = join(home, "toolchain", "bin");
  for (const folder of [workspace, references, tools, join(home, ".ssh"), join(root, "outside")]) {
    mkdirSync(folder, { recursive: true });
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("AVE_HOME", join(home, ".ave"));
});

afterEach(() => {
  endUnattendedStage(SESSION);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("only brings exact local PATH directories within home into the profile", () => {
  const credentialParent = join(home, "toolchain");
  const credential = join(credentialParent, "private");
  mkdirSync(credential);
  const ordinaryFile = join(home, "file");
  writeFileSync(ordinaryFile, "");
  const alias = join(home, "escaping-link");
  symlinkSync(join(root, "outside"), alias, "junction");
  const backslashSibling = `${home}\\bin`;
  if (process.platform !== "win32") mkdirSync(backslashSibling);
  const candidates = [backslashSibling, home, credentialParent, credential, tools, tools, alias, ordinaryFile, "", "bin", join(home, "missing")];
  expect(shellReadPolicy.getUnattendedPathReadRoots([home], candidates.join(delimiter), [credential])).toEqual([tools]);
});

it("denies home, omits saved history and reopens only the profile and the invocation HOME", () => {
  const other = join(home, "other");
  const ownHome = join(root, "sandbox-home");
  const snapshot = createAveHomeBoundarySnapshot(SESSION);
  const read = (session?: typeof snapshot) =>
    shellReadPolicy.getBuiltinShellReadPolicy([other, home, workspace, ownHome], home, ownHome, session, "mxc");
  const ordinary = read();
  expect(read(snapshot)).toEqual(ordinary);
  registerUnattendedStage(SESSION, {
    runKey: "run", stageId: "stage", workspaceRoot: workspace,
    envelope: {
      tools: [], readRoots: [references], writePaths: [], commands: [], network: [], mcpReadOnlyTools: [],
      mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
    },
    isolation: { proven: true, profile: {
      readDenyRoots: [home], readRoots: [workspace, references, tools, join(home, ".ssh")], writeRoots: [workspace],
    } },
  });
  const policy = read(snapshot);
  expect(policy.denyRead).toContain(home);
  expect(new Set(policy.allowRead)).toEqual(new Set([workspace, references, tools, ownHome]));
  expect(policy.floorPierces).toEqual([]);
  expect(policy.withheldSessionReadRoot).toBeDefined();
  expect(read()).toEqual(ordinary);
  expect(shellWritePolicy.deriveSandboxWritePaths({
    allowedDirectories: [other, tmpdir()], ownerPluginSandboxRoot: join(root, "plugin"),
  }, SESSION)).toEqual([workspace]);
});

it.skipIf(process.platform === "win32")("withholds a toolchain root redirected to a backslash sibling", () => {
  const sibling = `${home}\\toolchain`;
  mkdirSync(sibling);
  const outside = join(sibling, "bin");
  mkdirSync(outside);
  rmSync(tools, { recursive: true });
  symlinkSync(outside, tools, "dir");
  registerUnattendedStage(SESSION, {
    runKey: "run", stageId: "stage", workspaceRoot: workspace,
    envelope: {
      tools: [], readRoots: [], writePaths: [], commands: [], network: [], mcpReadOnlyTools: [],
      mcpGenerationTools: [], pluginGenerationTools: [], outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
    },
    isolation: { proven: true, profile: {
      readDenyRoots: [home], readRoots: [workspace, tools], writeRoots: [workspace], toolchainReadRoots: [tools],
    } },
  });
  const snapshot = createAveHomeBoundarySnapshot(SESSION);
  const policy = shellReadPolicy.getBuiltinShellReadPolicy([], home, undefined, snapshot, "mxc");
  expect(policy.allowRead).toContain(workspace);
  expect(policy.allowRead).not.toContain(tools);
});
