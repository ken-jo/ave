/** Empty plugin selection means deny-all; the button label and submitted scope must agree. */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { AddRoutineModal } from "../components/RoutinePanel.js";
import type { AveApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, RoutineRecord } from "../../../shared/routines-types.js";
import type { AgentPluginRoutineTemplate } from "../../../shared/agent-plugin-routine-template.js";
import { packageRoutineSource } from "../../../shared/agent-plugin-routine-template.js";
import { MAX_ROUTINE_SOURCE_LENGTH } from "../../../shared/routines-types.js";

function makeStubApi(opts: {
  pluginCards?: PluginCardSummary[];
  addRoutine: ReturnType<typeof vi.fn>;
}): AveApi {
  const cards = opts.pluginCards ?? [];
  return {
    listPluginCards: vi.fn().mockResolvedValue(cards),
    chatSessions: vi.fn().mockResolvedValue({ current: "", sessions: [] }),
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
