import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionJudgeContent } from "../../src/ui/renderer/components/permissions/PermissionJudgeContent.js";
import { setLocale } from "../../src/i18n/runtime.js";
import type { PermissionJudgeSettings, PermissionJudgeSnapshot, PermissionJudgeWriteResult } from "../../src/shared/permission-judge-settings.js";

function settings(): PermissionJudgeSettings {
  return {
    model: null,
    chain: [],
    mode: "shadow",
    categories: { shell: true, write: true, network: false },
    timeoutMs: 15_000,
    chainDeadlineMs: 60_000,
    breaker: { consecutive: 3, total: 20 },
  };
}

function mount(overrides: Partial<PermissionJudgeSnapshot> = {}) {
  setLocale("en");
  const snapshot: PermissionJudgeSnapshot = {
    settings: settings(),
    issues: [],
    modelOptions: [{ vendor: "openai-compatible", model: "team/reviewer" }],
    chatModel: "openai/chat-model",
    reviewerModelUnavailable: false,
    storedChainRejected: false,
    ...overrides,
  };
  const judgeGet = vi.fn(async () => ({ ok: true as const, ...snapshot }));
  // The host merges the patch into the stored settings and answers with the whole result.
  const judgeSet = vi.fn(async (patch: Partial<PermissionJudgeSettings>): Promise<PermissionJudgeWriteResult> => ({ ok: true, ...snapshot, settings: { ...snapshot.settings, ...patch } }));
  let listener: (() => void) | undefined;
  const onConfigChanged = vi.fn((callback: () => void) => { listener = callback; return () => { listener = undefined; }; });
  const previous = window.ave;
  window.ave = { permission: { judgeGet, judgeSet, onConfigChanged } } as unknown as typeof window.ave;
  const rendered = render(<PermissionJudgeContent />);
  return { ...rendered, judgeGet, judgeSet, notify: () => listener?.(), restore: () => { window.ave = previous; } };
}

/** Pick a row of the shared model chooser by its visible text. */
async function pickModel(trigger: HTMLElement, label: RegExp) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role='option']")]
      .find((row) => label.test(row.textContent ?? ""));
    if (!found) throw new Error("chooser not open yet");
    return found;
  });
  option.focus();
  fireEvent.keyDown(option, { key: "Enter" });
}

afterEach(() => {
  vi.restoreAllMocks();
  setLocale("en");
});

describe("approval judge settings", () => {
  it("defaults an added stage to shadow and saves a configured provider model exactly", async () => {
    const view = mount();
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("off");
      fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("shadow");
      // Unset stage model: the stage runs on the permission reviewer model.
      expect(screen.getByLabelText("Judge model")).toHaveTextContent("Permission reviewer model");
      expect(view.judgeSet).not.toHaveBeenCalled();
      await pickModel(screen.getByLabelText("Judge model"), /team\/reviewer/);
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByText("Judge settings saved.");
      // Only changed fields are sent: the stored mode is already shadow and the unchanged reviewer model is left as stored.
      expect(view.judgeSet).toHaveBeenCalledWith({
        chain: [{ id: "stage-1", provider: "builtin-llm", model: { vendor: "openai-compatible", model: "team/reviewer" } }],
      });
    } finally { view.restore(); }
  });

  it("keeps an unavailable stored reviewer model visible and out of an unrelated save", async () => {
    const value = settings();
    value.model = { vendor: "claude", model: "removed-model" };
    value.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: value, reviewerModelUnavailable: true });
    try {
      await screen.findByTestId("permission-reviewer-model-unavailable");
      expect(screen.getByLabelText("Permission reviewer model")).toHaveTextContent("removed-model");
      fireEvent.click(screen.getByLabelText("Network"));
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByText("Judge settings saved.");
      expect(view.judgeSet).toHaveBeenCalledWith({ categories: { shell: true, write: true, network: true } });
    } finally { view.restore(); }
  });

  it("warns about a rejected stored chain and never sends it as off when saving other fields", async () => {
    const value = settings();
    value.mode = "active";
    const view = mount({ settings: value, storedChainRejected: true });
    try {
      await screen.findByTestId("permission-judge-chain-rejected");
      await pickModel(screen.getByLabelText("Permission reviewer model"), /team\/reviewer/);
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByText("Judge settings saved.");
      expect(view.judgeSet).toHaveBeenCalledWith({ model: { vendor: "openai-compatible", model: "team/reviewer" } });
    } finally { view.restore(); }
  });

  it("keeps argument boundaries and optional environment names in a reordered chain", async () => {
    const value = settings();
    value.chain = [{ id: "local", provider: "external", external: { command: ["/opt/judge", "first"] } }, { id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: value });
    try {
      await screen.findByLabelText("Arguments · one per line, blank lines ignored");
      fireEvent.change(screen.getByLabelText("Arguments · one per line, blank lines ignored"), { target: { value: "--policy\npath with spaces\n" } });
      expect(screen.getByLabelText("Arguments · one per line, blank lines ignored")).toHaveValue("--policy\npath with spaces\n");
      fireEvent.change(screen.getByLabelText("Environment variable names · comma separated"), { target: { value: "POLICY_DIR, JUDGE_HOME" } });
      fireEvent.change(screen.getByLabelText("Escalate below confidence · 0 to 1, optional"), { target: { value: "0.8" } });
      fireEvent.click(screen.getByRole("button", { name: "Move stage 2 up" }));
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByText("Judge settings saved.");
      const saved = view.judgeSet.mock.calls[0]![0];
      expect(saved.chain).toEqual([
        { id: "review", provider: "builtin-llm" },
        { id: "local", provider: "external", external: { command: ["/opt/judge", "--policy", "path with spaces"], env: ["POLICY_DIR", "JUDGE_HOME"] }, escalateBelow: 0.8 },
      ]);
    } finally { view.restore(); }
  });

  it("limits the chain to four stages and turns off by saving an empty chain", async () => {
    const stored = settings();
    stored.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored });
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      for (let count = 0; count < 3; count++) fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      expect(screen.getByRole("button", { name: "Add custom evaluator" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Remove stage 2" }));
      expect(screen.getByRole("button", { name: "Add custom evaluator" })).toBeEnabled();
      fireEvent.change(screen.getByLabelText("Custom evaluation behavior"), { target: { value: "off" } });
      expect(screen.queryByLabelText("Judge model")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByText("Judge settings saved.");
      expect(view.judgeSet).toHaveBeenCalledWith({ chain: [] });
    } finally { view.restore(); }
  });

  it("shows localized warnings and validation failures without host diagnostics", async () => {
    const view = mount({ issues: ["private path /sensitive/config"] });
    try {
      await screen.findByText("1 saved settings could not be applied. Review the values below before saving.");
      expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument();
      view.judgeSet.mockResolvedValueOnce({ ok: false, error: "invalid-judge-settings" });
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent("Stage identifiers must be unique.");
      expect(screen.queryByText("Judge settings saved.")).not.toBeInTheDocument();
    } finally { view.restore(); }
  });

  it("refreshes clean windows and preserves unsaved edits until reload", async () => {
    const view = mount();
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      const current = settings();
      current.chain = [{ id: "saved-review", provider: "builtin-llm" }];
      view.judgeGet.mockResolvedValueOnce({ ok: true, settings: current, issues: [], modelOptions: [], chatModel: null, reviewerModelUnavailable: false, storedChainRejected: false });
      await act(async () => { view.notify(); });
      await waitFor(() => expect(screen.getByLabelText("Stage identifier")).toHaveValue("saved-review"));
      fireEvent.change(screen.getByLabelText("Stage identifier"), { target: { value: "unsaved-review" } });
      const reads = view.judgeGet.mock.calls.length;
      await act(async () => { view.notify(); });
      expect(view.judgeGet).toHaveBeenCalledTimes(reads);
      expect(screen.getByLabelText("Stage identifier")).toHaveValue("unsaved-review");
      await screen.findByText("Judge settings changed in another window. Reload to replace your unsaved edits with the saved settings.");
      view.judgeGet.mockResolvedValueOnce({ ok: true, settings: current, issues: [], modelOptions: [], chatModel: null, reviewerModelUnavailable: false, storedChainRejected: false });
      fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
      await waitFor(() => expect(screen.getByLabelText("Stage identifier")).toHaveValue("saved-review"));
    } finally { view.restore(); }
  });

  it.each([
    ["judge-rewire-failed", "Judge settings could not be activated. The previous settings were restored."],
    ["judge-rollback-failed", "Judge settings and runtime could not be restored. Restart the app before relying on automation."],
  ] as const)("shows the recovery state for %s", async (error, message) => {
    const view = mount();
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      view.judgeSet.mockResolvedValueOnce({ ok: false, error });
      fireEvent.click(screen.getByRole("button", { name: "Save judge settings" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    } finally { view.restore(); }
  });

  it("reports an unavailable bridge without breaking the permissions page", async () => {
    const previous = window.ave;
    window.ave = undefined as unknown as typeof window.ave;
    try {
      setLocale("ko");
      render(<PermissionJudgeContent />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("판정기 설정을 불러오지 못했습니다."));
    } finally { window.ave = previous; }
  });
});
