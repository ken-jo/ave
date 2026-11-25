vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { aveHome } from "../../shared/ave-home.js";
import { createAveHomeBoundarySnapshot } from "../ave-home-boundary-snapshot.js";
import { buildPerCommandSandboxCustomConfig } from "../asrt-sandbox.js";
import { bindStageWorkspace, unbindStageWorkspace } from "../stage-workspace-binding.js";

installVerifiedAveHomePrivacy();

const STAGE_A = "stage-a-session";
const STAGE_B = "stage-b-session";
let stageA: string;
let stageB: string;
let outside: string;

beforeEach(() => {
  const runRoot = join(realpathSync.native(aveHome()), "worktrees", "project-0a1b2c3d", "000189abcdef");
  stageA = join(runRoot, "s1");
  stageB = join(runRoot, "s2");
  for (const folder of [stageA, stageB]) mkdirSync(folder, { recursive: true });
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "swp-")));
  bindStageWorkspace(STAGE_A, stageA);
  bindStageWorkspace(STAGE_B, stageB);
});

afterEach(() => {
  for (const sessionId of [STAGE_A, STAGE_B]) unbindStageWorkspace(sessionId);
});

/** Which of the asked read grants the composed per-command profile keeps for a command of that session. */
function granted(sessionId: string | undefined): string[] {
  const asked = [stageA, stageB, outside];
  const allowRead = createAveHomeBoundarySnapshot(sessionId).run(() => buildPerCommandSandboxCustomConfig({ allowRead: asked, allowWrite: [], denyRead: [] }))?.filesystem?.allowRead ?? [];
  const fold = (path: string): string => path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return asked.filter(path => allowRead.some(entry => fold(typeof entry === "string" ? entry : entry.path) === fold(path)));
}

describe("stage workspace sandbox profile", () => {
  it("stage A's command reads its own workspace and not stage B's, and the reverse", () => {
    expect(granted(STAGE_A)).toEqual([stageA, outside]);
    expect(granted(STAGE_B)).toEqual([stageB, outside]);
  });

  it("a wrap composed without a session reads no stage workspace", () => {
    // A plugin child, an MCP server and a hook are composed with no session; so is a session bound to nothing.
    expect(granted(undefined)).toEqual([outside]);
    expect(granted("plain-session")).toEqual([outside]);
    unbindStageWorkspace(STAGE_A);
    expect(granted(STAGE_A)).toEqual([outside]);
  });
});
