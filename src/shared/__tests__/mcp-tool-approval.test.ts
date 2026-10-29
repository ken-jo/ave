import { describe, expect, it } from "vitest";
import { createMcpToolApprovalScope, isMcpToolApprovalScope, matchesMcpToolApprovalMemory, mcpToolApprovalCacheKey } from "../mcp-tool-approval.js";
import { approvalCacheKeyIdentity } from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../canonical-json.js";
import { isSessionOnlyApprovalMemoryScope, type ApprovalMemory } from "../permissions-events.js";

const SCOPE = { kind: "mcp-tool", serverId: "catalog", toolName: "update" } as const;
const MEMORY: ApprovalMemory = { kind: "key", key: `mcp_catalog_update:${canonicalStringify({ scope: SCOPE, executionPlan: null })}`, scope: SCOPE };
const IDENTITY = { source: "mcp", toolName: "mcp_catalog_update", mcpServerId: "catalog", approvalCacheKey: 'mcp_catalog_update:["catalog","update"]', approvalMemory: MEMORY };

describe("tool approval scope validation", () => {
  it("accepts only a complete explicit server and tool scope", () => {
    expect(createMcpToolApprovalScope("catalog", "update")).toEqual(SCOPE);
    expect(isMcpToolApprovalScope(SCOPE)).toBe(true);
    expect(isSessionOnlyApprovalMemoryScope(SCOPE)).toBe(false);
    expect(mcpToolApprovalCacheKey(SCOPE)).toBe('["catalog","update"]');
    expect(matchesMcpToolApprovalMemory(IDENTITY)).toBe(true);
    expect(approvalCacheKeyIdentity(IDENTITY.approvalCacheKey, MEMORY)?.memoryKey).toBe(MEMORY.kind === "key" ? MEMORY.key : undefined);
  });

  it.each([null, [], {}, { ...SCOPE, serverId: "" }, { ...SCOPE, toolName: " " }, { ...SCOPE, serverId: 7 }, { ...SCOPE, origin: "https://example.test" }, { kind: "mcp-tool", serverId: "catalog" }])("rejects a malformed scope %j", (scope) => {
    expect(isMcpToolApprovalScope(scope)).toBe(false);
  });

  it.each([
    { source: "plugin" },
    { mcpServerId: "other" },
    { toolName: "mcp_catalog_delete" },
    { approvalCacheKey: 'mcp_catalog_update:["other","update"]' },
    { approvalMemory: { ...MEMORY, key: "wrong-memory-key" } as ApprovalMemory },
    { approvalMemory: { kind: "args" } as ApprovalMemory },
  ])("rejects identity mismatch %j", (patch) => {
    expect(matchesMcpToolApprovalMemory({ ...IDENTITY, ...patch })).toBe(false);
  });

  it("rejects hidden additional scope fields", () => {
    expect(isMcpToolApprovalScope(Object.defineProperty({ ...SCOPE }, "hidden", { value: true }))).toBe(false);
    expect(isMcpToolApprovalScope({ ...SCOPE, [Symbol("extra")]: true })).toBe(false);
  });

  it("rejects a forged or scope-mismatched identity before storage lookup", () => {
    expect(() => approvalCacheKeyIdentity(IDENTITY.approvalCacheKey, { ...MEMORY, key: "wrong" } as ApprovalMemory)).toThrow("does not match its scope");
    expect(() => approvalCacheKeyIdentity(IDENTITY.approvalCacheKey, { kind: "key", key: "wrong", scope: { ...SCOPE, serverId: "" } } as ApprovalMemory)).toThrow("Invalid tool approval scope");
  });
});
