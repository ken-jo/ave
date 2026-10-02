// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { PluginUpdatesPill } from "../PluginUpdatesPill.js";
import type { PluginUpdatesPillProps } from "../PluginUpdatesPill.js";
import { UPDATE_PACKAGE_STATES, type PackageKind, type PackageUpdateView } from "../../../../shared/git-marketplace.js";

describe("PluginUpdatesPill", () => {
  afterEach(() => cleanup());

  it("renders nothing when no update is pending", () => {
    renderPill({ updates: [] });
    expect(screen.queryByTestId("marketplace-update-action")).toBeNull();
  });

  it("shows the count in the band and the full list in the hover text", () => {
    renderPill({
      updates: [
        update("plugin", "meeting", "Ave Meeting", "2.0.0"),
        update("skill", "calendar", "Calendar", "1.4.0"),
        update("theme", "dusk", "Dusk", "3.1.0"),
      ],
    });

    const pill = screen.getByTestId("marketplace-update-action");
    expect(pill.textContent).toContain("업데이트 3개");
    const title = pill.getAttribute("title") ?? "";
    expect(title).toContain("3개 업데이트 가능");
    expect(title).toContain("Ave Meeting → 2.0.0");
    expect(title).toContain("Calendar → 1.4.0");
    expect(title).toContain("Dusk → 3.1.0");
    fireEvent.focus(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("Ave Meeting → 2.0.0");
  });

  it("counts only the updates that need the user (design §18.7.5)", () => {
    const onReview = vi.fn();
    const every = UPDATE_PACKAGE_STATES.map((state) => ({ ...update("plugin", `p-${state}`, `P ${state}`, "2.0.0"), state }));
    renderPill({ updates: every, onReview });

    const pill = screen.getByTestId("marketplace-update-action");
    expect(pill.textContent).toContain("업데이트 5개");
    pill.click();
    expect(onReview.mock.calls[0]![0].map((item: PackageUpdateView) => item.state)).toEqual([
      "needs-review",
      "manual",
      "failed",
      "applied-not-running",
      "approval-pending",
    ]);
  });

  it("counts an update that has waited 30 minutes for the conversation to pause, for Apply now (design §18.7.4)", () => {
    const onReview = vi.fn();
    renderPill({
      updates: [
        { ...update("plugin", "meeting", "Meeting", "2.0.0"), state: "waiting", escalated: true },
        { ...update("plugin", "notes", "Notes", "2.0.0"), state: "waiting" },
      ],
      onReview,
    });
    const pill = screen.getByTestId("marketplace-update-action");
    expect(pill.textContent).toContain("업데이트 1개");
    pill.click();
    expect(onReview.mock.calls[0]![0].map((item: PackageUpdateView) => item.key.name)).toEqual(["meeting"]);
  });

  it("renders nothing when every update is applying, waiting or applied", () => {
    renderPill({
      updates: (["automatic", "waiting", "applied"] as const).map((state) => ({ ...update("plugin", state, state, "2.0.0"), state })),
    });
    expect(screen.queryByTestId("marketplace-update-action")).toBeNull();
  });

  it("opens the review with the updates instead of installing them", () => {
    const onReview = vi.fn();
    const updates = [update("plugin", "meeting", "Ave Meeting", "0.5.24")];
    renderPill({ updates, onReview });

    screen.getByTestId("marketplace-update-action").click();

    expect(onReview).toHaveBeenCalledWith(updates);
    expect(screen.getByTestId("marketplace-update-action").getAttribute("aria-label")).toBe("사용 가능한 업데이트 검토");
  });

  it("uses the close control as a skip-until-next-version action", () => {
    const onSkip = vi.fn();
    const onReview = vi.fn();
    renderPill({ updates: [update("plugin", "meeting", "Ave Meeting", "0.5.24")], onSkip, onReview });

    screen.getByLabelText("이 업데이트를 다음 버전까지 건너뛰기").click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(onReview).not.toHaveBeenCalled();
  });
});

function renderPill(overrides: Partial<PluginUpdatesPillProps> & { updates: PackageUpdateView[] }) {
  const props: PluginUpdatesPillProps = {
    onSkip: vi.fn(),
    onReview: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <PluginUpdatesPill {...props} />
    </TooltipProvider>,
  );
}

function update(kind: PackageKind, name: string, displayName: string, to: string): PackageUpdateView {
  return { key: { sourceId: "ave", kind, name }, displayName, from: "1.0.0", to, state: "manual" };
}
