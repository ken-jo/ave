// Plugin skill loading uses the same turn authority as plugin tools (docs/development/skill-loading-policy.md).
import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createSkillLoadTool, type SkillLoadToolDeps } from "../skill-load.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

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
