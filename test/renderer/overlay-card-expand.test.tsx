import "./setup.js";
import { useState } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { OverlayCard } from "../../src/ui/renderer/components/OverlayCard.js";

// Expansion is controlled by the queue so moving cards between tiles cannot reset it.
function ControlledCard(props: Omit<Parameters<typeof OverlayCard>[0], "expanded" | "onExpandedChange">) {
  const [expanded, setExpanded] = useState(false);
  return <OverlayCard {...props} expanded={expanded} onExpandedChange={setExpanded} />;
}

function renderCard(props: Parameters<typeof ControlledCard>[0]) {
  return render(
    <TooltipProvider>
      <ControlledCard {...props} />
    </TooltipProvider>,
  );
}

// Override geometry because the DOM test environment reports zero scroll and client heights.
function mockOverflow(scrollH: number, clientH: number): () => void {
  const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return scrollH; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return clientH; },
  });
  return () => {
    if (scrollDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDesc);
    if (clientDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDesc);
  };
}

const baseProps = {
  title: "회의 요약",
  firedAt: new Date().toISOString(),
  running: false,
  queueIndex: 1,
  queueTotal: 1,
  onPrev: () => {},
  onNext: () => {},
  onDismiss: () => {},
} as const;

describe("OverlayCard — expand toggle", () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    restore();
    restore = () => {};
  });

  it("no '더 보기' button when content fits (no overflow)", () => {
    restore = mockOverflow(20, 40); // scroll < client → not overflowing
    const { queryByTestId } = renderCard({ ...baseProps, summary: "짧은 요약", kind: "plugin" });
    expect(queryByTestId("overlay-card-expand-toggle")).toBeNull();
  });

  it("'더 보기' button appears when content overflows; click toggles expanded state", () => {
    restore = mockOverflow(120, 40); // scrollHeight > clientHeight → overflow
    const { getByTestId, getByText } = renderCard({
      ...baseProps,
      summary: "긴 요약 ".repeat(50),
      kind: "plugin",
    });
    const toggle = getByTestId("overlay-card-expand-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(getByText("더 보기")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("접기")).toBeTruthy();
    const summary = getByTestId("overlay-card-summary");
    expect(summary.getAttribute("data-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(getByText("더 보기")).toBeTruthy();
  });

  it("renders truncation marker text verbatim when host appended it", () => {
    restore = mockOverflow(200, 40);
    const truncated = "긴 본문 내용...\n…[잘림 — 확인하기 후 채팅에서 전체 보기]";
    const { getByTestId } = renderCard({ ...baseProps, summary: truncated, kind: "plugin" });
    const summary = getByTestId("overlay-card-summary");
    expect(summary.textContent).toContain("[잘림 — 확인하기 후 채팅에서 전체 보기]");
  });

  it("primary action label defaults to '확인하기' (regression: was '지금 답하기')", () => {
    const { getByTestId } = renderCard({
      ...baseProps,
      summary: "x",
      kind: "plugin",
      onPrimaryAction: () => {},
    });
    const action = getByTestId("overlay-card-primary-action");
    expect(action.textContent).toContain("확인하기");
    expect(action.textContent).not.toContain("지금 답하기");
  });
});
