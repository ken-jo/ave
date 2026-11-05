import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { useTranslation } from "../../../../i18n/react.js";
import type { SidebarSurface } from "../../hooks/use-sidebar-items.js";
import { loadSidebarSurfacePreview } from "../../utils/sidebar-preview-data.js";
import { BUILTIN_LABEL_KEYS } from "../../utils/view-location.js";
import { tabIcon } from "../ChatSidePanelPreview.js";
import { SidebarPreviewTrigger } from "../SidebarPreview.js";

/** What a tree row needs to take part in the tree's keyboard model (case 20). */
export interface TreeRowProps {
  /** The row's id in the tree, unique across the list: `session:<id>`, `surface:<tabId>`, `project:<root>`. */
  treeKey: string;
  /** Roving tabindex: exactly one row in the tree is 0. */
  tabIndex: 0 | -1;
  /** 1 for a top-level row; 2 under an all-projects group or a terminal's pane chat. */
  level: number;
  onFocusRow: (treeKey: string) => void;
}

/** The row-level classes every tree row shares: the focus ring sits inside the row (case 20). */
export const TREE_ROW_FOCUS_CLASS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The name a terminal or page goes by in the list: its page title or address, else "터미널 3". */
function surfaceLabel(surface: SidebarSurface, t: ReturnType<typeof useTranslation>["t"]): string {
  return surface.title || surface.url || `${t(BUILTIN_LABEL_KEYS[surface.kind === "terminal" ? "terminal" : "web"])} ${surface.ordinal}`;
}

export interface SurfaceRowProps extends TreeRowProps {
  surface: SidebarSurface;
  /** The surface is what the window shows now. */
  current: boolean;
  /** A word after the name for a state the row is in (case 19): "종료됨", "알림". */
  status?: { text: string; tone: "attention" | "muted" };
  onOpen: () => void;
  /** Open the row's menu at a point; the trailing ··· and the context-menu key both call it. */
  onOpenMenu: (at: { x: number; y: number }) => void;
  /** Close the surface. Absent for a side panel's tab, which its panel closes. */
  onClose?: () => void;
}

/**
 * A terminal or page in the project tree (case 19). The row itself is the `treeitem`; the name, ··· and × inside it are
 * buttons the pointer uses, kept out of the tab order so Tab leaves the tree in one step.
 */
export function SurfaceRow({
  surface,
  current,
  status,
  onOpen,
  onOpenMenu,
  onClose,
  treeKey,
  tabIndex,
  level,
  onFocusRow,
}: SurfaceRowProps) {
  const { t } = useTranslation();
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null);
  useEffect(() => {
    setFailedFavicon(null);
  }, [surface.faviconDataUrl]);
  const label = surfaceLabel(surface, t);
  const Icon = tabIcon(surface.kind);
  const faviconUrl = surface.faviconDataUrl;
  const openMenuAt = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  };
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={current}
      tabIndex={tabIndex}
      data-tree-key={treeKey}
      data-testid={`sidebar-surface-tree-${surface.tabId}`}
      onFocus={(event: FocusEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onFocusRow(treeKey); }}
      onContextMenu={openMenuAt}
      className={[
        "group relative flex w-full min-w-0 items-center rounded-md transition-colors",
        TREE_ROW_FOCUS_CLASS,
        current ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      ].join(" ")}
    >
      <SidebarPreviewTrigger
        preview={{ kind: surface.kind, title: label, ...(surface.url ? { url: surface.url } : {}) }}
        loadPreview={() => loadSidebarSurfacePreview(surface, label)}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          aria-current={current ? "page" : undefined}
          title={label}
          data-testid={`sidebar-surface-${surface.tabId}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] focus-visible:outline-none"
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {surface.kind === "browser" && faviconUrl && faviconUrl !== failedFavicon
              ? <img src={faviconUrl} alt="" referrerPolicy="no-referrer" className="h-3.5 w-3.5 object-contain" onError={() => setFailedFavicon(faviconUrl)} />
              : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </button>
      </SidebarPreviewTrigger>
      {status ? (
        <span
          className={[
            "flex shrink-0 items-center gap-1 pr-1 text-[10px] group-hover:hidden group-focus-within:hidden",
            status.tone === "attention" ? "text-warning" : "text-muted-foreground",
          ].join(" ")}
          data-testid={`sidebar-surface-status-${surface.tabId}`}
        >
          {status.tone === "attention" ? <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" /> : null}
          {status.text}
        </span>
      ) : null}
      <button
        type="button"
        tabIndex={-1}
        onClick={openMenuAt}
        className="hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none group-hover:flex group-focus-within:flex"
        aria-label={t("sidebar.surfaceMenu")}
        title={t("sidebar.surfaceMenu")}
        data-testid={`sidebar-surface-menu-${surface.tabId}`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {onClose ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="mr-1 hidden shrink-0 rounded p-1 hover:bg-muted-foreground/(--opacity-subtle) focus-visible:outline-none group-hover:flex group-focus-within:flex"
          aria-label={t(surface.kind === "terminal" ? "sidebar.closeTerminalEnding" : "sidebar.closePage")}
          title={t(surface.kind === "terminal" ? "sidebar.closeTerminalEnding" : "sidebar.closePage")}
          data-testid={`sidebar-surface-close-${surface.tabId}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
