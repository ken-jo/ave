// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";

/** File approval cards state the host's reason for asking and the place a change really lands. */
function fileRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-file-reason",
    category: "tool",
    kind: "tool",
    toolName: "write_file",
    toolCategory: "write",
    args: { path: "/work/project/linked.txt", content: "x" },
    target: { filePath: "/work/project/linked.txt" },
    reason: "This write requires approval.",
    source: "builtin",
    createdAt: 0,
    requireExplicit: true,
    trustOrigin: "llm-tool-arg",
    ...overrides,
  } as ApprovalRequest;
}

function outsideRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return fileRequest({
    kind: "out-of-allowed-dir",
    reason: "The target escapes the project boundary.",
    outOfAllowedDir: { candidatePath: "/work/project/linked.txt", suggestedParent: "/work/project", currentAllowed: ["/work/project"], adjacencyWarnings: [] },
    ...overrides,
  });
}

describe("symlink-escape card", () => {
  const escapeFields = { reasonCode: "project-escape", allowedChoices: ["allow-once", "deny-once"],
    target: { filePath: "/work/project/linked.txt", canonicalPath: "/Users/me/Outside-Target.txt" } } as Partial<ApprovalRequest>;

  it.each([["folder", outsideRequest(escapeFields)], ["tool", fileRequest(escapeFields)]] as const)("shows the real target and the escape reason on the %s card", (_kind, request) => {
    renderApproval(request, vi.fn());
    expect(screen.getByTestId("approval-real-target")).toHaveTextContent(`${t("toolApprovalDialog.realTarget")} /Users/me/Outside-Target.txt`);
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonProjectEscape"));
  });

  it("spells hidden characters in the real target and warns about them", () => {
    const rlo = String.fromCodePoint(0x202e);
    renderApproval(fileRequest({ ...escapeFields, target: { filePath: "/work/project/linked.txt", canonicalPath: `/Users/me/safe${rlo}gnp.exe` } }), vi.fn());
    expect(screen.getByTestId("approval-real-target")).toHaveTextContent("/Users/me/safe⟨U+202E⟩gnp.exe");
    expect(screen.getByTestId("tool-approval-card").textContent).not.toContain(rlo);
    expect(screen.getByTestId("approval-hidden-characters-warning")).toBeInTheDocument();
  });

  it("does not claim a link when the operand itself walks out of the project", () => {
    renderApproval(fileRequest({ reasonCode: "project-escape", allowedChoices: ["allow-once", "deny-once"],
      toolName: "read_file", toolCategory: "read", args: { path: "../outside.txt" }, target: { filePath: "/work/outside.txt" } }), vi.fn());
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonProjectEscapeOperand"));
    expect(screen.getByTestId("approval-ask-reason").textContent).not.toBe(t("toolApprovalDialog.reasonProjectEscape"));
    expect(screen.queryByTestId("approval-real-target")).toBeNull();
  });

  it("shows no real-target line when the spelling is the location", () => {
    renderApproval(fileRequest(), vi.fn());
    expect(screen.queryByTestId("approval-real-target")).toBeNull();
  });
});

describe("file ask reasons", () => {
  it("words a protected-path reason with the matched entry instead of showing the raw token", () => {
    renderApproval(fileRequest({ reason: ".git", reasonCode: "protected-path", reasonDetail: { protectedEntry: ".git" },
      args: { path: "/work/project/.git/config", content: "x" }, target: { filePath: "/work/project/.git/config" } }), vi.fn());
    const reason = screen.getByTestId("approval-ask-reason");
    expect(reason).toHaveTextContent(t("toolApprovalDialog.reasonProtectedPath", { entry: ".git" }));
    expect(reason).toHaveAttribute("data-reason-code", "protected-path");
    expect(screen.getByTestId("approval-impact-summary").querySelector("p")?.textContent).not.toBe(".git");
  });

  it.each([
    ["application-home", "toolApprovalDialog.protectedEntryApplicationHome"],
    ["runtime-settings-file", "toolApprovalDialog.protectedEntryRuntimeSettings"],
  ] as const)("names the %s namespace in words", (protectedEntry, labelKey) => {
    renderApproval(fileRequest({ reason: protectedEntry, reasonCode: "protected-path", reasonDetail: { protectedEntry } }), vi.fn());
    const text = screen.getByTestId("approval-ask-reason").textContent ?? "";
    expect(text).toBe(t("toolApprovalDialog.reasonProtectedPath", { entry: t(labelKey) }));
    expect(text).not.toContain(protectedEntry);
  });

  it("falls back to the generic protected sentence when no entry was matched by path evidence", () => {
    renderApproval(fileRequest({ reason: "Protected control path", reasonCode: "protected-path" }), vi.fn());
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonProtectedPathGeneric"));
  });

  it("keeps the secret-read reason and matched pattern beside a purpose text", () => {
    renderApproval(fileRequest({
      toolName: "read_file", toolCategory: "read", args: { path: "/work/project/.env" }, target: { filePath: "/work/project/.env" },
      reason: "Reading this secret file requires approval.", reasonCode: "secret-read", reasonDetail: { secretPattern: "**/.env" },
      approvalPurpose: { text: "Check the database URL for the migration", source: "tool-input", confidence: "sufficient" },
    } as Partial<ApprovalRequest>), vi.fn());
    const summary = screen.getByTestId("approval-impact-summary");
    expect(summary).toHaveTextContent("Check the database URL for the migration");
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonSecretRead"));
    expect(screen.getByTestId("approval-secret-pattern")).toHaveTextContent(`${t("toolApprovalDialog.secretPattern")} **/.env`);
    expect(summary.textContent).not.toContain("Reading this secret file requires approval.");
  });

  it("words an ordinary write ask without the host's English literal", () => {
    renderApproval(fileRequest({ reasonCode: "file-write" }), vi.fn());
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonFileWrite"));
    expect(screen.getByTestId("tool-approval-card").textContent).not.toContain("This write requires approval.");
  });

  it("names the matched secret pattern on a reviewed card that carries no reason code", () => {
    renderApproval(fileRequest({ toolName: "read_file", toolCategory: "read", reason: "Automatic review requires human approval.",
      reasonDetail: { secretPattern: "**/.env.*" } }), vi.fn());
    expect(screen.queryByTestId("approval-ask-reason")).toBeNull();
    expect(screen.getByTestId("approval-secret-pattern")).toHaveTextContent("**/.env.*");
  });
});

describe("file ask reason catalogs", () => {
  it("has a Korean sentence for every reason key", async () => {
    const { ko } = await import("../../../../i18n/messages/ko.js") as { ko: Record<string, string> };
    const { en } = await import("../../../../i18n/messages/en.js") as { en: Record<string, string> };
    for (const key of ["reasonProjectEscape", "reasonProjectEscapeOperand", "reasonProtectedPath", "reasonProtectedPathGeneric", "reasonSecretRead", "reasonFileWrite",
      "secretPattern", "realTarget", "protectedEntryApplicationHome", "protectedEntryRuntimeSettings"]) {
      expect(ko[`toolApprovalDialog.${key}`], key).toMatch(/[가-힣]/u);
      expect(ko[`toolApprovalDialog.${key}`]).not.toBe(en[`toolApprovalDialog.${key}`]);
    }
  });
});
