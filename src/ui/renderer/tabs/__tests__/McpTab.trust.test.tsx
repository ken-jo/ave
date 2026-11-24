// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpTab } from "../McpTab.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

const config = { id: "local-notes", transport: "stdio" as const, command: "notes-server" };
const fingerprint = "a".repeat(64);
afterEach(() => vi.unstubAllGlobals());

function install(trusted = false, policy: { policyStatus: string; userServersAllowed: boolean } = { policyStatus: "absent", userServersAllowed: true }) {
  let present = true;
  let connected = false;
  const mcp = {
    servers: vi.fn(async () => connected ? [{ id: config.id, status: "connected", registeredTools: [] }] : []),
    getConfigs: vi.fn(async () => present ? [config] : []),
    getConfigPath: vi.fn(async () => "mcp/servers.json"),
    getManagementState: vi.fn(async () => ({ policyPath: "governance/mcp-policy.json", ...policy,
      managedServerIds: [], hasApiKey: {}, servers: { [config.id]: { fingerprint, trusted, arguments: ["--profile", "team alpha"], argumentCount: 2, environmentKeys: ["PROFILE"] } } })),
    startServer: vi.fn(async () => { connected = true; return { connected: true }; }),
    kill: vi.fn(async () => { connected = false; }),
    removeConfig: vi.fn(async () => { present = false; connected = false; }),
    undoRemove: vi.fn(async () => { present = true; }),
  };
  vi.stubGlobal("ave", { mcp });
  return mcp;
}

describe("McpTab server trust", () => {
  it("shows policy before editing and reviews exact command and arguments before first start", async () => {
    const mcp = install();
    render(<McpTab />);
    expect(await screen.findByTestId("mcp-policy-state")).toHaveTextContent(t("mcpTab.policyUserTrustAllowed"));
    fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.reviewAndStart") }));
    const review = screen.getByRole("group", { name: t("mcpTab.trustReviewTitle") });
    expect(review).toHaveTextContent('notes-server "--profile" "team alpha"');
    expect(review).toHaveTextContent("PROFILE");
    expect(mcp.startServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("mcpTab.trustAndStart") }));
    await waitFor(() => expect(mcp.startServer).toHaveBeenCalledExactlyOnceWith(config.id, fingerprint));
  });

  it.each([
    ["pending-review", "mcpTab.policyPendingReview"],
    ["invalid", "mcpTab.policyInvalid"],
  ] as const)("says why user trust is blocked while the policy file is %s", async (policyStatus, key) => {
    install(false, { policyStatus, userServersAllowed: false });
    render(<McpTab />);
    const state = await screen.findByTestId("mcp-policy-state");
    expect(state).toHaveTextContent(t(key));
    expect(state).not.toHaveTextContent(t("mcpTab.policyUserTrustBlocked"));
  });

  it("reconnects a trusted stopped server without asking for a second trust decision", async () => {
    const mcp = install(true);
    render(<McpTab />);
    fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.reconnect") }));
    await waitFor(() => expect(mcp.startServer).toHaveBeenCalledExactlyOnceWith(config.id, undefined));
    expect(screen.queryByRole("group", { name: t("mcpTab.trustReviewTitle") })).toBeNull();
  });

  it.each([
    ["en", "Use an absolute path or a program name on PATH."],
    ["ko", "절대 경로나 PATH에 있는 프로그램 이름을 사용하세요."],
  ])("shows actionable reconnect guidance for a relative command in %s", async (locale, guidance) => {
    const previousLocale = getLocale();
    setLocale(locale);
    try {
      const mcp = install(true);
      mcp.startServer.mockRejectedValueOnce(new Error("Error invoking remote method 'ave:mcp:start-server': Error: mcp-command-relative-path: Relative command refused."));
      render(<McpTab />);
      fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.reconnect") }));
      expect(await screen.findByText(guidance)).toBeVisible();
    } finally {
      setLocale(previousLocale);
    }
  });

  it("offers undo after remove and restores through main without reading secrets", async () => {
    const mcp = install(true);
    render(<McpTab />);
    fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.removeButton") }));
    fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.undoRemove") }));
    await waitFor(() => expect(mcp.undoRemove).toHaveBeenCalledExactlyOnceWith(config.id));
    expect(await screen.findByText(config.id)).toBeVisible();
  });
});
