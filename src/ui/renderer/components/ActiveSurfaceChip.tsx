import { Globe, Terminal, X } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { clearActiveSurface, useActiveSurface, type ActiveSurface } from "../preview/active-surface.js";
import { directoryName, useGuestNavigation, useWebSurfaceGuest, webPanelTitle } from "./MainSurfacePanels.js";

/**
 * The side chat's target chip: the terminal or page the side chat acts on,
 * following what the user last brought into view (see
 * `preview/active-surface.ts`). × drops the target until another terminal or
 * page is shown. Nothing is drawn while there is no target.
 */
export function ActiveSurfaceChip() {
  const surface = useActiveSurface();
  if (!surface) return null;
  return surface.kind === "browser" ? <BrowserChip surface={surface} /> : <TerminalChip surface={surface} />;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function BrowserChip({ surface }: { surface: ActiveSurface }) {
  const navigation = useGuestNavigation(useWebSurfaceGuest(surface.tabId));
  const title = webPanelTitle(navigation, null, surface.label);
  const host = hostOf(navigation.url);
  return <Chip surface={surface} icon={<Globe className="h-3 w-3 shrink-0" aria-hidden="true" />} name={title} detail={host && host !== title ? host : null} detailTitle={navigation.url} />;
}

function TerminalChip({ surface }: { surface: ActiveSurface }) {
  const cwd = surface.cwd ?? null;
  return <Chip surface={surface} icon={<Terminal className="h-3 w-3 shrink-0" aria-hidden="true" />} name={surface.label} detail={cwd ? directoryName(cwd) : null} detailTitle={cwd} />;
}

function Chip({
  surface,
  icon,
  name,
  detail,
  detailTitle,
}: {
  surface: ActiveSurface;
  icon: React.ReactNode;
  name: string;
  detail: string | null;
  detailTitle: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-1.5 flex min-w-0" data-testid="side-chat-target">
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted/(--opacity-muted) py-0.5 pl-2 pr-0.5 text-[11px] text-foreground"
        data-surface-kind={surface.kind}
        data-tab-id={surface.tabId}
        title={t("sideChatTarget.label")}
      >
        {icon}
        <span className="min-w-0 truncate" data-testid="side-chat-target-name">{name}</span>
        {detail ? (
          <span className="min-w-0 truncate text-muted-foreground" title={detailTitle ?? undefined} data-testid="side-chat-target-detail">
            {detail}
          </span>
        ) : null}
        <button
          type="button"
          className="ml-0.5 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background/(--opacity-muted) hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          aria-label={t("sideChatTarget.remove")}
          title={t("sideChatTarget.remove")}
          data-testid="side-chat-target-remove"
          onClick={clearActiveSurface}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}
