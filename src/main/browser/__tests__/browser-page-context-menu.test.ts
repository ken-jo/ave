import { describe, expect, it, vi } from "vitest";
import { pageContextMenu, type PageContextMenuActions, type PageContextMenuParams } from "../browser-page-context-menu.js";

vi.mock("../../../i18n/index.js", () => ({ t: (key: string) => key }));

const FLAGS = { canCut: false, canCopy: false, canPaste: false, canSelectAll: true };
const params = (over: Partial<PageContextMenuParams> = {}): PageContextMenuParams => ({ linkURL: "", selectionText: "", isEditable: false, editFlags: FLAGS, ...over });
function actions(over: Partial<PageContextMenuActions> = {}) {
  return { pageUrl: "https://site.example/page", canGoBack: true, canGoForward: false, back: vi.fn(), forward: vi.fn(), reload: vi.fn(), openLinkInNewTab: vi.fn(), copyText: vi.fn(), openInSystemBrowser: vi.fn(), ...over };
}
const labels = (items: ReturnType<typeof pageContextMenu>) => items.map((item) => item.type ?? item.id ?? item.role);
const click = (items: ReturnType<typeof pageContextMenu>, id: string) => (items.find((item) => item.id === id)?.click as (() => void) | undefined)?.();

describe("pageContextMenu", () => {
  it("offers navigation and the system browser on a plain page, with history deciding what is enabled", () => {
    const act = actions();
    const items = pageContextMenu(params(), act);
    expect(labels(items)).toEqual(["back", "forward", "reload", "selectAll", "separator", "open-in-system-browser"]);
    expect(items.find((item) => item.id === "back")?.enabled).toBe(true);
    expect(items.find((item) => item.id === "forward")?.enabled).toBe(false);
    for (const id of ["back", "reload", "open-in-system-browser"]) click(items, id);
    expect(act.back).toHaveBeenCalledOnce(); expect(act.reload).toHaveBeenCalledOnce();
    expect(act.openInSystemBrowser).toHaveBeenCalledWith("https://site.example/page");
  });
  it("offers a web link in a new tab and as text, and nothing for a link that is not a web address", () => {
    const act = actions();
    const items = pageContextMenu(params({ linkURL: "https://other.example/a?b=1" }), act);
    expect(labels(items).slice(0, 3)).toEqual(["open-link-in-new-tab", "copy-link", "separator"]);
    click(items, "open-link-in-new-tab"); click(items, "copy-link");
    expect(act.openLinkInNewTab).toHaveBeenCalledWith("https://other.example/a?b=1");
    expect(act.copyText).toHaveBeenCalledWith("https://other.example/a?b=1");
    for (const linkURL of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@other.example/"]) {
      expect(labels(pageContextMenu(params({ linkURL }), actions()))).not.toContain("open-link-in-new-tab");
    }
  });
  it("offers editing by the field's own flags, copy for a selection, and no system browser without a web page", () => {
    const edit = pageContextMenu(params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: false, canSelectAll: true } }), actions());
    expect(labels(edit).slice(0, 5)).toEqual(["cut", "copy", "paste", "selectAll", "separator"]);
    expect(edit.find((item) => item.role === "paste")?.enabled).toBe(false);
    const selection = pageContextMenu(params({ selectionText: " words ", editFlags: { ...FLAGS, canCopy: true } }), actions({ pageUrl: null }));
    expect(labels(selection)).toEqual(["copy", "separator", "back", "forward", "reload"]);
  });
});
