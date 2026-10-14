// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../../../i18n/runtime.js";
import { getLocale } from "../../../../i18n/runtime.js";
import {
  mergeSuggestedTasksProviders,
  staticSuggestedTasksProvider,
  type SuggestedTask,
  type SuggestedTasksProvider,
} from "../provider.js";
import { SuggestedTasksProviderContext } from "../use-suggested-tasks.js";
import { SuggestedTasksPanel } from "../../components/SuggestedTasksPanel.js";

const request = () => ({ locale: getLocale(), t, signal: new AbortController().signal });
const task = (id: string, source = "x"): SuggestedTask => ({ id, title: id, prompt: `do ${id}`, source });
const provider = (id: string, list: SuggestedTasksProvider["list"]): SuggestedTasksProvider => ({ id, list });

describe("staticSuggestedTasksProvider", () => {
  it("returns localized web, terminal and file tasks with no raw keys", async () => {
    const tasks = await staticSuggestedTasksProvider.list(request());
    expect(tasks.length).toBeGreaterThanOrEqual(4);
    const icons = new Set(tasks.map((x) => x.icon));
    expect(icons.has("globe") && icons.has("terminal") && icons.has("file")).toBe(true);
    for (const x of tasks) {
      expect(x.source).toBe("static");
      expect(x.title).not.toMatch(/^suggestedTasks\./);
      expect(x.prompt).not.toMatch(/^suggestedTasks\./);
    }
  });
});

describe("mergeSuggestedTasksProviders", () => {
  it("keeps priority order, lets an earlier provider replace a card by id, and caps the list", async () => {
    const merged = mergeSuggestedTasksProviders(
      [provider("a", async () => [task("1", "a"), task("2", "a")]), provider("b", async () => [task("2", "b"), task("3", "b")])],
      2,
    );
    expect((await merged.list(request())).map((x) => `${x.source}:${x.id}`)).toEqual(["a:1", "a:2"]);
  });

  it("skips a failing provider and rejects only when all fail", async () => {
    const ok = provider("ok", async () => [task("1")]);
    const bad = provider("bad", async () => {
      throw new Error("boom");
    });
    expect((await mergeSuggestedTasksProviders([bad, ok]).list(request())).map((x) => x.id)).toEqual(["1"]);
    await expect(mergeSuggestedTasksProviders([bad, bad]).list(request())).rejects.toThrow("boom");
  });
});

function renderPanel(p: SuggestedTasksProvider, onChoose = vi.fn()) {
  render(
    <SuggestedTasksProviderContext.Provider value={p}>
      <SuggestedTasksPanel onChoose={onChoose} />
    </SuggestedTasksProviderContext.Provider>,
  );
  return onChoose;
}

describe("SuggestedTasksPanel", () => {
  it("shows a busy skeleton while the provider is pending, then the cards", async () => {
    let resolve: (tasks: SuggestedTask[]) => void = () => {};
    const onChoose = renderPanel(provider("slow", () => new Promise((r) => (resolve = r))));
    expect(screen.getByTestId("suggested-tasks")).toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("suggested-tasks")).toHaveAttribute("aria-busy", "true");
    await act(async () => resolve([task("hello")]));
    fireEvent.click(await screen.findByText("hello"));
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: "hello", prompt: "do hello" }));
  });

  it("renders nothing when the provider has no suggestions", async () => {
    renderPanel(provider("none", async () => []));
    await waitFor(() => expect(screen.queryByTestId("suggested-tasks")).toBeNull());
  });

  it("shows an error with a retry that asks the provider again", async () => {
    const list = vi
      .fn<SuggestedTasksProvider["list"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([task("again")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderPanel(provider("flaky", list));
    fireEvent.click(await screen.findByTestId("suggested-tasks-retry"));
    expect(await screen.findByText("again")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("falls back to the generic icon for an icon outside the vocabulary", async () => {
    renderPanel(provider("odd", async () => [{ ...task("odd"), icon: "rocket" as never }]));
    expect(await screen.findByText("odd")).toBeTruthy();
  });
});
