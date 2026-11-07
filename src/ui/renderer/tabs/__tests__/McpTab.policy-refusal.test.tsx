// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";
import { ipcRenderer } from "electron";
import { mcpApiSurface } from "../../../../preload/mcp-api-surface.js";
import { McpTab } from "../McpTab.js";

vi.mock("electron", () => ({ ipcRenderer: { invoke: vi.fn() } }));

const originalLocale = getLocale();
const SERVER_ID = "local-notes";

function governanceError(layer: number, reason: string, code?: string): Error {
  const message = t("be_mcpManager.governanceValidationFailed", { layer, reason });
  return new Error(`Error invoking remote method 'ave:mcp:config:add': Error: ${code ? `${code}: ` : ""}[mcp-manager] ${message}`);
}

async function openForm(error: Error) {
  vi.mocked(ipcRenderer.invoke).mockRejectedValue(error);
  const addConfig = vi.fn(mcpApiSurface.addConfig);
  const onNavigate = vi.fn();
  vi.stubGlobal("ave", { mcp: {
    servers: vi.fn(async () => []),
    getConfigs: vi.fn(async () => []),
    getConfigPath: vi.fn(async () => "mcp/servers.json"),
    addConfig,
  } });
  render(<McpTab onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole("button", { name: t("mcpTab.addServerButton") }));
  fireEvent.change(screen.getByLabelText(t("mcpTab.serverIdLabel")), { target: { value: SERVER_ID } });
  fireEvent.change(screen.getByLabelText(t("mcpTab.commandRequiredLabel")), { target: { value: "notes-server" } });
  fireEvent.click(screen.getByRole("button", { name: t("mcpTab.addButton") }));
  return { addConfig, onNavigate };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale(originalLocale);
});

describe.each(["en", "ko"] as const)("McpTab policy refusal in %s", (locale) => {
  it("shows policy and content-review steps and uses existing permissions navigation", async () => {
    setLocale(locale);
    const reason = "Refusal wording from a different host locale";
    const { addConfig, onNavigate } = await openForm(governanceError(1, reason, "mcp-governance-unapproved-server"));

    const guidance = await screen.findByText(t("mcpTab.policyApprovalGuidance"));
    expect(guidance).toHaveTextContent("governance/mcp-policy.json");
    expect(guidance).toHaveTextContent("1.");
    expect(guidance).toHaveTextContent("2.");
    expect(guidance).toHaveTextContent("3.");
    expect(guidance.parentElement?.parentElement).toHaveTextContent(governanceError(1, reason, "mcp-governance-unapproved-server").message);
    expect(screen.getByLabelText(t("mcpTab.serverIdLabel"))).toHaveValue(SERVER_ID);
    fireEvent.click(screen.getByRole("button", { name: t("mcpTab.openPermissionsButton") }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("permissions");
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("ave:mcp:config:add", { id: SERVER_ID, transport: "stdio", command: "notes-server" });
    expect(addConfig).toHaveBeenCalledExactlyOnceWith({ id: SERVER_ID, transport: "stdio", command: "notes-server" });

    addConfig.mockRejectedValueOnce(new Error("Configuration write failed"));
    fireEvent.click(screen.getByRole("button", { name: t("mcpTab.addButton") }));
    await screen.findByText("Configuration write failed");
    expect(screen.queryByText(t("mcpTab.policyApprovalGuidance"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("mcpTab.openPermissionsButton") })).toBeNull();
  });

  it.each(["generic", "other-layer", "other-reason", "uncoded-unapproved", "unknown-code"])("omits approval guidance for %s errors", async (kind) => {
    setLocale(locale);
    const reason = t("be_mcpGovernance.unapprovedServer", { id: SERVER_ID });
    const error = kind === "generic" ? new Error("Configuration write failed")
      : kind === "other-layer" ? governanceError(2, reason)
        : kind === "uncoded-unapproved" ? governanceError(1, reason)
          : kind === "unknown-code" ? governanceError(1, reason, "mcp-other-refusal")
            : governanceError(1, t("be_mcpGovernance.transportMismatch", { configTransport: "stdio", approvedTransport: "http" }));
    await openForm(error);
    await screen.findByText(error.message);
    expect(screen.queryByText(t("mcpTab.policyApprovalGuidance"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("mcpTab.openPermissionsButton") })).toBeNull();
  });
});

it.each(["mcpTab.policyApprovalGuidance", "mcpTab.openPermissionsButton"] as const)("defines %s in both catalogs", (key) => {
  for (const catalog of [en, ko]) {
    expect(Object.hasOwn(catalog, key)).toBe(true);
    expect(catalog[key].length).toBeGreaterThan(0);
  }
});
