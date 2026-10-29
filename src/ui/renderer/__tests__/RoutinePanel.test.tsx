/** Empty plugin selection means deny-all; the button label and submitted scope must agree. */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { AddRoutineModal, RoutinePanel } from "../components/RoutinePanel.js";
import type { AveApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, RoutineRecord } from "../../../shared/routines-types.js";
import type { AgentPluginRoutineTemplate } from "../../../shared/agent-plugin-routine-template.js";
import { packageRoutineSource } from "../../../shared/agent-plugin-routine-template.js";
import { MAX_ROUTINE_SOURCE_LENGTH } from "../../../shared/routines-types.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../installed-content.js";
import type { InstalledContentApi, InstalledContentView } from "../../../shared/installed-content.js";

function makeStubApi(opts: {
  pluginCards?: PluginCardSummary[];
  addRoutine: ReturnType<typeof vi.fn>;
}): AveApi {
  const cards = opts.pluginCards ?? [];
  return {
    listPluginCards: vi.fn().mockResolvedValue(cards),
    addRoutine: opts.addRoutine,
  } as unknown as AveApi;
}

function makeRoutineRecord(): RoutineRecord {
  return {
    id: "rt-1",
    trigger: "schedule",
    execution: "llm-session",
    prePrompt: "test",
    title: "test",
    schedule: { at: new Date().toISOString(), repeat: { kind: "none" } },
    scope: { pluginIds: { mode: "deny-all" }, forcedPluginIds: [], directories: [] },
    createdAt: new Date().toISOString(),
    state: "active",
    firedAt: null,
    dismissedAt: null,
  } as unknown as RoutineRecord;
}

function validFutureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("RoutinePanel scope payload mapping", () => {
  it("fits the longest package and template names in the persisted source field", () => {
    expect(packageRoutineSource({ packageName: "a".repeat(63), id: "b".repeat(63) })).toHaveLength(MAX_ROUTINE_SOURCE_LENGTH);
    expect(packageRoutineSource({ packageName: "writer-extension", id: "daily", sourceKind: "extension" }))
      .toBe("extension:writer-extension:daily");
  });

  it("prefills a plugin template while keeping suggested scope unselected", async () => {
    const addRoutine = vi.fn().mockResolvedValue({ ok: true, routine: makeRoutineRecord() });
    const template: AgentPluginRoutineTemplate = {
      id: "daily", packageName: "writer-plugin", version: "1.0.0", title: "Daily draft", description: "Write a draft",
      trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
      execution: "llm-session", prePrompt: "Write the draft", suggestedScope: { pluginIds: ["writer-extension"] },
    };
    const view = render(<AddRoutineModal api={makeStubApi({ addRoutine })} template={template} onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(view.getByTestId("routine-template-scope-suggestion").textContent).toContain("writer-extension");
    expect((view.getByTestId("pre-prompt-input") as HTMLTextAreaElement).value).toBe("Write the draft");
    expect((view.getByTestId("cron-input") as HTMLInputElement).value).toBe("0 9 * * *");
    await act(async () => { fireEvent.click(view.getByText("등록")); });
    await waitFor(() => expect(addRoutine).toHaveBeenCalledOnce());
    expect(addRoutine.mock.calls[0]![0]).toMatchObject({
      source: "agent-plugin:writer-plugin:daily", scope: { pluginIds: { mode: "deny-all" } },
      schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } }, prePrompt: "Write the draft",
    });
  });

  it("sends a natural-language routine as the user's turn with the click's gesture token", async () => {
    const intent = { inputOrigin: "user-keyboard" as const, token: "click-token" };
    const api = {
      ...makeStubApi({ addRoutine: vi.fn() }),
      captureUserKeyboardIntent: vi.fn(() => intent),
      chatSend: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as AveApi;
    const view = render(<AddRoutineModal api={api} onClose={vi.fn()} onAdded={vi.fn()} />);
    fireEvent.click(view.getByText("자연어"));
    fireEvent.change(view.getByTestId("natural-input"), { target: { value: "매일 아침 9시에 리포트" } });
    await act(async () => { fireEvent.click(view.getByText("등록")); });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledOnce());
    expect(api.chatSend).toHaveBeenCalledWith(expect.stringContaining("매일 아침 9시에 리포트"), undefined, "user-keyboard", intent);
  });

  it("empty plugin selection submits scope.pluginIds = { mode: 'deny-all' }", async () => {
    const addRoutine = vi.fn().mockResolvedValue({ ok: true, routine: makeRoutineRecord() });
    const api = makeStubApi({
      pluginCards: [
        {
          id: "plugin-a",
          name: "Plugin A",
          description: "",
          sampleTools: [],
          capabilities: [],
          tools: ["tool_a"],
          loadStatus: "loaded",
        },
      ],
      addRoutine,
    });
    const onClose = vi.fn();
    const onAdded = vi.fn();

    const { getByTestId, getByText } = render(
      <AddRoutineModal api={api} onClose={onClose} onAdded={onAdded} />,
    );

    await waitFor(() => {
      getByTestId("routine-allowed-plugin-plugin-a");
    });

    fireEvent.change(getByTestId("pre-prompt-input"), { target: { value: "do thing" } });
    // The form tab needs at least an `atDate`. Pick a date input.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThan(0);
    fireEvent.change(dateInputs[0]!, { target: { value: validFutureDate() } });

    const checkbox = getByTestId("routine-allowed-plugin-plugin-a");
    fireEvent.click(checkbox); // selected
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    const clearBtn = getByTestId("routine-clear-allowed-plugins");
    expect(clearBtn.textContent).toContain("익스텐션 사용 안 함");
    fireEvent.click(clearBtn);

    // Submit. The "등록" button is the second one in the modal (first is 취소).
    const registerBtn = getByText("등록") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(registerBtn);
    });

    await waitFor(() => {
      expect(addRoutine).toHaveBeenCalledTimes(1);
    });
    const payload = addRoutine.mock.calls[0]![0] as AddRoutineInput;
    expect(payload.scope).toBeDefined();
    expect(payload.scope?.pluginIds).toEqual({ mode: "deny-all" });
    // Sanity: forcedPluginIds + directories defaults preserved.
    expect(payload.scope?.forcedPluginIds).toEqual([]);
    expect(payload.scope?.directories).toEqual([]);
  });

  it("non-empty plugin selection submits scope.pluginIds = { mode: 'allow', ids }", async () => {
    const addRoutine = vi.fn().mockResolvedValue({ ok: true, routine: makeRoutineRecord() });
    const api = makeStubApi({
      pluginCards: [
        {
          id: "plugin-a",
          name: "Plugin A",
          description: "",
          sampleTools: [],
          capabilities: [],
          tools: ["tool_a"],
          loadStatus: "loaded",
        },
      ],
      addRoutine,
    });

    const { getByTestId, getByText } = render(
      <AddRoutineModal api={api} onClose={vi.fn()} onAdded={vi.fn()} />,
    );

    await waitFor(() => {
      getByTestId("routine-allowed-plugin-plugin-a");
    });

    fireEvent.change(getByTestId("pre-prompt-input"), { target: { value: "do thing" } });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0]!, { target: { value: validFutureDate() } });
    fireEvent.click(getByTestId("routine-allowed-plugin-plugin-a"));

    const registerBtn = getByText("등록") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(registerBtn);
    });

    await waitFor(() => {
      expect(addRoutine).toHaveBeenCalledTimes(1);
    });
    const payload = addRoutine.mock.calls[0]![0] as AddRoutineInput;
    expect(payload.scope?.pluginIds).toEqual({ mode: "allow", ids: ["plugin-a"] });
  });
});

describe("RoutinePanel missing plugins", () => {
  it.each([true, false])("shows missing ids and removes the routine (skipped=%s)", async (skipped) => {
    const { RoutinePanel } = await import("../components/RoutinePanel.js");
    const routine: RoutineRecord = {
      id: "missing-routine", trigger: "schedule", execution: "llm-session", title: "Daily summary",
      createdAt: new Date().toISOString(),
      needsAttention: { missingPluginIds: ["missing-plugin"] },
      ...(skipped ? { lastSkippedReason: "plugins-missing" as const } : { lastFiredAt: new Date().toISOString() }),
    };
    let rows = [routine];
    const removeRoutine = vi.fn(async () => { rows = []; return { ok: true }; });
    const api = {
      listRoutines: vi.fn(async () => ({ routines: rows, invalid: [] })), listRoutineSessions: vi.fn(async () => []), removeRoutine,
      onRoutineFired: vi.fn(() => () => {}),
    } as unknown as AveApi;
    const view = render(<RoutinePanel api={api} />);
    const status = await view.findByRole("status");
    expect(status.textContent).toContain("missing-plugin");
    expect(status.textContent).toContain(skipped ? "건너뛰었습니다" : "확인이 필요합니다");
    fireEvent.click(view.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(view.queryByTestId("routine-row")).toBeNull());
    expect(removeRoutine).toHaveBeenCalledWith("missing-routine");
  });
});

describe("RoutinePanel invalid routines", () => {
  it("shows a held-back routine as an error row with its reason and removes it", async () => {
    const { RoutinePanel } = await import("../components/RoutinePanel.js");
    let invalid = [{ id: "legacy-routine", field: "scope.pluginIds.ids", value: "Legacy.Plugin", reason: "invalid-plugin-id" as const }];
    const removeRoutine = vi.fn(async () => { invalid = []; return { ok: true }; });
    const api = {
      listRoutines: vi.fn(async () => ({ routines: [], invalid })), listRoutineSessions: vi.fn(async () => []), removeRoutine,
      onRoutineFired: vi.fn(() => () => {}),
    } as unknown as AveApi;
    const view = render(<RoutinePanel api={api} />);
    const row = await view.findByTestId("invalid-routine-row");
    expect(row.getAttribute("role")).toBe("alert");
    expect(row.textContent).toContain("Legacy.Plugin");
    expect(row.textContent).toContain("scope.pluginIds.ids");
    fireEvent.click(view.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(view.queryByTestId("invalid-routine-row")).toBeNull());
    expect(removeRoutine).toHaveBeenCalledWith("legacy-routine");
  });
});

it("keeps a user routine after its source template disappears", async () => {
  const template: AgentPluginRoutineTemplate = { id: "daily", packageName: "writer-plugin", version: "1.0.0", title: "Daily draft",
    description: "Write a draft", trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
    execution: "llm-session", prePrompt: "Write the full draft" };
  const content = (templates: AgentPluginRoutineTemplate[]): InstalledContentView => ({
    themes: [], languages: [], fonts: [], routineTemplates: templates, broken: [],
  });
  const contentApi = { languageMessages: vi.fn(), installed: vi.fn() } as unknown as InstalledContentApi;
  const routine = { ...makeRoutineRecord(), source: "agent-plugin:writer-plugin:daily" };
  const api = { listRoutines: vi.fn(async () => ({ routines: [routine], invalid: [] })), listRoutineSessions: vi.fn(async () => []),
    onRoutineFired: vi.fn(() => () => {}) } as unknown as AveApi;
  try {
    act(() => applyInstalledContent(content([template]), contentApi));
    const view = render(<RoutinePanel api={api} />);
    await view.findByTestId("routine-row");
    expect(view.getByTestId("routine-template-row").textContent).toContain("Write the full draft");
    expect(view.getByTestId("routine-row").textContent).toContain("writer-plugin");
    act(() => applyInstalledContent(content([]), contentApi));
    expect(view.queryByTestId("routine-template-row")).toBeNull();
    expect(view.getByTestId("routine-row").textContent).toContain("더 이상 설치");
    view.unmount();
  } finally { resetInstalledContentForTests(); }
});

it("refreshes a skipped occurrence while open without a fired event", async () => {
  const { RoutinePanel } = await import("../components/RoutinePanel.js");
  let rows: RoutineRecord[] = [{ id: "waiting", title: "Waiting", trigger: "schedule", execution: "llm-session", createdAt: new Date().toISOString() }];
  const api = { listRoutines: vi.fn(async () => ({ routines: rows, invalid: [] })), listRoutineSessions: vi.fn(async () => []) } as unknown as AveApi;
  vi.useFakeTimers();
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<RoutinePanel api={api} />); });
    expect(view!.queryByRole("status")).toBeNull();
    rows = [{ ...rows[0], lastSkippedReason: "plugins-missing", needsAttention: { missingPluginIds: ["missing-plugin"] } }];
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(view!.getByRole("status").textContent).toContain("missing-plugin");
    view!.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { view?.unmount(); vi.useRealTimers(); }
});
