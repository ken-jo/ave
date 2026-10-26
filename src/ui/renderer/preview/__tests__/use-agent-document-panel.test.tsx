import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentDocumentPanel } from "../use-agent-document-panel.js";
import { useWorkspaceTabs } from "../workspace-tabs.js";
import { openDocumentInPanel } from "../agent-document-bridge.js";
import type { ChatPreviewTarget } from "../preview-targets.js";

const path = "/workspace/book.xlsx";
const existing: ChatPreviewTarget = { id: "existing-file", kind: "file", path, title: "book.xlsx", sourceLabel: "read_document", createdOrder: 0, canOpenExternal: false };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount(options: { initialTargets?: ChatPreviewTarget[]; allowOpen?: boolean } = {}) {
  const element = document.createElement("div"); document.body.append(element);
  vi.spyOn(element, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const addTarget = vi.fn();
  const hook = renderHook(({ sessionId }: { sessionId: string }) => {
    const workspaceTabs = useWorkspaceTabs();
    const [targets, setTargets] = useState<ChatPreviewTarget[]>(options.initialTargets ?? []);
    const [panelVisible, setPanelVisible] = useState(false);
    useAgentDocumentPanel({ api: undefined, sessionId, workspaceTabs, targets,
      panelVisible, panelHidden: false, element: () => element,
      addTarget: (_sessionId, target) => { addTarget(target); setTargets((previous) => [...previous, target]); },
      openPanel: () => { if (options.allowOpen !== false) setPanelVisible(true); },
    });
    return { workspaceTabs, panelVisible, targets };
  }, { initialProps: { sessionId: "one" } });
  return { ...hook, addTarget };
}

describe("agent document panel commit", () => {
  it("selects a fixture file target and only acknowledges after the panel and tab selection commit", async () => {
    const hook = mount();
    let opened!: Promise<boolean>;
    act(() => { opened = openDocumentInPanel(path, "one", Date.now() + 1000); });
    expect(await opened).toBe(true);
    expect(hook.result.current.panelVisible).toBe(true);
    expect(hook.result.current.targets).toContainEqual(expect.objectContaining({ path, kind: "file" }));
    expect(hook.result.current.workspaceTabs.tabs).toHaveLength(1);
    hook.unmount();
  });
  it("reuses an existing pinned file tab", async () => {
    const hook = mount({ initialTargets: [existing] });
    act(() => hook.result.current.workspaceTabs.openPinned({ source: "preview", targetId: existing.id }));
    const id = hook.result.current.workspaceTabs.activeTabId;
    let opened!: Promise<boolean>;
    act(() => { opened = openDocumentInPanel(path, "one", Date.now() + 1000); });
    expect(await opened).toBe(true);
    expect(hook.result.current.workspaceTabs.activeTabId).toBe(id);
    expect(hook.result.current.workspaceTabs.tabs).toHaveLength(1);
    expect(hook.addTarget).not.toHaveBeenCalled();
    hook.unmount();
  });
  it("does not claim success while the panel stays hidden and cleans the pending wait on a session switch", async () => {
    const hook = mount({ allowOpen: false });
    let opened!: Promise<boolean>, settled = false;
    act(() => { opened = openDocumentInPanel(path, "one", Date.now() + 1000).then((value) => { settled = true; return value; }); });
    await Promise.resolve(); expect(settled).toBe(false);
    hook.rerender({ sessionId: "two" });
    expect(await opened).toBe(false);
    hook.unmount();
  });
  it("cleans a pending wait when the request expires", async () => {
    const hook = mount({ allowOpen: false });
    let opened!: Promise<boolean>;
    act(() => { opened = openDocumentInPanel(path, "one", Date.now() + 30); });
    await waitFor(async () => expect(await opened).toBe(false));
    hook.unmount();
  });
});
