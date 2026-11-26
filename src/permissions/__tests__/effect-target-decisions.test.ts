import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../shared/windows-drive-locality.js");

import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import type { ApprovalGate } from "../approval-gate.js";
import { __resetEffectGrantsForTest, enforceMutatingEffects, runWithEffectGateContext } from "../effect-enforcement.js";
import { PermissionManager } from "../permission-manager.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";

const LOCAL = String.raw`\Device\HarddiskVolume1`;

describe.runIf(process.platform === "win32")("plugin effect targets judged once and sealed to the effect", () => {
  const query = vi.fn<(drive: string) => string | null>();
  let root: string;
  let storage: string;
  let manager: PermissionManager;

  beforeEach(() => {
    __resetEffectGrantsForTest();
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-effect-targets-")));
    storage = join(root, "storage");
    mkdirSync(storage);
    manager = new PermissionManager(join(root, `policy-${randomUUID()}.json`));
    manager.setMode("strict");
    query.mockReset().mockReturnValue(LOCAL);
    setWindowsDriveQueryForTest(query);
  });

  afterEach(() => {
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses the effect when the drive query fails in the recheck after the card", async () => {
    let failNext = false;
    query.mockImplementation(() => {
      if (failNext) { failNext = false; throw new Error("drive query failed"); }
      return LOCAL;
    });
    const log: string[] = [];
    const gate = { requestAndWait: answeringRequestAndWait(async () => { failNext = true; return { choice: "allow-once" as const }; }) } as unknown as ApprovalGate;
    const enforced = enforceMutatingEffects({ storage: { write: async (_rel: string, _data?: unknown) => { log.push("write"); } } }, {
      pluginId: "p1", approvalGate: gate, permissionManager: manager, resolveStoragePath: (rel: string) => join(storage, rel), assertActive: () => {},
    });
    await expect(runWithEffectGateContext({ headless: false, toolName: "t" }, () => enforced.storage.write("a.txt", "x"))).rejects.toThrow();
    expect(failNext).toBe(false);
    expect(log).toEqual([]);
  });

  it("observes each drive once while judging the effect before the card", async () => {
    const load = manager.ensureProjectRulesLoaded.bind(manager);
    let judging: string[] | undefined;
    const judged: string[] = [];
    query.mockImplementation((drive) => { judging?.push(drive.toUpperCase()); return LOCAL; });
    vi.spyOn(manager, "ensureProjectRulesLoaded").mockImplementation(async (cwd) => { await load(cwd); judging = judged; });
    const gate = { requestAndWait: answeringRequestAndWait(async () => { judging = undefined; return { choice: "deny-once" as const }; }) } as unknown as ApprovalGate;
    const enforced = enforceMutatingEffects({ storage: { write: async (_rel: string, _data?: unknown) => {} } }, {
      pluginId: "p1", approvalGate: gate, permissionManager: manager, resolveStoragePath: (rel: string) => join(storage, rel), assertActive: () => {},
    });
    await expect(runWithEffectGateContext({ headless: false, toolName: "t" }, () => enforced.storage.write("a.txt", "x"))).rejects.toThrow();
    expect(judged.length).toBeGreaterThan(0);
    expect(judged).toEqual([...new Set(judged)]);
  });
});
