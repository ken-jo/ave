/**
 * The context menu of a page in a user's browser tab. The page supplies only what was under the pointer; every label is
 * the host's, and each action is checked again here: a link is offered only when it is a web address.
 */
import type { MenuItemConstructorOptions } from "electron";
import { t } from "../../i18n/index.js";
import { browserWorkspaceUrl } from "../../shared/browser-workspace.js";

export interface PageContextMenuParams {
  readonly linkURL: string; readonly selectionText: string; readonly isEditable: boolean;
  readonly editFlags: { readonly canCut: boolean; readonly canCopy: boolean; readonly canPaste: boolean; readonly canSelectAll: boolean };
}
export interface PageContextMenuActions {
  readonly pageUrl: string | null; readonly canGoBack: boolean; readonly canGoForward: boolean;
  back(): void; forward(): void; reload(): void;
  /** Absent where there is no tab to open a link beside (a popup window). */
  readonly openLinkInNewTab?: (url: string) => void;
  copyText(text: string): void; openInSystemBrowser(url: string): void;
}

export function pageContextMenu(params: PageContextMenuParams, actions: PageContextMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const link = browserWorkspaceUrl(params.linkURL);
  if (link !== null) {
    const openLink = actions.openLinkInNewTab;
    if (openLink) items.push({ id: "open-link-in-new-tab", label: t("browserContextMenu.openLinkInNewTab"), click: () => openLink(link) });
    items.push(
      { id: "copy-link", label: t("browserContextMenu.copyLink"), click: () => actions.copyText(link) },
      { type: "separator" },
    );
  }
  if (params.isEditable) {
    items.push(
      { role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste }, { role: "selectAll", enabled: params.editFlags.canSelectAll },
      { type: "separator" },
    );
  } else if (params.selectionText.trim().length > 0) {
    items.push({ role: "copy", enabled: params.editFlags.canCopy }, { type: "separator" });
  }
  items.push(
    { id: "back", label: t("browserContextMenu.back"), enabled: actions.canGoBack, click: actions.back },
    { id: "forward", label: t("browserContextMenu.forward"), enabled: actions.canGoForward, click: actions.forward },
    { id: "reload", label: t("browserContextMenu.reload"), click: actions.reload },
  );
  if (!params.isEditable && params.selectionText.trim().length === 0) items.push({ role: "selectAll", enabled: params.editFlags.canSelectAll });
  const page = actions.pageUrl;
  if (page !== null) {
    items.push({ type: "separator" }, { id: "open-in-system-browser", label: t("browserContextMenu.openInSystemBrowser"), click: () => actions.openInSystemBrowser(page) });
  }
  return items;
}
