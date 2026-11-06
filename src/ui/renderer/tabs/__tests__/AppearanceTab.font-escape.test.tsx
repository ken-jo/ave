import { SavedToastProvider } from "../../context/SavedToastContext.js";
/** Escape must skip the synchronous blur commit via escapingRef; a batched state reset alone leaves the blur closure
 * holding the typed draft. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
vi.mock("../../api-client.js", () => ({ getApi: () => api }));
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

  it("updates the terminal preview and persists its size", async () => {
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontFamily: "monospace" }));
    fireEvent.change(screen.getByLabelText("크기 (px)"), { target: { value: "18" } });
    expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontSize: "18px" });
    fireEvent.blur(screen.getByLabelText("크기 (px)"));
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { terminalFont: { family: "monospace", size: 18, lineHeight: 1.2 } } });
  });
});


it("keeps intermediate keyboard drafts and commits valid terminal metrics", async () => {
  const user = userEvent.setup();
  render(<AppearanceTab />);
  await waitFor(() => expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontFamily: "monospace" }));
  api.updateSettings.mockClear();
  const size = screen.getByLabelText("크기 (px)");
  await user.clear(size);
  await user.type(size, "1");
  expect(size).toHaveValue("1");
  expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontSize: "12px" });
  await user.type(size, "8");
  expect(size).toHaveValue("18");
  expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ fontSize: "18px" });
  expect(api.updateSettings).not.toHaveBeenCalled();
  await user.tab();
  expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { terminalFont: { family: "monospace", size: 18, lineHeight: 1.2 } } });
  const lineHeight = screen.getByLabelText("줄 높이");
  api.updateSettings.mockClear();
  await user.clear(lineHeight);
  await user.type(lineHeight, "1.");
  expect(lineHeight).toHaveValue("1.");
  await user.type(lineHeight, "5");
  expect(lineHeight).toHaveValue("1.5");
  expect(screen.getByTestId("terminal-font-preview")).toHaveStyle({ lineHeight: "1.5" });
  expect(api.updateSettings).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { terminalFont: { family: "monospace", size: 18, lineHeight: 1.5 } } });
});


it("reports a rejected terminal family without announcing Saved", async () => {
  const notifySaved = vi.fn();
  api.updateSettings.mockClear();
  api.updateSettings.mockRejectedValueOnce(new Error("invalid-terminal-font-family"));
  render(<SavedToastProvider value={notifySaved}><AppearanceTab /></SavedToastProvider>);
  const section = document.querySelector('[data-settings-section="appearance-terminal"]')!;
  const family = section.querySelector("input")!;
  fireEvent.change(family, { target: { value: "Broken; color: red" } });
  fireEvent.blur(family);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("글꼴 설정을 불러오거나 저장하지 못했습니다."));
  expect(notifySaved).not.toHaveBeenCalled();
  expect(family).toHaveValue("monospace");
});
