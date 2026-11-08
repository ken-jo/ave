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
    renderApproval({ ...baseRequest(), kind: "agent-action", source: "plugin", sourcePluginId: "calendar", toolName: "create-event", args: { title: "Review" } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.externalActionTitle", { server: "calendar", tool: "create-event" }));
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "calendar의 create-event을(를) 사용해도 될까요?" : "Use create-event from calendar?");
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("Review");
  });

  it.each(["en", "ko"] as const)("describes protected reads before their tool identity in %s", (locale) => {
    setLocale(locale);
    const decide = vi.fn();
    renderApproval({ ...baseRequest(), toolName: "read_file", toolCategory: "read", args: { path: "./private.env" },
      target: { filePath: "/workspace/private.env" } }, decide);
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "이 파일을 읽어도 될까요?" : "Read this file?");
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("/workspace/private.env");
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["en", "ko"] as const)("describes the copy source and destination in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), toolName: "copy_path", toolCategory: "write",
      args: { sourcePath: "./source", destinationPath: "./copy" },
      approvalMemory: { kind: "key", key: "copy", scope: { kind: "transfer", sourcePath: "/workspace/source", destinationPath: "/workspace/copy", overwrite: false } } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "이 파일이나 폴더를 복사해도 될까요?" : "Copy this file or folder?");
    const primary = screen.getByTestId("approval-action-primary");
    expect(primary).toHaveTextContent(locale === "ko" ? "원본: /workspace/source" : "From: /workspace/source");
    expect(primary).toHaveTextContent(locale === "ko" ? "대상: /workspace/copy" : "To: /workspace/copy");
  });

  it.each(["en", "ko"] as const)("describes the fetched URL in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), toolName: "web_fetch", toolCategory: "network", args: { url: "https://docs.example/page" } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "이 페이지를 가져와도 될까요?" : "Fetch this page?");
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("https://docs.example/page");
  });

  it.each(["en", "ko"] as const)("describes choosing upload files and the page destination in %s", (locale) => {
    setLocale(locale);
    renderApproval({ ...baseRequest(), toolName: "browser_upload", toolCategory: "network", args: { tabId: "browser:2", ref: "e4" },
      approvalMemory: { kind: "key", key: "upload", scope: { kind: "browser-origin", origin: "https://upload.example", tabOpener: "agent" } } }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(locale === "ko" ? "업로드할 파일을 선택할까요?" : "Choose files to upload?");
    const primary = screen.getByTestId("approval-action-primary");
    expect(primary).toHaveTextContent(locale === "ko" ? "업로드 대상: https://upload.example" : "Upload destination: https://upload.example");
    expect(primary).toHaveTextContent(locale === "ko" ? "페이지 요소: e4" : "Page element: e4");
  });

  it("keeps unknown builtins in action framing", () => {
    renderApproval({ ...baseRequest(), toolName: "unknown_action", toolCategory: "meta", args: {} }, vi.fn());
    expect(screen.getByTestId("approval-action-title")).toHaveTextContent(t("toolApprovalDialog.builtinActionTitle"));
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent("unknown_action");
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
