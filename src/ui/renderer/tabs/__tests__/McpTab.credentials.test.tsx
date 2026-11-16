// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { McpTab } from "../McpTab.js";
import { t } from "../../../../i18n/runtime.js";
import { MCP_CREDENTIAL_MIGRATION_FAILED } from "../../../../shared/mcp-error-code.js";

afterEach(() => vi.unstubAllGlobals());

describe("McpTab encrypted credentials", () => {
  it("explains a failed credential migration without rendering the raw host error", async () => {
    const rawMessage = `${MCP_CREDENTIAL_MIGRATION_FAILED}: host-only storage failure`;
    vi.stubGlobal("ave", { mcp: {
      servers: vi.fn(async () => []),
      getConfigs: vi.fn(async () => { throw new Error(`Error invoking remote method: ${rawMessage}`); }),
      getConfigPath: vi.fn(async () => "mcp/servers.json"),
    } });
    render(<McpTab />);
    expect(await screen.findByText(t("mcpTab.credentialMigrationFailed"))).toBeVisible();
    expect(screen.queryByText(rawMessage, { exact: false })).toBeNull();
  });
});
