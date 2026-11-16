// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { McpTab } from "../McpTab.js";
import { t } from "../../../../i18n/runtime.js";
import { MCP_CONFIG_RECOVERY_REQUIRED, MCP_CREDENTIAL_MIGRATION_FAILED } from "../../../../shared/mcp-error-code.js";

afterEach(() => vi.unstubAllGlobals());

describe("McpTab encrypted credentials", () => {
  it.each([[MCP_CREDENTIAL_MIGRATION_FAILED, "mcpTab.credentialMigrationFailed"], [MCP_CONFIG_RECOVERY_REQUIRED, "mcpTab.configRecoveryRequired"]] as const)("explains %s without rendering the raw host error", async (code, key) => {
    const rawMessage = `${code}: host-only storage failure`;
    vi.stubGlobal("ave", { mcp: {
      servers: vi.fn(async () => []),
      getConfigs: vi.fn(async () => { throw new Error(`Error invoking remote method: ${rawMessage}`); }),
      getManagementState: vi.fn(async () => ({ policyPath: "governance/mcp-policy.json", policyStatus: "absent", userServersAllowed: true, managedServerIds: [], hasApiKey: {}, servers: {} })),
      getConfigPath: vi.fn(async () => "mcp/servers.json"),
    } });
    render(<McpTab />);
    expect(await screen.findByText(t(key))).toBeVisible();
    expect(screen.queryByText(rawMessage, { exact: false })).toBeNull();
  });
});
