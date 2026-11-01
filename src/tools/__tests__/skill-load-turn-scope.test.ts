// Plugin skill loading uses the same turn authority as plugin tools (docs/development/README.md#skill-loading-policy).
import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createSkillLoadTool, type SkillLoadToolDeps } from "../skill-load.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { resolveTurnExtensionPolicy, turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { makeMockWebContents, useTempPaths } from "../../__tests__/test-helpers.js";
import { SkillApprovalsStore } from "../../main/skill-approvals-store.js";
import { withInProcessFileQueue } from "../../lib/with-file-lock.js";

const approvalPath = useTempPaths("skill-controller-persistence-", "approvals.json");

const IN_SCOPE = "in-scope-plugin";
const OUT_OF_SCOPE = "out-of-scope-plugin";

function skillFixture(name: string) {
  return { name, description: "d", body: "body", resources: [] as const, frontmatter: {} };
}

// Pre-satisfy tool-owned gates so only turn scope can refuse.
function skillLoadHarness() {
  const acquirePluginGeneration = vi.fn(async () => ({
    generation: { pluginId: "x" } as never,
    release: () => undefined,
  }));
  const store = {
    load: vi.fn(async (name: string) => skillFixture(name)),
    loadPluginGeneration: vi.fn((_generation: unknown, name: string) => skillFixture(name)),
  };
  const deps = {
    store: store as unknown as SkillLoadToolDeps["store"],
    overlay: { register: vi.fn(), unregister: vi.fn() } as unknown as SkillLoadToolDeps["overlay"],
    approvals: { isApproved: async () => true, record: async () => undefined } as unknown as
      SkillLoadToolDeps["approvals"],
    // A throwing approval gate ensures scope tests cannot pass through an unrelated approval denial.
    approvalGate: {
      requestAndWait: async () => {
        throw new Error("approval gate must not be consulted in a turn-scope test");
      },
    } as unknown as SkillLoadToolDeps["approvalGate"],
    emit: vi.fn(),
    acquirePluginGeneration: acquirePluginGeneration as unknown as
      SkillLoadToolDeps["acquirePluginGeneration"],
  } satisfies SkillLoadToolDeps;

  const registry = new ToolRegistry();
  registry.register(createSkillLoadTool(deps));
  const wc = makeMockWebContents();
  const permissionManager = new PermissionManager("/tmp/nonexistent-permissions.json");
  // Allow later permission layers so only the earlier turn-scope gate can refuse.
  permissionManager.checkDetailed = () => ({
    decision: "allow",
    reason: "would otherwise allow",
    });
  const executor = new ToolExecutor(
    registry,
    undefined,
    permissionManager,
    undefined,
    new ApprovalGate(wc as never),
  );
  return { executor, acquirePluginGeneration, store };
}

async function loadSkill(
  harness: ReturnType<typeof skillLoadHarness>,
  skillName: string,
  allowedPluginIds: Set<string> | undefined,
) {
  const results = await harness.executor.executeAll(
    [{ id: `tu-${skillName}`, name: "skill_load", input: { skillName } }],
    {
      sessionId: "sess-skill-scope",
      permissionContext: {
        trustOrigin: "user-keyboard" as const,
        ...(allowedPluginIds ? { allowedPluginIds } : {}),
      },
    },
  );
  return results[0];
}

describe("skill_load — plugin skills obey the turn's plugin scope", () => {
  it("refuses an OUT-OF-SCOPE plugin's skill before any plugin work starts", async () => {
    const harness = skillLoadHarness();
    const result = await loadSkill(
      harness,
      `plugin:${OUT_OF_SCOPE}:helper`,
      new Set([IN_SCOPE]),
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain(OUT_OF_SCOPE);
    // Scope refusal must precede generation leasing and body reads.
    expect(harness.acquirePluginGeneration).not.toHaveBeenCalled();
    expect(harness.store.loadPluginGeneration).not.toHaveBeenCalled();
  });

  it("admits an IN-SCOPE plugin's skill (the gate narrows, it does not block plugin skills)", async () => {
    const harness = skillLoadHarness();
    const result = await loadSkill(harness, `plugin:${IN_SCOPE}:helper`, new Set([IN_SCOPE]));

    expect(result.is_error).toBeFalsy();
    expect(harness.acquirePluginGeneration).toHaveBeenCalledWith({
      pluginId: IN_SCOPE,
      localId: "helper",
    });
  });

  it("leaves USER skills alone — they have no plugin owner and are not turn-scoped", async () => {
    const harness = skillLoadHarness();
    // Empty set = deny-all plugins; a user skill must still load.
    const result = await loadSkill(harness, "my-user-skill", new Set<string>());

    expect(result.is_error).toBeFalsy();
    expect(harness.store.load).toHaveBeenCalledWith("my-user-skill");
    expect(harness.acquirePluginGeneration).not.toHaveBeenCalled();
  });

  it("applies no plugin scope when the turn declares none (main chat, unrestricted)", async () => {
    const harness = skillLoadHarness();
    const result = await loadSkill(harness, `plugin:${OUT_OF_SCOPE}:helper`, undefined);

    expect(result.is_error).toBeFalsy();
    expect(harness.acquirePluginGeneration).toHaveBeenCalled();
  });

  it("refuses EVERY plugin skill when the turn allows no plugins (deny-all is not allow-all)", async () => {
    const harness = skillLoadHarness();
    const result = await loadSkill(harness, `plugin:${IN_SCOPE}:helper`, new Set<string>());

    expect(result.is_error).toBe(true);
    expect(harness.acquirePluginGeneration).not.toHaveBeenCalled();
  });
});


describe("skill body approval controller authority", () => {
  it("records no grant when the host observes revocation while approval persistence waits in the write queue", async () => {
    const sessionId = "skill-persistence-owner";
    let current = true;
    let ownerAvailable = true;
    const authority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:skill-owner",
      pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
      pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => { current = ownerAvailable; return current; } },
    }, sessionId);
    const file = approvalPath();
    const approvals = new SkillApprovalsStore(file);
    const approve = vi.spyOn(approvals, "approve");
    let release!: () => void;
    const held = withInProcessFileQueue(file, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const register = vi.fn();
    const emit = vi.fn();
    const tool = createSkillLoadTool({ store: { load: async () => skillFixture("user-skill") } as unknown as SkillLoadToolDeps["store"],
      approvals, approvalGate: gate, overlay: { register } as unknown as SkillLoadToolDeps["overlay"], emit });
    const pending = turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(authority), () => tool.execute({ skillName: "user-skill" }, {
      cwd: process.cwd(), extraAllowedDirectories: [], metadata: { sessionId },
    }));
    try {
      await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());
      const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
      await gate.resolveWithFreshIdentity(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
      // The fresh probe ran before the queue; the synchronous commit fence sees a revocation recorded during the wait.
      current = false;
      ownerAvailable = false;
    } finally { release(); await held; }
    expect((await pending).isError).toBe(true);
    expect(await new SkillApprovalsStore(file).isApproved("user-skill", "body")).toBe(false);
    expect(register).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it.each(["local", "current", "revoked", "fresh-unavailable"] as const)("checks %s authority after an actual pending content card", async state => {
    const sessionId = "skill-controller-card";
    let current = true;
    let freshAvailable = true;
    const authority = state === "fresh-unavailable" ? bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:skill-controller", pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" }, pairedShareGuard: { isCurrent: () => current, refreshCurrent: async () => { current = freshAvailable; return current; } } }, sessionId) : state === "local" ? undefined : bindRemoteControllerToSession({
      kind: "platform-bridge", actorId: "skill-controller",
      bridgeBinding: { bridgeId: "bridge", bridgeEpoch: 1, routeId: "route", routeEpoch: 1, scope: "scope" },
      bridgeGuard: { isCurrent: () => current },
    }, sessionId);
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const requestAndWait = vi.spyOn(gate, "requestAndWait");
    const approve = vi.fn(async () => undefined);
    const register = vi.fn();
    const emit = vi.fn();
    const tool = createSkillLoadTool({
      store: { load: async () => skillFixture("user-skill") } as unknown as SkillLoadToolDeps["store"],
      overlay: { register } as unknown as SkillLoadToolDeps["overlay"],
      approvals: { isApproved: async () => false, approve } as unknown as SkillLoadToolDeps["approvals"],
      approvalGate: gate, emit,
    });
    const pending = turnExtensionPolicyContext.run(resolveTurnExtensionPolicy(authority), () => tool.execute({ skillName: "user-skill" }, {
      cwd: process.cwd(), extraAllowedDirectories: [], metadata: { sessionId },
    }));
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());
    const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(request.sessionId).toBe(sessionId);
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ remoteControllerAuthority: authority, remoteControllerOrigin: authority?.kind }));
    expect(gate.pendingCount).toBe(1);
    if (state === "revoked") current = false;
    if (state === "fresh-unavailable") freshAvailable = false;
    await gate.resolveWithFreshIdentity(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac });
    const result = await pending;
    expect(result.isError).toBe(state === "revoked" || state === "fresh-unavailable");
    expect(approve).toHaveBeenCalledTimes((state === "revoked" || state === "fresh-unavailable") ? 0 : 1);
    expect(register).toHaveBeenCalledTimes((state === "revoked" || state === "fresh-unavailable") ? 0 : 1);
    expect(emit).toHaveBeenCalledTimes((state === "revoked" || state === "fresh-unavailable") ? 0 : 1);
    expect(gate.pendingCount).toBe(0);
  });
});
