// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { t } from "../../../../i18n/runtime.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PermissionReviewStatusCard } from "../PermissionReviewStatusCard.js";

type ReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

function entry(overrides: Partial<ReviewEntry>): ReviewEntry {
  return { kind: "permission_review", toolUseId: "tool-1", toolName: "terminal_run", source: "builtin", status: "needs_approval", ...overrides } as ReviewEntry;
}

describe("PermissionReviewStatusCard", () => {
  it("says only that approval is required when no reviewer produced a verdict", () => {
    render(<TooltipProvider><PermissionReviewStatusCard entry={entry({})} variant="attached" /></TooltipProvider>);
    const chip = screen.getByTestId("permission-review-status-card");
    expect(chip).toHaveTextContent(t("permissionReviewStatusCard.approvalRequiredPlain"));
    // No review happened, so nothing is called complete and no risk level is claimed.
    expect(chip.textContent).toBe(t("permissionReviewStatusCard.approvalRequiredPlain"));
    expect(chip.textContent).not.toContain("·");
  });

  it("keeps the reviewer's level when one ran", () => {
    render(<TooltipProvider><PermissionReviewStatusCard entry={entry({ verdictLevel: "medium" })} variant="attached" /></TooltipProvider>);
    expect(screen.getByTestId("permission-review-status-card")).toHaveTextContent(
      t("permissionReviewStatusCard.approvalRequired", { level: t("permissionReviewStatusCard.riskMedium") }));
  });
});
