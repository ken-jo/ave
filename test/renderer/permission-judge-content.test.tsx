import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsEditorProvider, _unregisteredSettingsControlsForTest } from "../../src/ui/renderer/context/SettingsEditorContext.js";
import { makeMockAveApi } from "./mock-ave-api.js";
import { SavedToastProvider } from "../../src/ui/renderer/context/SavedToastContext.js";
import { PermissionJudgeContent } from "../../src/ui/renderer/components/permissions/PermissionJudgeContent.js";
import { requiredFixture } from "../../src/__tests__/support/required-fixture.js";
import { setLocale, t } from "../../src/i18n/runtime.js";
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

function mount(overrides: Partial<PermissionJudgeSnapshot> = {}, editor = false, modifiedOnly = true) {
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
  let current = snapshot;
  const judgeGet = vi.fn(async () => ({ ok: true as const, ...current }));
  // The host merges the patch into the stored settings and answers with the whole result.
  const judgeSet = vi.fn(async (patch: Partial<PermissionJudgeSettings>): Promise<PermissionJudgeWriteResult> => {
    current = { ...current, settings: { ...current.settings, ...patch }, ...(Object.hasOwn(patch, "chain") ? { storedChainRejected: false } : {}), ...(Object.hasOwn(patch, "model") ? { reviewerModelUnavailable: false } : {}) };
    return { ok: true, ...current };
  });
  let listener: (() => void) | undefined;
  const onConfigChanged = vi.fn((callback: () => void) => { listener = callback; return () => { listener = undefined; }; });
  const previous = window.ave;
  window.ave = { permission: { judgeGet, judgeSet, onConfigChanged } } as unknown as typeof window.ave;
  const notifySaved = vi.fn();
  const { api } = makeMockAveApi();
  const content = <SavedToastProvider value={notifySaved}><PermissionJudgeContent /></SavedToastProvider>;
  const rendered = render(editor ? <SettingsEditorProvider api={api as never} modifiedOnly={modifiedOnly}>{content}</SettingsEditorProvider> : content);
  return { ...rendered, api, judgeGet, judgeSet, notifySaved, notify: () => listener?.(), restore: () => { window.ave = previous; } };
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
  it("preserves the selected route for reviewer and evaluator model saves", async () => {
    const selected = {
      vendor: "openai-compatible" as const, model: "team/reviewer",
      route: {
        vendor: "openai-compatible" as const, baseUrl: "https://review.example.test/v1",
        credentialScope: "llm.apiKey.openai-compatible", wire: "openai-chat" as const,
      },
    };
    const view = mount({ modelOptions: [selected] });
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      await pickModel(screen.getByLabelText("Permission reviewer model"), /review.example.test/);
      await waitFor(() => expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ model: selected }));
      fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      await pickModel(screen.getByLabelText("Judge model"), /review.example.test/);
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
      await screen.findByText("Evaluator chain saved.");
      expect(view.judgeSet).toHaveBeenLastCalledWith({
        chain: [{ id: "stage-1", provider: "builtin-llm", model: selected }],
      });
      expect(document.body.textContent).not.toContain(selected.route.credentialScope);
    } finally { view.restore(); }
  });

  it("defaults an added stage to shadow and saves a configured provider model exactly", async () => {
    const view = mount();
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("off");
      fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("off");
      // Unset stage model: the stage runs on the permission reviewer model.
      expect(screen.getByLabelText("Judge model")).toHaveTextContent("Permission reviewer model");
      expect(view.judgeSet).not.toHaveBeenCalled();
      await pickModel(screen.getByLabelText("Judge model"), /team\/reviewer/);
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
      await screen.findByText("Evaluator chain saved.");
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
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(1));
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
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(1));
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
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
      await screen.findByText("Evaluator chain saved.");
      const saved = view.judgeSet.mock.calls[0]![0];
      expect(saved.chain).toEqual([
        { id: "review", provider: "builtin-llm" },
        { id: "local", provider: "external", external: { command: ["/opt/judge", "--policy", "path with spaces"], env: ["POLICY_DIR", "JUDGE_HOME"] }, escalateBelow: 0.8 },
      ]);
    } finally { view.restore(); }
  });

  it("limits the chain to four stages and turns off without saving an edited chain", async () => {
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
      await waitFor(() => expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ chain: [] }));
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("off");
      expect(screen.getAllByLabelText("Judge model")).toHaveLength(3);
      expect(screen.getByRole("button", { name: "Save evaluator chain" })).toBeEnabled();
    } finally { view.restore(); }
  });

  it("shows localized warnings and validation failures without host diagnostics", async () => {
    const view = mount({ issues: ["private path /sensitive/config"] });
    try {
      await screen.findByText("1 saved settings could not be applied. Review the values below before saving.");
      expect(screen.queryByText(/sensitive/)).not.toBeInTheDocument();
      view.judgeSet.mockResolvedValueOnce({ ok: false, error: "invalid-judge-settings" });
      fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent("Stage identifiers must be unique.");
      expect(screen.queryByText("Evaluator chain saved.")).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: "Add custom evaluator" }));
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
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

describe("immediate judge controls", () => {
  it("saves mode and category changes directly without the chain Save action", async () => {
    const stored = settings();
    stored.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored });
    try {
      await screen.findByLabelText("Custom evaluation behavior");
      expect(screen.getByRole("button", { name: "Save evaluator chain" })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Custom evaluation behavior"), { target: { value: "active" } });
      expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ mode: "active" });
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByLabelText("Network"));
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(2));
      expect(view.judgeSet.mock.calls.map(([patch]) => patch)).toEqual([
        { mode: "active" }, { categories: { shell: true, write: true, network: true } },
      ]);
      expect(screen.getByRole("button", { name: "Save evaluator chain" })).toBeDisabled();
    } finally { view.restore(); }
  });

  it("rolls a rejected model choice back and never reports Saved", async () => {
    const view = mount();
    try {
      await screen.findByLabelText("Permission reviewer model");
      view.judgeSet.mockResolvedValueOnce({ ok: false, error: "judge-save-failed" });
      await pickModel(screen.getByLabelText("Permission reviewer model"), /team\/reviewer/);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Judge settings could not be saved."));
      expect(screen.getByLabelText("Permission reviewer model")).toHaveTextContent("Follow chat model");
      expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ model: { vendor: "openai-compatible", model: "team/reviewer" } });
      expect(view.notifySaved).not.toHaveBeenCalled();
      expect(screen.queryByText("Evaluator chain saved.")).not.toBeInTheDocument();
    } finally { view.restore(); }
  });

  it("preserves a dirty chain while model and categories apply their own fields", async () => {
    const stored = settings();
    stored.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored });
    try {
      await screen.findByLabelText("Stage identifier");
      fireEvent.change(screen.getByLabelText("Stage identifier"), { target: { value: "unsaved-stage" } });
      await pickModel(screen.getByLabelText("Permission reviewer model"), /team\/reviewer/);
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(1));
      expect(screen.getByLabelText("Stage identifier")).toHaveValue("unsaved-stage");
      fireEvent.click(screen.getByLabelText("Network"));
      await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(2));
      expect(screen.getByLabelText("Stage identifier")).toHaveValue("unsaved-stage");
      expect(view.judgeSet.mock.calls.every(([patch]) => !("chain" in patch))).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Save evaluator chain" }));
      await screen.findByText("Evaluator chain saved.");
      expect(view.judgeSet).toHaveBeenLastCalledWith({ chain: [{ id: "unsaved-stage", provider: "builtin-llm" }] });
    } finally { view.restore(); }
  });

  it("keeps edits typed while a control is saving and prevents a concurrent mutation", async () => {
    const stored = settings();
    stored.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored });
    try {
      await screen.findByLabelText("Stage identifier");
      let resolve!: (result: PermissionJudgeWriteResult) => void;
      view.judgeSet.mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
      fireEvent.change(screen.getByLabelText("Custom evaluation behavior"), { target: { value: "active" } });
      expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ mode: "active" });
      expect(screen.getByLabelText("Network")).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Stage identifier"), { target: { value: "edited-during-save" } });
      await act(async () => { view.notify(); });
      await act(async () => resolve({ ok: true, settings: { ...stored, mode: "active" }, issues: [], modelOptions: [], chatModel: null, reviewerModelUnavailable: false, storedChainRejected: false }));
      expect(screen.getByLabelText("Stage identifier")).toHaveValue("edited-during-save");
      expect(screen.getByLabelText("Custom evaluation behavior")).toHaveValue("active");
      expect(view.judgeSet).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Save evaluator chain" })).toBeEnabled();
    } finally { view.restore(); }
  });
});

it("ignores a refresh response that predates an immediate control save", async () => {
  const view = mount();
  try {
    await screen.findByLabelText("Permission reviewer model");
    let resolveRead!: (result: Awaited<ReturnType<typeof view.judgeGet>>) => void;
    view.judgeGet.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    await act(async () => { view.notify(); });
    await waitFor(() => expect(view.judgeGet).toHaveBeenCalledTimes(2));
    await pickModel(screen.getByLabelText("Permission reviewer model"), /team\/reviewer/);
    await waitFor(() => expect(view.notifySaved).toHaveBeenCalledTimes(1));
    await act(async () => resolveRead({ ok: true, settings: settings(), issues: [], modelOptions: [], chatModel: null, reviewerModelUnavailable: false, storedChainRejected: false }));
    expect(screen.getByLabelText("Permission reviewer model")).toHaveTextContent("team/reviewer");
    expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ model: { vendor: "openai-compatible", model: "team/reviewer" } });
  } finally { view.restore(); }
});


describe("judge settings canonical reset adapters", () => {
  it("resets only the reviewer model and preserves a dirty evaluator chain", async () => {
    const stored = settings();
    stored.model = { vendor: "openai-compatible", model: "team/reviewer" };
    stored.chain = [{ id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored }, true);
    try {
      await screen.findByLabelText("Stage identifier");
      fireEvent.change(screen.getByLabelText("Stage identifier"), { target: { value: "draft-stage" } });
      const row = await waitFor(() => {
        const found = view.container.querySelector<HTMLElement>('[data-setting-registered="true"][data-setting-id="permissions.judge.model"]');
        expect(found).toBeTruthy(); return requiredFixture(found);
      });
      fireEvent.click(requiredFixture(row.querySelector('button')));
      await waitFor(() => expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ model: null }));
      expect(screen.getByLabelText("Stage identifier")).toHaveValue("draft-stage");
      expect(view.api.updateSettings).not.toHaveBeenCalled();
    } finally { view.restore(); }
  });

  it("explicitly clears a rejected stored chain instead of treating its normalized empty view as unchanged", async () => {
    const view = mount({ storedChainRejected: true }, true);
    try {
      await screen.findByTestId("permission-judge-chain-rejected");
      const row = await waitFor(() => {
        const found = view.container.querySelector<HTMLElement>('[data-setting-registered="true"][data-setting-id="permissions.judge.chain"]');
        expect(found).toBeTruthy(); return requiredFixture(found);
      });
      fireEvent.click(requiredFixture(row.querySelector('button')));
      await waitFor(() => expect(view.judgeSet).toHaveBeenCalledExactlyOnceWith({ chain: [] }));
      await waitFor(() => expect(screen.queryByTestId("permission-judge-chain-rejected")).toBeNull());
      expect(view.api.updateSettings).not.toHaveBeenCalled();
    } finally { view.restore(); }
  });

  it("registers every persisted evaluator input against its owning control", async () => {
    const stored = settings();
    stored.chain = [{ id: "local", provider: "external", external: { command: ["/opt/judge", "--check"], env: ["POLICY_DIR"] } }, { id: "review", provider: "builtin-llm" }];
    const view = mount({ settings: stored }, true, false);
    try {
      await screen.findByLabelText("Arguments · one per line, blank lines ignored");
      await waitFor(() => expect(view.container.querySelector('[data-setting-registered="true"][data-setting-id="permissions.judge.chain"]')).toBeTruthy());
      expect(_unregisteredSettingsControlsForTest(view.container)).toEqual([]);
    } finally { view.restore(); }
  });
});

it("keeps the reviewer model modified when its owning reset is refused", async () => {
  const stored = settings();
  stored.model = { vendor: "openai-compatible", model: "team/reviewer" };
  const view = mount({ settings: stored }, true);
  try {
    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-setting-registered="true"][data-setting-id="permissions.judge.model"]');
      expect(found).toBeTruthy(); return requiredFixture(found);
    });
    view.judgeSet.mockResolvedValueOnce({ ok: false, error: "judge-save-failed" });
    fireEvent.click(requiredFixture(row.querySelector('button')));
    await waitFor(() => expect(row.closest('[data-settings-actions]')).toHaveTextContent(t("settingsEditor.actionFailed")));
    expect(row.dataset.settingModified).toBe("true");
    expect(view.notifySaved).not.toHaveBeenCalled();
    expect(view.api.updateSettings).not.toHaveBeenCalled();
  } finally { view.restore(); }
});
