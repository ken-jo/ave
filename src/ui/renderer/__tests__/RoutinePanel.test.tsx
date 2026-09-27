/**
 * RoutinePanel button label / payload mapping lock.
 *
 * Asserts the contract surfaced by the panel: when the user clicks the
 * "선택 해제 (익스텐션 사용 안 함)" button or leaves the plugin list empty,
 * the resulting `addRoutine` payload uses `{ mode: "deny-all" }` per
 * spec §3 Layer 4 (RoutinePluginScope discriminated union). Catches a
 * regression the panel already had once: the label said "전체 허용" while the
 * actual semantic is deny-all — copy and behavior must agree.
 */
import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { AddRoutineModal } from "../components/RoutinePanel.js";
import type { AveApi, PluginCardSummary } from "../types.js";
import type { AddRoutineInput, RoutineRecord } from "../../../shared/routines-types.js";

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

    // Wait for plugin cards to load.
    await waitFor(() => {
      getByTestId("routine-allowed-plugin-plugin-a");
    });

    // Provide minimal valid form input: prePrompt + atDate.
    fireEvent.change(getByTestId("pre-prompt-input"), { target: { value: "do thing" } });
    // The form tab needs at least an `atDate`. Pick a date input.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBeGreaterThan(0);
    fireEvent.change(dateInputs[0]!, { target: { value: validFutureDate() } });

    // Toggle plugin on then off — exercising the click path. Final state empty.
    const checkbox = getByTestId("routine-allowed-plugin-plugin-a");
    fireEvent.click(checkbox); // selected
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    // Click the "선택 해제 (익스텐션 사용 안 함)" button — clears selection.
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
      listRoutines: vi.fn(async () => rows), listRoutineSessions: vi.fn(async () => []), removeRoutine,
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

it("refreshes a skipped occurrence while open without a fired event", async () => {
  const { RoutinePanel } = await import("../components/RoutinePanel.js");
  let rows: RoutineRecord[] = [{ id: "waiting", title: "Waiting", trigger: "schedule", execution: "llm-session", createdAt: new Date().toISOString() }];
  const api = { listRoutines: vi.fn(async () => rows), listRoutineSessions: vi.fn(async () => []) } as unknown as AveApi;
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
