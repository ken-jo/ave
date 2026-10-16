// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  getTerminalAttention,
  latestUnreadTerminal,
  markTerminalRead,
  parseTerminalNotifications,
  setTerminalAttended,
  setTerminalReplaying,
  useTerminalAttentionWatcher,
} from "../terminal-attention.js";

const BEL = "\x07";
const ST = "\x1b\\";

function terminalSource() {
  const listeners = new Set<(payload: { tabId: string; chunk: string }) => void>();
  return {
    onData: (listener: (payload: { tabId: string; chunk: string }) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit: (tabId: string, chunk: string) => {
      for (const listener of [...listeners]) listener({ tabId, chunk });
    },
  };
}

const label = (tabId: string) => `title ${tabId}`;

describe("parseTerminalNotifications", () => {
  it("reads OSC 9 and OSC 777 notify, ended by BEL or ST", () => {
    expect(parseTerminalNotifications(`a\x1b]9;build done${BEL}b`)).toEqual(["build done"]);
    expect(parseTerminalNotifications(`\x1b]9;tests passed${ST}`)).toEqual(["tests passed"]);
    expect(parseTerminalNotifications(`\x1b]777;notify;Deploy;finished${BEL}`)).toEqual(["Deploy: finished"]);
    expect(parseTerminalNotifications(`\x1b]777;notify;Only title${BEL}`)).toEqual(["Only title"]);
  });

  it("ignores progress reports, other OSC 777 kinds and other OSCs", () => {
    expect(parseTerminalNotifications(`\x1b]9;4;1;50${BEL}`)).toEqual([]);
    expect(parseTerminalNotifications(`\x1b]777;precmd${BEL}`)).toEqual([]);
    expect(parseTerminalNotifications(`\x1b]0;window title${BEL}\x1b]133;A${BEL}`)).toEqual([]);
  });
});

describe("useTerminalAttentionWatcher", () => {
  let focused = true;
  beforeEach(() => {
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });
  afterEach(() => {
    for (const tabId of [...getTerminalAttention().keys()]) markTerminalRead(tabId);
    for (const tabId of ["terminal:1", "terminal:2"]) {
      setTerminalAttended(tabId, false);
      setTerminalReplaying(tabId, false);
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks an unseen terminal unread, and a sequence split across chunks still counts once", () => {
    const source = terminalSource();
    const { unmount } = renderHook(() => useTerminalAttentionWatcher(source, label));
    source.emit("terminal:1", "out \x1b]9;bui");
    expect(getTerminalAttention().size).toBe(0);
    source.emit("terminal:1", `ld done${BEL} more`);
    expect(getTerminalAttention().get("terminal:1")?.message).toBe("build done");
    source.emit("terminal:2", `\x1b]9;second${BEL}`);
    expect(latestUnreadTerminal()?.tabId).toBe("terminal:2");
    unmount();
  });

  it("does not ring for a terminal being looked at, and seeing one reads it", () => {
    const source = terminalSource();
    renderHook(() => useTerminalAttentionWatcher(source, label));
    setTerminalAttended("terminal:1", true);
    source.emit("terminal:1", `\x1b]9;seen${BEL}`);
    expect(getTerminalAttention().has("terminal:1")).toBe(false);

    source.emit("terminal:2", `\x1b]9;unseen${BEL}`);
    expect(getTerminalAttention().has("terminal:2")).toBe(true);
    setTerminalAttended("terminal:2", true);
    expect(getTerminalAttention().has("terminal:2")).toBe(false);
  });

  it("skips the scrollback a re-attaching view is replayed", () => {
    const source = terminalSource();
    renderHook(() => useTerminalAttentionWatcher(source, label));
    setTerminalReplaying("terminal:1", true);
    source.emit("terminal:1", `old \x1b]9;already seen${BEL}`);
    setTerminalReplaying("terminal:1", false);
    expect(getTerminalAttention().size).toBe(0);
    source.emit("terminal:1", `\x1b]9;new${BEL}`);
    expect(getTerminalAttention().get("terminal:1")?.message).toBe("new");
  });

  it("tells the OS only while the window is not focused, and window focus reads what is in view", () => {
    const shown: Array<{ title: string; body: string | undefined }> = [];
    vi.stubGlobal("Notification", class {
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, body: options?.body });
      }
    });
    const source = terminalSource();
    renderHook(() => useTerminalAttentionWatcher(source, label));

    source.emit("terminal:2", `\x1b]9;while focused${BEL}`);
    expect(shown).toEqual([]);

    focused = false;
    setTerminalAttended("terminal:1", true);
    source.emit("terminal:1", `\x1b]9;while away${BEL}`);
    expect(shown).toEqual([{ title: "title terminal:1", body: "while away" }]);
    // In view but the window was elsewhere: unread until the window comes back.
    expect(getTerminalAttention().has("terminal:1")).toBe(true);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    expect(getTerminalAttention().has("terminal:1")).toBe(false);
    expect(getTerminalAttention().has("terminal:2")).toBe(true);
  });
});
