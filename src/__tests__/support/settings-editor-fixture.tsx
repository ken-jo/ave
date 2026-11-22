import type { ReactNode } from "react";
import { vi } from "vitest";
import { setLocale } from "../../i18n/runtime.js";
import { SettingsEditorProvider, useSettingsEditor } from "../../ui/renderer/context/SettingsEditorContext.js";
import { SavedToastProvider } from "../../ui/renderer/context/SavedToastContext.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../test/renderer/mock-ave-api.js";

function Loaded({ children }: { children: ReactNode }) {
  return useSettingsEditor()?.settings ? children : null;
}

export function installSettingsEditor() {
  setLocale("en");
  const { api } = makeMockAveApi();
  const { ns } = makeMockAveNamespace();
  vi.stubGlobal("ave", ns);
  vi.stubGlobal("aveApi", api);
  const saved = vi.fn();
  function content(children: ReactNode, reloadEpoch = 0) {
    return <SettingsEditorProvider api={api as never} modifiedOnly={false} reloadEpoch={reloadEpoch}><Loaded><SavedToastProvider value={saved}>{children}</SavedToastProvider></Loaded></SettingsEditorProvider>;
  }
  return { api, ns, saved, content };
}
