// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

/** Every approval card displays the host-owned tool identity. */
const originalLocale = getLocale();
afterEach(() => {
  setLocale(originalLocale);
  vi.unstubAllGlobals();
});

function baseRequest(): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "agent_spawn",
    toolCategory: "meta",
    args: { title: "t" },
    reason: "review",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "high", reason: "test" },
  };
}

describe("ToolApprovalContent identity strip", () => {
  it.each(["en", "ko"] as const)("frames shell commands before their tool identity in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), toolName: "powershell", toolCategory: "shell", args: { command: "Get-Item ./report.md" } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.commandActionTitle"));
    const primary = screen.getByTestId("approval-action-primary");
    expect(primary).toHaveTextContent("Get-Item ./report.md");
    expect(primary.compareDocumentPosition(screen.getByTestId("approval-tool-identity")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(["write_file", "edit_file", "append_file"])("frames %s around its path", (toolName) => {
    renderApproval({ ...baseRequest(), toolName, toolCategory: "write", args: { path: "/workspace/report.md", content: "updated" } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.fileActionTitle"));
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("/workspace/report.md");
  });

  it.each(["en", "ko"] as const)("asks to use the external tool in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), source: "mcp", toolName: "mcp__docs__publish", args: { documentId: "report", public: true },
      approvalMemory: { kind: "key", key: "external", scope: { kind: "mcp-tool", serverId: "docs", toolName: "publish" } } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.externalActionTitle", { server: "docs", tool: "publish" }));
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "docs의 publish을(를) 사용해도 될까요?" : "Use publish from docs?");
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent('"documentId": "report"');
  });

  it.each(["en", "ko"] as const)("asks to use the host-owned plugin tool in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), kind: "agent-action", sourcePluginId: "calendar", toolName: "create-event", args: { title: "Review" } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.externalActionTitle", { server: "calendar", tool: "create-event" }));
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "calendar의 create-event을(를) 사용해도 될까요?" : "Use create-event from calendar?");
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("Review");
  });

  it("keeps the generic fallback title", () => {
    renderApproval(baseRequest(), vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.toolApprovalTitle"));
  });

  it("offers no remembered shell allow when the host supplies no command rule", () => {
    renderApproval({ ...baseRequest(), toolName: "bash", toolCategory: "shell", args: { command: "printf ready" },
      shellRule: { dialect: "bash", projectCwd: "/workspace", projectRoot: "/workspace", denyRule: null, denyAllowed: false, exactRule: null, sessionAllowed: false, persistentAllowed: false } }, vi.fn());
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.queryByText("Allow bash")).toBeNull();
    expect(screen.queryByTestId("approval-edit-rule")).toBeNull();
  });

  it("names the tool on a plain request (unchanged behavior)", () => {
    renderApproval(baseRequest(), vi.fn());
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("agent_spawn");
  });

  it("renders a path-grant request inside the same frame, identity strip included", () => {
    // Path grants share approval framing while allow-always retains parent-directory semantics.
    renderApproval({
      ...baseRequest(),
      kind: "out-of-allowed-dir",
      toolName: "write_file",
      toolCategory: "write",
      outOfAllowedDir: {
        candidatePath: "/workspace/out/report.md",
        suggestedParent: "/workspace/out",
        currentAllowed: ["/workspace/project"],
        adjacencyWarnings: [],
      },
    }, vi.fn());
    expect(screen.getByTestId("tool-approval-panel")).toBeInTheDocument();
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("write_file");
    // The one generic decision row serves path grants too.
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.approvalReviewDetails)).toBeInTheDocument();
    expect(screen.getByTestId("approval-path-grant-evidence")).toBeInTheDocument();
  });

  it("panel A/D shortcuts are inert for a path-grant request", () => {
    // The user may have navigated to the allow-always (parent grant) scope;
    // the generic A shortcut would commit a plain allow-once and silently
    // discard that selection. These shortcuts never existed for this kind
    // before the frame unification and must stay absent (review MAJOR).
    const onDecide = vi.fn();
    const { allowedChoices: _unconstrained, ...openChoices } = baseRequest();
    renderApproval({
      ...openChoices,
      kind: "out-of-allowed-dir",
      toolName: "write_file",
      toolCategory: "write",
      outOfAllowedDir: {
        candidatePath: "/workspace/out/report.md",
        suggestedParent: "/workspace/out",
        currentAllowed: ["/workspace/project"],
        adjacencyWarnings: [],
      },
    }, onDecide);
    const panel = screen.getByTestId("tool-approval-panel");
    // Focus the parent-grant decision, as a keyboard user would before committing.
    screen.getByTestId(TEST_IDS.allowSessionButton).focus();
    fireEvent.keyDown(panel, { key: "a" });
    fireEvent.keyDown(panel, { key: "d" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});
