import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ConversationLoop, type ConversationLoopDeps } from "../conversation-loop.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";
import { getLocale, setLocale, t } from "../../i18n/index.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

type PermissionCommandFn = (
  args: string,
  inputOrigin: string,
  callbacks?: unknown,
) => Promise<string>;

function callPermission(
  loop: ConversationLoop,
  args: string,
  inputOrigin = "user-keyboard",
  callbacks?: unknown,
): Promise<string> {
  const fn = (loop as unknown as { handlePermissionCommand: PermissionCommandFn })
    .handlePermissionCommand.bind(loop);
  return fn(args, inputOrigin, callbacks);
}

function makeLoop(overrides: Partial<ConversationLoopDeps> = {}): ConversationLoop {
  return new ConversationLoop(makeConversationLoopDeps(overrides));
}

describe("ConversationLoop.handlePermissionCommand", () => {
  it("parse-error: an invalid mode value returns the parse-error message carrying the parser error", async () => {
    const loop = makeLoop();
    const result = await callPermission(loop, "mode not-a-mode");
    expect(result).toContain("invalid mode");
    expect(result).toContain("not-a-mode");
  });

  it("show-current: empty args reflect the PermissionManager's current mode", async () => {
    const permissionManager = {
      getMode: vi.fn(() => "strict" as const),
    } as unknown as ConversationLoopDeps["permissionManager"];
    const loop = makeLoop({ permissionManager });
    const result = await callPermission(loop, "");
    expect(result).toContain("strict");
  });

  it("show-current: without a PermissionManager reports the default mode", async () => {
    const loop = makeLoop({ permissionManager: undefined });
    const result = await callPermission(loop, "");
    expect(result).toContain("strict");
  });

  it("mode branch without a PermissionManager returns the no-manager guard", async () => {
    const loop = makeLoop({ permissionManager: undefined });
    const result = await callPermission(loop, "mode allow");
    expect(result).toBe(t("be_conversationLoop.permissionModeNoManager"));
  });

  it("rules branch without a PermissionManager returns the no-manager guard", async () => {
    const loop = makeLoop({ permissionManager: undefined });
    const result = await callPermission(loop, "rules list");
    expect(result).toBe(t("be_conversationLoop.permissionRulesNoManager"));
  });

  it("audit branch without an auditLogger returns the no-logger guard", async () => {
    // No audit logger is supplied, so this fixture exercises the unaudited branch.
    const loop = makeLoop();
    const result = await callPermission(loop, "audit show");
    expect(result).toBe(t("be_conversationLoop.permissionAuditNoLogger"));
  });

  it("reports an integrity error in audit show for an invalid terminal kind", async () => {
    const locale = getLocale();
    setLocale("en");
    onTestFinished(() => { setLocale(locale); });
    const dir = mkdtempSync(join(tmpdir(), "ave-slash-audit-show-"));
    onTestFinished(() => cleanupTmpDir(dir));
    const row = { auditId: "invalid-row", decision: "deny", terminalKind: "refused" };
    writeFileSync(join(dir, "2026-05-09.permission-audit.jsonl"), `${JSON.stringify(row)}\n`);
    const auditLogger = {
      getAuditDir: () => dir,
      getPermissionAuditSecret: () => null,
      getPermissionAuditSealStore: () => null,
      isPermissionAuditChainReady: () => false,
    } as unknown as ConversationLoopDeps["auditLogger"];

    const result = await callPermission(makeLoop({ auditLogger }), "audit show");
    expect(result).toContain("Audit latest 0");
    expect(result).toContain("Integrity error: invalid terminal kind in audit entries (1)");
    expect(result).not.toContain("invalid-row");
  });

  it("rules add persists an allow rule, re-syncs visibility deny rules, and echoes the rule", async () => {
    const addAlwaysAllowedPersist = vi.fn(async () => undefined);
    const permissionManager = {
      addAlwaysAllowedPersist,
      addAlwaysDeniedPersist: vi.fn(async () => undefined),
      getVisibilityDenyRules: vi.fn(() => [{ pattern: "x" }]),
    } as unknown as ConversationLoopDeps["permissionManager"];
    const setDenyRules = vi.fn();
    const baseDeps = makeConversationLoopDeps();
    const toolRegistry = {
      ...(baseDeps.toolRegistry as unknown as Record<string, unknown>),
      setDenyRules,
    } as unknown as ConversationLoopDeps["toolRegistry"];

    const loop = new ConversationLoop({ ...baseDeps, permissionManager, toolRegistry });
    const result = await callPermission(loop, "rules add allow foo_*");

    expect(addAlwaysAllowedPersist).toHaveBeenCalledWith("foo_*");
    expect(setDenyRules).toHaveBeenCalledWith([{ pattern: "x" }]);
    expect(result).toContain("allow");
    expect(result).toContain("foo_*");
  });

  it("rules remove delegates to removeRule and echoes the removed rule", async () => {
    const removeRule = vi.fn(async () => undefined);
    const permissionManager = {
      removeRule,
      getVisibilityDenyRules: vi.fn(() => []),
    } as unknown as ConversationLoopDeps["permissionManager"];
    const baseDeps = makeConversationLoopDeps();
    const toolRegistry = {
      ...(baseDeps.toolRegistry as unknown as Record<string, unknown>),
      setDenyRules: vi.fn(),
    } as unknown as ConversationLoopDeps["toolRegistry"];

    const loop = new ConversationLoop({ ...baseDeps, permissionManager, toolRegistry });
    const result = await callPermission(loop, "rules remove deny bar_*");

    expect(removeRule).toHaveBeenCalledWith("bar_*", "deny");
    expect(result).toContain("deny");
    expect(result).toContain("bar_*");
  });

  it("rules list with no persisted rules returns the empty-rules message", async () => {
    const permissionManager = {
      listPersistedRules: vi.fn(async () => []),
    } as unknown as ConversationLoopDeps["permissionManager"];
    const loop = makeLoop({ permissionManager });
    const result = await callPermission(loop, "rules list");
    expect(result).toBe(t("be_conversationLoop.permissionRulesEmpty"));
  });

  it("rules list renders persisted rules with action/pattern/source", async () => {
    const permissionManager = {
      listPersistedRules: vi.fn(async () => [
        { action: "allow", pattern: "foo_*", source: "user" },
      ]),
    } as unknown as ConversationLoopDeps["permissionManager"];
    const loop = makeLoop({ permissionManager });
    const result = await callPermission(loop, "rules list");
    expect(result).toContain("allow");
    expect(result).toContain("foo_*");
    expect(result).toContain("user");
  });

  it("non-user-keyboard origin is rejected by the dispatcher and lands in the unhandled branch", async () => {
    const loop = makeLoop();
    const result = await callPermission(loop, "mode allow", "plugin-emitted");
    expect(result).toBe(
      t("be_conversationLoop.permissionUnhandled", { kind: "rejected-non-user-origin" }),
    );
  });
});
