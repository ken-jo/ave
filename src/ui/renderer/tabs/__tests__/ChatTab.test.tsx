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
  it("exposes three localized choices with a checked radio", () => {
    renderChatTab({ processingDisplayLevel: "reasoning" });
    const group = screen.getByRole("radiogroup", { name: "처리 과정 표시 수준" });
    expect(group).toBeTruthy();
    expect(screen.getByRole("radio", { name: "간략히" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "중간" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "자세히" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("processing-display-hint").textContent).toContain("도구 호출과 모델이 제공한 생각");
  });

  it("saves a selected choice immediately", () => {
    const { setProcessingDisplayLevel, onImmediateChange } = renderChatTab();
    fireEvent.click(screen.getByRole("radio", { name: "간략히" }));
    expect(setProcessingDisplayLevel).toHaveBeenCalledWith("tools");
    expect(onImmediateChange).toHaveBeenCalledOnce();
  });

  it("disables every choice until settings finish loading", () => {
    renderChatTab({ settingsLoaded: false });
    for (const radio of screen.getAllByRole("radio").filter((node) => ["간략히", "중간", "자세히"].includes(node.getAttribute("aria-label") ?? ""))) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("ChatTab autonomous sub-agent wake", () => {
  it("describes autonomous wake without asserting a default and persists the choice", () => {
    const { setSubAgentAutonomousWake } = renderChatTab();
    const toggle = screen.getByTestId("subagent-autonomous-wake-toggle");

    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText(/유휴 부모가 백그라운드 서브에이전트 메시지를 받으면/).textContent).not.toContain("기본값");
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
    expect(screen.getByText(/현재 프로젝트 기억을 설정한 모델에 보내/)).toBeTruthy();
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

describe('chat settings accessible names', () => {
  it('names every experimental toggle and the round budget input', () => {
    renderChatTab();
    for (const id of ['idle-preference-refresh-toggle', 'idle-memory-consolidation-toggle', 'subagent-autonomous-wake-toggle']) expect(screen.getByTestId(id)).toHaveAccessibleName();
    expect(screen.getByRole('spinbutton', { name: '서브에이전트 라운드 예산' })).toHaveAccessibleName();
  });
});

describe('sub-agent round budget validation', () => {
  it.each(['', '-5', '0', '1.5', '1001'])('refuses invalid input %s visibly without saving', (value) => {
    const save = vi.fn(); renderChatTab({ subAgentMaxRounds: 60, setSubAgentMaxRounds: save });
    const input = screen.getByTestId('subagent-max-rounds-input');
    fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
    expect(save).not.toHaveBeenCalled(); expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('1~1000');
  });
  it('accepts the inclusive maximum and skips an unchanged value', () => {
    const save = vi.fn(); renderChatTab({ subAgentMaxRounds: 60, setSubAgentMaxRounds: save });
    const input = screen.getByTestId('subagent-max-rounds-input');
    fireEvent.blur(input); expect(save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1000' } }); fireEvent.blur(input);
    expect(save).toHaveBeenCalledExactlyOnceWith(1000); expect(input).toHaveValue(1000);
  });
});
