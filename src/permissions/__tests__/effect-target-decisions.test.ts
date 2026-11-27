import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
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
import { createPluginStorage } from "../../plugins/storage.js";
import { __resetRunGrantsForTest, registerRunSession } from "../run-grants.js";

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
    __resetRunGrantsForTest();
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses an in-root storage target change during a delegated write", async () => {
    const original = join(storage, "original");
    const replacement = join(storage, "replacement");
    const alias = join(storage, "alias");
    mkdirSync(original);
    mkdirSync(replacement);
    symlinkSync(original, alias, "junction");
    const available = vi.fn(async () => {
      await Promise.resolve();
      unlinkSync(alias);
      symlinkSync(replacement, alias, "junction");
      return true;
    });
    const storageApi = createPluginStorage("p1", storage, {
      isAsyncEncryptionAvailable: available,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptStringAsync: async () => Buffer.from("sealed"),
      decryptStringAsync: async () => ({ result: "", shouldReEncrypt: false }),
    });
    const gate = { requestAndWait: answeringRequestAndWait(async () => ({ choice: "allow-once" as const })) } as unknown as ApprovalGate;
    const api = enforceMutatingEffects({ storage: storageApi }, {
      pluginId: "p1", approvalGate: gate, permissionManager: manager, resolveStoragePath: storageApi.resolve, assertActive: () => {},
    });
    await expect(runWithEffectGateContext({ headless: false, toolName: "t" }, () =>
      api.storage.writeEncrypted("alias/new.txt", "value"))).rejects.toThrow("Effect target changed");
    expect(available).toHaveBeenCalledOnce();
    expect(existsSync(join(replacement, "new.txt"))).toBe(false);
    expect(existsSync(join(original, "new.txt"))).toBe(false);
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

  it("rejudges all worker grants and current policy together after the card", async () => {
    const read = join(root, "read");
    const write = join(root, "write");
    mkdirSync(read);
    mkdirSync(write);
    const spawnWorker = vi.fn(async (_request: { allowReadPaths: string[]; allowWritePaths: string[] }) => ({ pid: 1, socketPath: null }));
    const check = manager.checkDetailed.bind(manager);
    const postCardQueries: string[][] = [];
    let afterCard = false;
    vi.spyOn(manager, "checkDetailed").mockImplementation((...args) => {
      const verdict = check(...args);
      if (afterCard) postCardQueries.push(query.mock.calls.map(([drive]) => drive.toUpperCase()));
      return verdict;
    });
    const answer = vi.fn(async () => {
      registerRunSession("work-board:7#run-a", "sibling-stage-session", { stageId: "build", stageName: "Build", lane: "attended" });
      manager.addRunRule("sibling-stage-session", "Bash(npm test)");
      query.mockClear();
      afterCard = true;
      return { choice: "allow-once" as const };
    });
    const api = enforceMutatingEffects({ spawnWorker }, {
      pluginId: "p1",
      approvalGate: { requestAndWait: answeringRequestAndWait(answer) } as unknown as ApprovalGate,
      permissionManager: manager, resolveStoragePath: (rel) => join(storage, rel), assertActive: () => {},
    });
    const request = { allowReadPaths: [read], allowWritePaths: [write] };
    await expect(runWithEffectGateContext({ headless: false, toolName: "t" }, () => api.spawnWorker(request))).resolves.toMatchObject({ pid: 1 });
    expect(answer).toHaveBeenCalledOnce();
    expect(postCardQueries).toHaveLength(1);
    expect(postCardQueries[0]?.length).toBeGreaterThan(0);
    expect(postCardQueries[0]).toEqual([...new Set(postCardQueries[0])]);
    expect(spawnWorker).toHaveBeenCalledExactlyOnceWith(request);
  });
});
