import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { DocumentEngineApi } from "../shared/document-engine-api.js";

export function buildDocumentEngineApiSurface(): DocumentEngineApi {
  return {
    status: () => ipcRenderer.invoke(CHANNELS.documentEngine.status),
    install: () => ipcRenderer.invoke(CHANNELS.documentEngine.install),
    cancel: () => ipcRenderer.invoke(CHANNELS.documentEngine.cancel),
    uninstall: () => ipcRenderer.invoke(CHANNELS.documentEngine.uninstall),
  };
}
