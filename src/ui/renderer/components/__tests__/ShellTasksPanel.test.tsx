// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellTasksPanel } from "../ShellTasksPanel.js";
import type { AveApi } from "../../types.js";
import { t } from "../../../../i18n/index.js";

describe("command tasks", () => {
  it("scopes Ctrl+B to its own composer and refreshes the command list", async () => {
    const own = document.createElement("textarea");
    const other = document.createElement("textarea");
    document.body.append(own, other);
    const api = {
      chatListShellTasks: vi.fn(async () => [{ shellId: "shell", command: "sleep 8", startedAt: "", status: "running", backgrounded: true, canBackground: false, canStop: true, output: "ready" }]),
      chatControlShellTask: vi.fn(async () => ({ ok: true, shellId: "shell" })),
    } as unknown as AveApi;
    const composerRef = { current: { textarea: () => own, focus: () => {}, insertAtCursor: () => {},
      insertFileReference: () => ({ inserted: false }), insertFileMention: () => ({ inserted: false }) } };
    render(<ShellTasksPanel api={api} sessionId="session" composerRef={composerRef} />);
    fireEvent.keyDown(other, { key: "b", ctrlKey: true });
    expect(api.chatControlShellTask).not.toHaveBeenCalled();
    fireEvent.keyDown(own, { key: "b", ctrlKey: true });
    await waitFor(() => expect(api.chatControlShellTask).toHaveBeenCalledWith("session", "background", undefined));
    expect(await screen.findByText("sleep 8")).toBeVisible();
    fireEvent.click(screen.getByText(t("shellTasks.output")));
    expect(screen.getByText("ready")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: t("shellTasks.stop") }));
    await waitFor(() => expect(api.chatControlShellTask).toHaveBeenCalledWith("session", "stop", "shell"));
    own.remove(); other.remove();
  });
});
