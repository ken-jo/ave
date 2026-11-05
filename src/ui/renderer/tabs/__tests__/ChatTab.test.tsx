import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTab } from "../ChatTab.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

beforeEach(() => {
  window.aveApi = makeMockAveApi().api as never;
});

function renderChatTab(overrides: Partial<Parameters<typeof ChatTab>[0]> = {}) {
  const setSubAgentAutonomousWake = vi.fn();
  const setIdleMemoryConsolidation = vi.fn();
  const setProcessingDisplayLevel = vi.fn();
  const onImmediateChange = vi.fn();
  render(
    <ChatTab
      autoCompact
      setAutoCompact={vi.fn()}
      processingDisplayLevel="full"
      setProcessingDisplayLevel={setProcessingDisplayLevel}
      streamSmoothing="none"
      setStreamSmoothing={vi.fn()}
      idlePreferenceRefresh
      setIdlePreferenceRefresh={vi.fn()}
      idleMemoryConsolidation={false}
      setIdleMemoryConsolidation={setIdleMemoryConsolidation}
      subAgentAutonomousWake={false}
      setSubAgentAutonomousWake={setSubAgentAutonomousWake}
      piiRedactEnabled={false}
      onPiiRedactToggle={vi.fn()}
      settingsLoaded
      onImmediateChange={onImmediateChange}
      {...overrides}
    />,
  );
  return {
    setSubAgentAutonomousWake,
    setIdleMemoryConsolidation,
    setProcessingDisplayLevel,
    onImmediateChange,
  };
}

describe("ChatTab processing detail", () => {
  it("exposes the three localized levels as an accessible discrete slider", () => {
    renderChatTab({ processingDisplayLevel: "reasoning" });

    const slider = screen.getByRole("slider", { name: "처리 과정 표시 수준" });
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("2");
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("중간");
    expect(screen.getByRole("button", { name: "간략히" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "중간" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "자세히" })).toBeTruthy();
    expect(screen.getByTestId("processing-display-hint").textContent).toContain("도구 호출과 모델이 제공한 생각");
  });

  it("saves label clicks immediately and disables the control before settings load", () => {
    const { setProcessingDisplayLevel, onImmediateChange } = renderChatTab();
    fireEvent.click(screen.getByRole("button", { name: "간략히" }));
    expect(setProcessingDisplayLevel).toHaveBeenCalledWith("tools");
    expect(onImmediateChange).toHaveBeenCalledOnce();
  });

  it("disables the slider and labels until settings finish loading", () => {
    renderChatTab({ settingsLoaded: false });
    expect(screen.getByRole("slider", { name: "처리 과정 표시 수준" }).getAttribute("data-disabled")).toBe("");
    expect((screen.getByRole("button", { name: "간략히" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ChatTab autonomous sub-agent wake", () => {
  it("renders default-off guidance and persists only an explicit opt-in", () => {
    const { setSubAgentAutonomousWake } = renderChatTab();
    const toggle = screen.getByTestId("subagent-autonomous-wake-toggle");

    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("서브에이전트 메시지로 부모 자동 깨우기")).toBeTruthy();
    expect(screen.getByText(/유휴 부모가 백그라운드 서브에이전트 메시지를 받으면/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(setSubAgentAutonomousWake).toHaveBeenCalledWith(true);
  });
});

describe("ChatTab idle long-term-memory consolidation", () => {
  it("defaults off and makes the idle-only, manual-Roles behavior explicit", () => {
    const { setIdleMemoryConsolidation } = renderChatTab();
    const toggle = screen.getByTestId("idle-memory-consolidation-toggle");

    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("유휴 상태에서 장기 기억 통합")).toBeTruthy();
    expect(screen.getByText(/현재 프로젝트 원본 기억을 구성된 LLM에 전송/)).toBeTruthy();
    expect(screen.getByText(/Roles의 수동 통합은 계속 사용할 수 있습니다/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(setIdleMemoryConsolidation).toHaveBeenCalledWith(true);
  });
});

describe("ChatTab memory capture", () => {
  it("offers no capture mode: saving is always on", () => {
    renderChatTab();
    expect(screen.queryByTestId("memory-capture-mode")).toBeNull();
    expect(screen.queryByText("기억 자동 캡처")).toBeNull();
  });
});
