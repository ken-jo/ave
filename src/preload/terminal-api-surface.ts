import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import { parseTerminalControlEvent, parseTerminalDataEvent, parseTerminalExitEvent, type TerminalApi } from "../shared/terminal-session.js";

export function buildTerminalApiSurface(): TerminalApi {
  return {
    spawn: (payload) => ipcRenderer.invoke(CHANNELS.terminal.spawn, payload),
    input: (ref, data) => ipcRenderer.invoke(CHANNELS.terminal.input, { ...ref, data }),
    resize: (ref, cols, rows) => ipcRenderer.invoke(CHANNELS.terminal.resize, { ...ref, cols, rows }),
    kill: (tabId) => ipcRenderer.invoke(CHANNELS.terminal.kill, { tabId }),
    listBlocks: (ref) => ipcRenderer.invoke(CHANNELS.terminal.blocks, ref),
    getBlock: (ref, blockId) => ipcRenderer.invoke(CHANNELS.terminal.block, { ...ref, blockId }),
    control: (ref, action) => ipcRenderer.invoke(CHANNELS.terminal.control, { ...ref, action }),
    onData: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = parseTerminalDataEvent(payload);
        if (!parsed || parsed.lane !== "manual") throw new Error("invalid-terminal-data-event");
        handler(parsed);
      };
      ipcRenderer.on(CHANNELS.terminal.data, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.data, listener);
    },
    onExit: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = parseTerminalExitEvent(payload);
        if (!parsed || parsed.lane !== "manual") throw new Error("invalid-terminal-exit-event");
        handler(parsed);
      };
      ipcRenderer.on(CHANNELS.terminal.exit, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.exit, listener);
    },
    onControl: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = parseTerminalControlEvent(payload);
        if (!parsed || parsed.lane !== "manual") throw new Error("invalid-terminal-control-event");
        handler(parsed);
      };
      ipcRenderer.on(CHANNELS.terminal.controlChanged, listener);
      return () => ipcRenderer.removeListener(CHANNELS.terminal.controlChanged, listener);
    },
  };
}
