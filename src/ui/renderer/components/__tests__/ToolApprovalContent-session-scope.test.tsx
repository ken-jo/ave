// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";

const REQUEST: ApprovalRequest = {
  id: "site", category: "tool", toolName: "browser_navigate", source: "builtin", toolCategory: "network",
  sessionId: "conversation", args: { url: "https://a.example/path" }, reason: "Open a site", createdAt: 1,
  browserSite: "https://a.example:443", requireExplicit: true, exactRecordAllowed: false, persistentAllowAllowed: false,
  allowedChoices: ["allow-once", "deny-once"],
};

describe("ToolApprovalContent site scope", () => {
  it.each([["siteAllow", "this-site"], ["siteAllowAny", "any-site"]] as const)("sends %s as a site choice without recording a tool grant", (label, choice) => {
    const decide = vi.fn();
    renderApproval(REQUEST, decide);
    expect(screen.getByRole("heading")).toHaveTextContent("https://a.example:443");
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t(`toolApprovalDialog.${label}`) }));
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { browserSiteChoice: choice });
    expect(screen.queryByTestId("approval-decision-bar")).toBeNull();
  });
  it("denies dismissal by default", () => {
    const decide = vi.fn();
    renderApproval(REQUEST, decide);
    fireEvent.keyDown(screen.getByTestId("browser-site-approval-card"), { key: "Escape" });
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once", undefined, undefined);
  });
});
