import { setImmediate } from "node:timers/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { requestBoundShellCard } from "../../__tests__/support/host-shell-approval.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import * as homeTrust from "../../shared/ave-home-trust.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { invocationApprovalPersistenceGuard } from "../approval-persistence-guard.js";
import { readPermissionsFile, updatePermissionsFile } from "../permissions-store.js";
import { readProjectRulesFile, updateProjectRulesFile } from "../rules/project-rule-files.js";
import { withShellPolicyMutation } from "../shell-policy-handoff.js";
import { listApprovals, recordApproval, userApprovalFilePath } from "../user-approval-store.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "approval-owner-queue-"));
  vi.stubEnv("AVE_HOME", home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupTmpDir(home);
});

it.each(["exact approval", "user rule", "project rule"] as const)("refuses a desk-approved %s when the owner changes behind another writer", async kind => {
  const sessionId = "queued-approval";
  let ownerMatches = true;
  const binding = bindRemoteControllerToSession({
    kind: "tailnet-controller",
    actorId: "tailnet:owner",
    pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
    pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => ownerMatches },
  }, sessionId);
  const authority = invocationApprovalPersistenceGuard(binding, sessionId);
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  const decision = requestBoundShellCard(gate, {
    id: "queued-approval", category: "tool", toolName: "bash", toolCategory: "shell",
    source: "builtin", sessionId, createdAt: Date.now(), args: { command: "printf queued" }, reason: "Needs approval",
    remoteControllerAuthority: binding, remoteControllerOrigin: binding.kind,
  }, home);
  await vi.waitFor(() => expect(sentApprovalCards(wc)).toHaveLength(1));
  const [card] = sentApprovalCards<ApprovalRequest>(wc);
  await gate.resolveFromDesktopRendererWithFreshIdentity(card.id, {
    requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
  }, wc as never);
  expect((await decision).choice).toBe("allow-once");

  const entered = deferred<void>();
  const release = deferred<void>();
  const approval = { scope: "persistent", verdictAtApproval: "low", nlJustification: null } as const;
  const rule = { action: "allow", pattern: "Bash(printf queued)" } as const;
  const userFile = join(home, "rules.json");
  const project = { filePath: join(home, "project-rules.json"), projectRoot: home, identity: "fixture" };
  let predecessor: Promise<void>;
  if (kind === "exact approval") {
    const read = homeTrust.readAveHomeInput;
    const spy = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
      if (path === userApprovalFilePath()) {
        spy.mockRestore();
        entered.resolve();
        await release.promise;
      }
      return read(path);
    });
    predecessor = recordApproval("earlier", "{}", "builtin", approval);
  } else {
    predecessor = withShellPolicyMutation(async () => {
      entered.resolve();
      await release.promise;
    });
  }
  await entered.promise;
  const save = kind === "exact approval" ? recordApproval("queued", "{}", "builtin", approval, authority)
    : kind === "user rule" ? updatePermissionsFile(userFile, file => { file.rules.push(rule); }, authority)
    : updateProjectRulesFile(project, file => { file.rules.push(rule); }, authority);
  const outcome = Promise.allSettled([save]);
  // Let an early probe complete while the earlier writer still holds the queue.
  await setImmediate();
  ownerMatches = false;
  release.resolve();
  await predecessor;
  const [result] = await outcome;

  if (kind === "exact approval") expect((await listApprovals()).map(entry => entry.toolName)).toEqual(["earlier"]);
  else if (kind === "user rule") expect(await readPermissionsFile(userFile)).toBeNull();
  else expect(await readProjectRulesFile(project)).toBeNull();
  expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "Approval authority is unavailable" }) });
  expect(authority?.isCurrent()).toBe(true);
});
