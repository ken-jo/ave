// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  coalesceRefresh,
  notifyWorkspaceFilesChanged,
  notifyWorkspaceFilesChangedByStream,
  subscribeWorkspaceFilesChanged,
} from "../workspace-files-signal.js";

describe("workspace files signal", () => {
  it("reaches every listener for a finished tool, a finished turn, a rewind and window focus, and stops after unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeWorkspaceFilesChanged(first);
    const offSecond = subscribeWorkspaceFilesChanged(second);
    notifyWorkspaceFilesChangedByStream({ type: "text_delta" });
    expect(first).not.toHaveBeenCalled();
    notifyWorkspaceFilesChangedByStream({ type: "tool_end" });
    notifyWorkspaceFilesChangedByStream({ type: "done" });
    notifyWorkspaceFilesChanged("checkpoint");
    window.dispatchEvent(new Event("focus"));
    expect(first.mock.calls.map(([reason]) => reason)).toEqual(["tool", "turn", "checkpoint", "focus"]);
    expect(second).toHaveBeenCalledTimes(4);
    offFirst();
    offSecond();
    window.dispatchEvent(new Event("focus"));
    notifyWorkspaceFilesChanged("manual");
    expect(first).toHaveBeenCalledTimes(4);
  });

  it("runs one query at a time and exactly one more after a burst that arrived while it ran", async () => {
    const finish: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => { finish.push(resolve); }));
    const request = coalesceRefresh(run);
    request();
    request();
    request();
    expect(run).toHaveBeenCalledTimes(1);
    finish.shift()?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    request();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
