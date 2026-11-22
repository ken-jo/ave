vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { aveHome } from "../../shared/ave-home.js";
import { GlobFilesTool, GrepFilesTool, ListFilesTool } from "../../tools/file-tools.js";
import { createAveHomeBoundarySnapshot } from "../ave-home-boundary-snapshot.js";
import { aveHomeReadBoundaryCovering, getBuiltinShellReadPolicy } from "../asrt-sandbox.js";
import { decidePermission } from "../decision-pipeline.js";
import { PermissionManager } from "../permission-manager.js";
import { bindStageWorkspace, boundStageWorkspace, isOwnStageWorkspacePath, unbindStageWorkspace } from "../stage-workspace-binding.js";

installVerifiedAveHomePrivacy();

const STAGE = "stage-session";
const GRANDCHILD = "grandchild-session";
const OTHER = "other-session";
let home: string;
let runRoot: string;
let own: string;
let sibling: string;
let manager: PermissionManager;
let run = 0;

/** The protected-path floor of one write, asked the three ways a tool reaches the decision: path facts, an edit subject, a shell command. */
async function floors(sessionId: string | undefined, target: string): Promise<(string | undefined)[]> {
  const session = sessionId === undefined ? {} : { sessionId };
  const facts = manager.checkDetailed("write_file", "builtin", "write", null, {
    ...session,
    paths: [{ lexical: target, canonical: target, effect: "write" }],
    fileWritePolicy: { insideProject: true, checkpointAvailable: true, directoryApproved: false },
  });
  const cwd = dirname(target);
  await manager.ensureProjectRulesLoaded(cwd);
  const edit = manager.checkDetailed("write_file", "builtin", "write", null, { ...session, projectRulesCwd: cwd, ruleSubject: { kind: "edit", cwd, paths: [basename(target)] } });
  const shell = manager.checkDetailed(process.platform === "win32" ? "powershell" : "bash", "builtin", "shell", null, {
    ...session,
    ruleSubject: process.platform === "win32"
      ? { kind: "shell", dialect: "powershell", command: `Set-Content -Path ${basename(target)} -Value y`, cwd }
      : { kind: "shell", dialect: "bash", command: `echo y > ${basename(target)}`, cwd },
    shellExecution: { runsSandboxed: true, environmentSnapshot: {} },
  });
  return [facts, edit, shell].map(result => result.pipelineRequest?.floor?.code === "protected-path" ? "protected-path" : undefined);
}
const CARVED = [undefined, undefined, undefined];
const FLOORED = ["protected-path", "protected-path", "protected-path"];

type Checked = ReturnType<PermissionManager["checkDetailed"]>;
/** The decision of one host read, asked as each read tool and as a shell command, on the host and sandboxed. */
async function reads(sessionId: string | undefined, target: string, source: "builtin" | "mcp" | "plugin" = "builtin"): Promise<Checked[]> {
  const session = sessionId === undefined ? {} : { sessionId };
  const paths = [{ lexical: target, canonical: target, effect: "read" as const }];
  if (source !== "builtin") return [manager.checkDetailed("mcp__server__read", source, "read", null, { ...session, paths })];
  const cwd = dirname(target);
  await manager.ensureProjectRulesLoaded(cwd);
  const shell = (runsSandboxed: boolean): Checked => manager.checkDetailed(process.platform === "win32" ? "powershell" : "bash", "builtin", "shell", null, {
    ...session,
    ruleSubject: process.platform === "win32"
      ? { kind: "shell", dialect: "powershell", command: `Get-Content -Path '${target}'`, cwd }
      : { kind: "shell", dialect: "bash", command: `cat '${target}'`, cwd },
    shellExecution: { runsSandboxed, environmentSnapshot: {} },
  });
  return [
    ...["read_file", "list_files", "glob_files", "grep_files"].map(tool => manager.checkDetailed(tool, "builtin", "read", null, { ...session, paths })),
    shell(false),
    shell(true),
  ];
}
const floorCodes = (results: Checked[]): (string | undefined)[] => results.map(result => result.pipelineRequest?.floor?.code);
const everyRead = (code: string | undefined): (string | undefined)[] => Array.from({ length: 6 }, () => code);
const inSession = <T>(sessionId: string | undefined, compose: () => T): T => createAveHomeBoundarySnapshot(sessionId).run(compose);

beforeEach(() => {
  run += 1;
  home = realpathSync.native(aveHome());
  runRoot = join(home, "worktrees", "project-0a1b2c3d", `${String(run).padStart(4, "0")}89abcdef`);
  own = join(runRoot, "s1");
  sibling = join(runRoot, "s2");
  for (const folder of [own, sibling, join(runRoot, "_join"), join(runRoot, "_out"), join(home, "config")]) mkdirSync(folder, { recursive: true });
  manager = new PermissionManager(join(mkdtempSync(join(tmpdir(), "swb-")), "permissions.json"));
  manager.setMode("default");
  bindStageWorkspace(STAGE, own);
});

afterEach(() => {
  for (const sessionId of [STAGE, GRANDCHILD, OTHER]) unbindStageWorkspace(sessionId);
});

describe("stage workspace binding", () => {
  it("a read and a write inside the bound workspace are not a protected-path floor", async () => {
    expect(boundStageWorkspace(STAGE)).toBe(own);
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    expect(await floors(STAGE, join(own, "src", "deep", "new.ts"))).toEqual(CARVED);
    // A read inside the home is stopped by the sandbox read boundary; the bound folder is re-allowed there.
    expect(inSession(STAGE, () => aveHomeReadBoundaryCovering(join(own, "notes.txt")))).toBeUndefined();
    const read = manager.checkDetailed("read_file", "builtin", "read", null, { sessionId: STAGE, paths: [{ lexical: join(own, "notes.txt"), canonical: join(own, "notes.txt"), effect: "read" }] });
    expect(read.pipelineRequest?.floor).toBeUndefined();
    // Repository control files and a nested application home stay protected inside it.
    expect(await floors(STAGE, join(own, ".git", "config"))).toEqual(FLOORED);
    mkdirSync(join(own, ".ave"));
    expect(isOwnStageWorkspacePath(STAGE, join(own, ".ave", "permissions.json"))).toBe(false);
    expect(await floors(STAGE, join(own, ".ave", "permissions.json"))).toEqual(FLOORED);
  });

  it("the binding refuses a sibling stage's workspace", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    expect(isOwnStageWorkspacePath(STAGE, join(sibling, "notes.txt"))).toBe(false);
    expect(await floors(STAGE, join(sibling, "notes.txt"))).toEqual(FLOORED);
    // The sibling's own session is carved out for it, and still not for the first one.
    bindStageWorkspace(OTHER, sibling);
    expect(await floors(OTHER, join(sibling, "notes.txt"))).toEqual(CARVED);
    expect(await floors(STAGE, join(sibling, "notes.txt"))).toEqual(FLOORED);
    expect(await floors(OTHER, join(own, "notes.txt"))).toEqual(FLOORED);
  });

  it("the binding refuses the run root, _join and _out", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    for (const target of [join(runRoot, "_run.json"), join(runRoot, "_join", "notes.txt"), join(runRoot, "_out", "notes.txt"), join(dirname(runRoot), "notes.txt")]) {
      expect(isOwnStageWorkspacePath(STAGE, target), target).toBe(false);
      expect(await floors(STAGE, target), target).toEqual(FLOORED);
    }
  });

  it("the binding refuses the Ave home settings file and the configuration folder", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    for (const target of [join(home, "settings.json"), join(home, "config", "settings.json"), join(home, "permissions.json")]) {
      expect(isOwnStageWorkspacePath(STAGE, target), target).toBe(false);
      expect((await floors(STAGE, target)).slice(0, 2), target).toEqual(FLOORED.slice(0, 2));
    }
  });

  it("a symbolic link or junction inside the workspace that points at a sibling or at the Ave home is refused", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    symlinkSync(sibling, join(own, "to-sibling"), "junction");
    symlinkSync(join(home, "config"), join(own, "to-config"), "junction");
    for (const target of [join(own, "to-sibling", "notes.txt"), join(own, "to-config", "settings.json")]) {
      expect(isOwnStageWorkspacePath(STAGE, target), target).toBe(false);
      expect((await floors(STAGE, target))[0], target).toBe("protected-path");
    }
    // A link that stays inside the workspace is still the workspace.
    mkdirSync(join(own, "real"));
    symlinkSync(join(own, "real"), join(own, "to-real"), "junction");
    expect(isOwnStageWorkspacePath(STAGE, join(own, "to-real", "notes.txt"))).toBe(true);
  });

  it("a spelling with .. that leaves the workspace is refused", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    const leaving = `${own}/../s2/notes.txt`;
    expect(isOwnStageWorkspacePath(STAGE, leaving)).toBe(false);
    // Even one that comes back in: the spelling is not collapsed for the caller.
    expect(isOwnStageWorkspacePath(STAGE, `${own}/sub/../notes.txt`)).toBe(false);
    expect(isOwnStageWorkspacePath(STAGE, "notes.txt")).toBe(false);
    const facts = manager.checkDetailed("write_file", "builtin", "write", null, {
      sessionId: STAGE, paths: [{ lexical: leaving, canonical: join(sibling, "notes.txt"), effect: "write" }],
      fileWritePolicy: { insideProject: true, checkpointAvailable: true, directoryApproved: false },
    });
    // The escape is named first; either way the write is floored.
    expect(facts.pipelineRequest?.floor?.code).toBe("project-escape");
    // A lexical spelling inside the workspace whose physical target is elsewhere is not carved out either.
    const split = manager.checkDetailed("write_file", "builtin", "write", null, {
      sessionId: STAGE, paths: [{ lexical: join(own, "notes.txt"), canonical: join(home, "config", "settings.json"), effect: "write" }],
      fileWritePolicy: { insideProject: true, checkpointAvailable: true, directoryApproved: false },
    });
    expect(split.pipelineRequest?.floor?.code).toBe("protected-path");
  });

  it("a grandchild is carved out for its stage's workspace only", async () => {
    bindStageWorkspace(GRANDCHILD, own);
    expect(await floors(GRANDCHILD, join(own, "notes.txt"))).toEqual(CARVED);
    expect(await floors(GRANDCHILD, join(sibling, "notes.txt"))).toEqual(FLOORED);
    expect(await floors(GRANDCHILD, join(runRoot, "_out", "notes.txt"))).toEqual(FLOORED);
    // The grandchild ending does not end its stage's binding.
    unbindStageWorkspace(GRANDCHILD);
    expect(await floors(GRANDCHILD, join(own, "notes.txt"))).toEqual(FLOORED);
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
  });

  it("a session with no binding gets no carve-out", async () => {
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(CARVED);
    expect(await floors(OTHER, join(own, "notes.txt"))).toEqual(FLOORED);
    expect(await floors(undefined, join(own, "notes.txt"))).toEqual(FLOORED);
    unbindStageWorkspace(STAGE);
    expect(boundStageWorkspace(STAGE)).toBeUndefined();
    expect(await floors(STAGE, join(own, "notes.txt"))).toEqual(FLOORED);
  });

  it("bindStageWorkspace throws for a root that is not a real four-segment stage folder", () => {
    const refused = (root: string): void => {
      expect(() => bindStageWorkspace(OTHER, root), root).toThrow();
      expect(boundStageWorkspace(OTHER)).toBeUndefined();
    };
    for (const root of [home, join(home, "worktrees"), dirname(runRoot), runRoot, join(runRoot, "_join"), join(runRoot, "_out"), join(own, "deeper"), join(runRoot, "missing")]) refused(root);
    refused(join(home, "workspace"));
    refused(join(homedir(), "alice-project"));
    refused(`${own}/../s2`);
    refused("worktrees/project-0a1b2c3d/000089abcdef/s1");
    // A file, and a link that points at a real stage folder, are not stage folders.
    writeFileSync(join(runRoot, "s3"), "");
    refused(join(runRoot, "s3"));
    symlinkSync(sibling, join(runRoot, "s4"), "junction");
    refused(join(runRoot, "s4"));
    mkdirSync(join(own, "deeper"), { recursive: true });
    refused(join(own, "deeper"));
    expect(() => bindStageWorkspace("", sibling)).toThrow();
    bindStageWorkspace(OTHER, sibling);
    expect(boundStageWorkspace(OTHER)).toBe(sibling);
  });

  it("the sandbox profile of a bound session re-opens its own folder and no sibling", () => {
    // The sibling is live too: each session's profile opens its own folder and never the other's.
    bindStageWorkspace(OTHER, sibling);
    const closed = [runRoot, join(runRoot, "_join"), join(runRoot, "_out"), join(runRoot, "_run.json"), dirname(runRoot), join(home, "worktrees")];
    const grants = (sessionId: string | undefined): readonly string[] => getBuiltinShellReadPolicy([own, sibling, ...closed], homedir(), undefined, createAveHomeBoundarySnapshot(sessionId)).allowRead;
    for (const [sessionId, mine, theirs] of [[STAGE, own, sibling], [OTHER, sibling, own]] as const) {
      inSession(sessionId, () => {
        expect(aveHomeReadBoundaryCovering(mine)).toBeUndefined();
        expect(aveHomeReadBoundaryCovering(join(mine, "src", "a.ts"))).toBeUndefined();
        for (const path of [theirs, join(theirs, "notes.txt"), ...closed]) expect(aveHomeReadBoundaryCovering(path), path).toBeDefined();
      });
      const granted = grants(sessionId);
      expect(granted).toContain(mine);
      for (const path of [theirs, ...closed]) expect(granted, path).not.toContain(path);
    }
    // The deny over the home, or over its `worktrees` child, stays; the grant above is the only opening in it.
    const denied = getBuiltinShellReadPolicy([own], homedir(), undefined, createAveHomeBoundarySnapshot(STAGE)).denyRead.map(entry => entry.replace(/[\\/]+$/u, "").toLowerCase());
    expect(denied.includes(home.toLowerCase()) || denied.includes(join(home, "worktrees").toLowerCase())).toBe(true);
    // A composition for no session, or for a session bound to nothing, opens nothing beneath `worktrees`.
    for (const sessionId of [undefined, "plain-session"]) {
      const granted = grants(sessionId);
      for (const path of [own, sibling]) {
        expect(granted, path).not.toContain(path);
        expect(inSession(sessionId, () => aveHomeReadBoundaryCovering(path)), path).toBeDefined();
      }
    }
    for (const path of [own, sibling]) expect(getBuiltinShellReadPolicy([own, sibling], homedir()).allowRead, path).not.toContain(path);
    // With the session over, its folder is closed to it again.
    unbindStageWorkspace(STAGE);
    expect(inSession(STAGE, () => aveHomeReadBoundaryCovering(own))).toBeDefined();
    expect(grants(STAGE)).not.toContain(own);
  });

  it("a host read of another stage's workspace is a protected-path floor, and of its own is not", async () => {
    const otherRun = join(dirname(runRoot), "ffff89abcdef", "s1");
    mkdirSync(otherRun, { recursive: true });
    bindStageWorkspace(OTHER, sibling);
    bindStageWorkspace("other-run-session", otherRun);
    try {
      // Its own stage: read_file, list, glob, grep and both shells pass the floor.
      expect(floorCodes(await reads(STAGE, join(own, "notes.txt")))).toEqual(everyRead(undefined));
      expect(floorCodes(await reads(STAGE, own))).toEqual(everyRead(undefined));
      // A sibling stage, another run, and the folders around the stage: floored, whoever else is bound to them.
      for (const target of [join(sibling, "notes.txt"), sibling, join(otherRun, "notes.txt"), runRoot, join(runRoot, "_run.json"), join(runRoot, "_out", "notes.txt"), join(runRoot, "_join", "notes.txt"), dirname(runRoot), join(home, "worktrees")]) {
        expect(floorCodes(await reads(STAGE, target)), target).toEqual(everyRead("protected-path"));
      }
      expect(floorCodes(await reads(OTHER, join(own, "notes.txt")))).toEqual(everyRead("protected-path"));
      expect(floorCodes(await reads(OTHER, join(sibling, "notes.txt")))).toEqual(everyRead(undefined));
      // A grandchild reads its stage's folder and no other.
      bindStageWorkspace(GRANDCHILD, own);
      expect(floorCodes(await reads(GRANDCHILD, join(own, "notes.txt")))).toEqual(everyRead(undefined));
      expect(floorCodes(await reads(GRANDCHILD, join(sibling, "notes.txt")))).toEqual(everyRead("protected-path"));
      // A session bound to nothing, and no session at all.
      expect(floorCodes(await reads("plain-session", join(own, "notes.txt")))).toEqual(everyRead("protected-path"));
      expect(floorCodes(await reads(undefined, join(own, "notes.txt")))).toEqual(everyRead("protected-path"));
      // A plugin or MCP read carries no stage session.
      for (const source of ["mcp", "plugin"] as const) {
        expect(floorCodes(await reads(undefined, join(own, "notes.txt"), source))).toEqual(["protected-path"]);
        expect(floorCodes(await reads(undefined, join(sibling, "notes.txt"), source))).toEqual(["protected-path"]);
      }
      // The floor is a forced ask, and a denial where nobody can answer: the unattended lane splits off after it.
      const request = (await reads(STAGE, join(sibling, "notes.txt")))[0]?.pipelineRequest;
      if (request === undefined) throw new Error("the read was decided without a pipeline request");
      expect(request.floor).toEqual({ code: "protected-path", reason: "application-home" });
      for (const mode of ["strict", "default", "auto", "allow"] as const) {
        expect(decidePermission({ ...request, mode, headless: false }).outcome).toBe("ask-forced");
        expect(decidePermission({ ...request, mode, headless: true }).outcome).toBe("deny");
      }
      // A spelling through `..`, and a link from outside the home, do not get around it.
      expect(floorCodes(await reads(STAGE, `${own}/../s2/notes.txt`))).not.toContain(undefined);
      const link = join(mkdtempSync(join(tmpdir(), "swb-link-")), "to-sibling");
      symlinkSync(sibling, link, "junction");
      const linked = manager.checkDetailed("read_file", "builtin", "read", null, { sessionId: STAGE, paths: [{ lexical: join(link, "notes.txt"), canonical: join(sibling, "notes.txt"), effect: "read" }] });
      expect(linked.pipelineRequest?.floor?.code).toBe("protected-path");
      // A folder that only looks like it is no stage workspace.
      for (const target of [join(home, "worktrees-old", "notes.txt"), join(home, "workspace", "worktrees", "notes.txt"), join(tmpdir(), "worktrees", "notes.txt")]) {
        expect(floorCodes(await reads(STAGE, target)), target).toEqual(everyRead(undefined));
      }
    } finally {
      unbindStageWorkspace("other-run-session");
    }
  });

  it("a listing or a search from above the stage workspaces passes over them", async () => {
    writeFileSync(join(own, "needle-own.txt"), "needle\n");
    writeFileSync(join(sibling, "needle-sibling.txt"), "needle\n");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "needle-plain.txt"), "needle\n");
    const context = { cwd: own, extraAllowedDirectories: [], metadata: { sessionId: STAGE } };
    const outputs = async (path: string): Promise<string[]> => [
      (await new ListFilesTool().execute({ path, depth: 8 }, context)).output,
      (await new GlobFilesTool().execute({ pattern: "**/needle-*.txt", path }, context)).output,
      (await new GrepFilesTool().execute({ pattern: "needle", path }, context)).output,
    ].map(String);
    for (const output of await outputs(home)) {
      expect(output).toContain("needle-plain.txt");
      expect(output).not.toContain("needle-sibling.txt");
      expect(output).not.toContain("needle-own.txt");
    }
    // Asked for by name, the stage's own folder is listed and searched in full.
    for (const output of await outputs(own)) expect(output).toContain("needle-own.txt");
  });
});
