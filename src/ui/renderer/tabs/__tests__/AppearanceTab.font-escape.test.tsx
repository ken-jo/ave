import { SavedToastProvider } from "../../context/SavedToastContext.js";
/** Escape must skip the synchronous blur commit via escapingRef; a batched state reset alone leaves the blur closure
 * holding the typed draft. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";
import { DEFAULT_APPEARANCE } from "../../../../shared/appearance-settings.js";
import { AppearanceTab } from "../AppearanceTab.js";

const { api, theme } = vi.hoisted(() => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({
      appearance: { schemaVersion: 3, mode: "system", darkScheme: "github-dark", lightScheme: "github-light", font: { family: "system", sizeScale: 1 }, terminalFont: { family: "monospace", size: 12, lineHeight: 1.2 } },
    }),
    updateSettings: vi.fn().mockResolvedValue({}),
    onSettingsUpdated: vi.fn(() => () => {}),
  },
  theme: { appearance: { terminalFont: { family: "monospace", size: 12, lineHeight: 1.2 } }, mode: "system", darkScheme: "github-dark", lightScheme: "github-light", setMode: vi.fn(), setScheme: vi.fn() },
}));
vi.mock("../../api-client.js", () => ({ getApi: () => api, isDarwin: () => false }));
vi.mock("../../theme/index.js", async () => ({
  ...await vi.importActual<typeof import("../../theme/index.js")>("../../theme/index.js"),
  useTheme: () => theme,
}));

describe("Custom font input Escape semantics", () => {
  it("Escape after typing does NOT commit the typed text", async () => {
    const { container, findByLabelText } = render(<AppearanceTab />);

    const input = (await findByLabelText("사용자 정의 폰트 stack")) as HTMLInputElement;

    const { getApi } = await import("../../api-client.js");
    const api = getApi() as ReturnType<typeof getApi> & {
      updateSettings: ReturnType<typeof vi.fn>;
    };
    api.updateSettings.mockClear();

    fireEvent.change(input, { target: { value: "AttackerFont, sans-serif" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    const updateCalls = api.updateSettings.mock.calls.filter(([patch]) => {
      const family = (patch as { appearance?: { font?: { family?: string } } })?.appearance?.font?.family;
      return typeof family === "string" && family.includes("AttackerFont");
    });
    expect(updateCalls, "Escape must NOT commit the typed text via cascading onBlur").toHaveLength(0);
    expect(container).toBeTruthy();
  });
});


describe("appearance choices", () => {
  it("offers both scheme slots in system mode and applies selections", () => {
    const { container } = render(<AppearanceTab />);
    expect(container.querySelectorAll("[data-scheme-id]")).toHaveLength(12);
    fireEvent.click(screen.getByTestId("appearance-mode-light"));
    expect(theme.setMode).toHaveBeenCalledWith("light");
    fireEvent.click(container.querySelector('[data-scheme-id="github-dark"]')!);
    expect(theme.setScheme).toHaveBeenCalledWith("dark", "github-dark");
  });

});

it("renders code presets in their saved typeface", () => {
 render(<AppearanceTab />);
 const buttons = within(screen.getByTestId("code-font-presets")).getAllByRole("radio");
 expect(buttons).toHaveLength(6);
 expect(buttons[0]?.style.fontFamily).toBe(DEFAULT_APPEARANCE.terminalFont.family);
 for (const button of buttons) {
   fireEvent.click(button);
   expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { terminalFont: { family: button.style.fontFamily, size: 12, lineHeight: 1.2 } } });
 }
});

it("rejects unsafe custom code stacks before saving", () => {
 render(<AppearanceTab />);
 api.updateSettings.mockClear();
 const input = screen.getByLabelText("사용자 정의 코드 폰트 stack");
 fireEvent.change(input, { target: { value: "Broken; color: red" } });
 fireEvent.blur(input);
 expect(api.updateSettings).not.toHaveBeenCalled();
 expect(input).toHaveAttribute("aria-invalid", "true");
 fireEvent.change(input, { target: { value: "Example Mono, monospace" } });
 fireEvent.keyDown(input, { key: "Enter" });
 expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { terminalFont: { family: "Example Mono, monospace", size: 12, lineHeight: 1.2 } } });
});

it("steps code metrics, disables at bounds and rolls back failed saves", async () => {
 const notifySaved = vi.fn();
 render(<SavedToastProvider value={notifySaved}><AppearanceTab /></SavedToastProvider>);
 const size = within(screen.getByRole("group", { name: "크기 (px)" }));
 const height = within(screen.getByRole("group", { name: "줄 높이" }));
 fireEvent.click(size.getByRole("button", { name: /−/ }));
 expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontSize: "11px" });
 for (let i = 0; i < 8; i++) fireEvent.click(size.getByRole("button", { name: /−/ }));
 expect(size.getByRole("button", { name: /−/ })).toBeDisabled();
 for (let i = 0; i < 30; i++) fireEvent.click(size.getByRole("button", { name: /\+/ }));
 expect(size.getByRole("button", { name: /\+/ })).toBeDisabled();
 for (let i = 0; i < 12; i++) fireEvent.click(height.getByRole("button", { name: /\+/ }));
 expect(height.getByRole("button", { name: /\+/ })).toBeDisabled();
 expect(height.getByText("2.0")).toBeInTheDocument();
 for (let i = 0; i < 12; i++) fireEvent.click(height.getByRole("button", { name: /−/ }));
 expect(height.getByRole("button", { name: /−/ })).toBeDisabled();
 await waitFor(() => expect(notifySaved).toHaveBeenCalled());
 notifySaved.mockClear();
 api.updateSettings.mockRejectedValueOnce(new Error("save-failed"));
 fireEvent.click(size.getByRole("button", { name: /−/ }));
 await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("글꼴 설정을 불러오거나 저장하지 못했습니다."));
 expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontFamily: "monospace", fontSize: "12px", lineHeight: "1.2" });
 expect(notifySaved).not.toHaveBeenCalled();
});

it("keeps one live chat preview above both font sections before saving completes", async () => {
 api.updateSettings.mockImplementationOnce(() => new Promise(() => {}));
 const view = render(<AppearanceTab />);
 const preview = screen.getByTestId("font-chat-preview");
 expect(preview).toHaveTextContent("이 코드를 설명해 주세요.");
 expect(preview).toHaveTextContent("결과를 출력하는 예제입니다.");
 expect(screen.getByTestId("terminal-font-preview").textContent?.split("\n")).toHaveLength(2);
 const firstFontSection = view.container.querySelector('[data-settings-section="appearance-font"]') as HTMLElement;
 expect(preview.compareDocumentPosition(firstFontSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(within(screen.getByTestId("font-family-presets")).getAllByRole("radio")[1] as HTMLButtonElement);
 expect(preview.style.fontFamily).toContain("Pretendard");
 const previousSize = preview.style.fontSize;
 fireEvent.click(within(screen.getByTestId("font-size-scale")).getAllByRole("radio")[0] as HTMLButtonElement);
 expect(preview.style.fontSize).not.toBe(previousSize);
 fireEvent.click(within(screen.getByTestId("code-font-presets")).getAllByRole("radio")[1] as HTMLButtonElement);
 expect(screen.getByTestId("terminal-font-preview").style.fontFamily).toContain("JetBrains Mono");
});
