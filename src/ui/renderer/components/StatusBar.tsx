import { chatSurface } from "./chat-surface.js";
import { useRef, useState, type AnimationEvent, type CSSProperties } from "react";
import type { PersistentItem, StatusBarSeverity, ToastItem } from "../hooks/use-status-bar.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { ArrowUpRight, EyeOff, X } from "lucide-react";
import { t } from "../../../i18n/runtime.js";
import { MarqueeText } from "./MarqueeText.js";
import { useWebSurfaceOccluder } from "../preview/use-web-surface-occluder.js";
import { requestWebSurfaceLayout } from "../preview/web-surfaces.js";

const EMOJI_FONT_STACK =
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif";
const EMOJI_STYLE = { fontFamily: EMOJI_FONT_STACK };

/** Persistent indicators stay in flow; the transient queue head floats without moving its owning surface. */
export interface StatusBarProps {
  persistent: PersistentItem[];
  /** Conversation notices float above their dock; window notices stay in the title bar slot. */
  toastPlacement?: "above" | "titlebar";
  /** The single toast currently at the front of the queue (or null). */
  visibleToast: ToastItem | null;
  /** Number of toasts queued behind the visible one. */
  pendingCount?: number;
  /** Click handler invoked when a toast that has `notification` metadata is clicked. The handler receives the full ToastItem
   * so callers can dispatch the IPC call and dismiss the toast in a single pass. */
  onToastClick?: (toast: ToastItem) => void;
  /** Every notice can be closed, and an error stays until it is, so every strip that shows notices must wire this. */
  onToastDismiss: (toast: ToastItem) => void;
  /** "Don't show again" for a `suppressible` notice. */
  onToastSuppress?: (toast: ToastItem) => void;
}

const SEVERITY_DOT: Record<StatusBarSeverity, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

const SEVERITY_TEXT: Record<StatusBarSeverity, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function StatusBar(props: StatusBarProps) {
  const hasContent = props.visibleToast !== null;

  // Presence: what the bar last showed is drawn once more, leaving, when the
  // content goes away. Derived during render (not in an effect) so the frame
  // in which the content disappears already draws the exit — an effect would
  // commit one empty frame first, a visible blink.
  const lastContentRef = useRef(props);
  if (hasContent) lastContentRef.current = props;
  const [leaving, setLeaving] = useState(false);
  const [hadContent, setHadContent] = useState(hasContent);
  if (hadContent !== hasContent) {
    setHadContent(hasContent);
    setLeaving(!hasContent);
  }
  const onAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    requestWebSurfaceLayout();
    if (leaving) setLeaving(false);
  };

  if (props.persistent.length === 0 && !hasContent && !leaving) return null;

  const { visibleToast, pendingCount = 0, onToastClick, onToastDismiss, onToastSuppress } =
    hasContent ? props : lastContentRef.current;
  const { persistent, toastPlacement = "above" } = props;
  const titlebar = toastPlacement === "titlebar";

  return (
    <TooltipProvider>
    <footer
      className="relative flex w-full min-w-0 items-center gap-3 text-dense text-muted-foreground"
      data-testid="status-bar"
    >
      {persistent.length > 0 ? (
        <div className="flex min-w-0 items-center truncate" role="status" aria-live="polite">
          {persistent.map((item, idx) => {
            const inner = item.dot === true ? (
              <>
                {item.a11yLabel !== undefined && (
                  <span className="sr-only">{item.a11yLabel}</span>
                )}
                <span
                  data-testid={`status-bar-dot-${item.id}`}
                  className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
                  aria-hidden="true"
                />
              </>
            ) : (
              <>
                {item.a11yLabel !== undefined && (
                  <span className="sr-only">{item.a11yLabel}</span>
                )}
                {item.label !== undefined && item.label.length > 0 && (
                  <span
                    data-status-bar-emoji="true"
                    style={EMOJI_STYLE}
                    className="shrink-0 leading-none"
                    aria-hidden="true"
                  >
                    {item.label}
                  </span>
                )}
                {item.value !== undefined && item.value.length > 0 && (
                  <span className={`truncate tabular-nums ${SEVERITY_TEXT[item.severity]}`}>
                    {item.value}
                  </span>
                )}
              </>
            );
            const trigger = item.onClick !== undefined ? (
              <button
                type="button"
                onClick={item.onClick}
                title={item.tooltip}
                className={`${chatSurface({ shape: "chip", elevation: "flat" })} flex items-center gap-1 truncate px-1.5 cursor-pointer hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
              >
                {inner}
              </button>
            ) : (
              <span
                className={`${chatSurface({ shape: "chip", elevation: "flat" })} flex items-center gap-1 truncate px-1.5`}
                title={item.tooltip}
              >
                {inner}
              </span>
            );
            return (
              <span
                key={item.id}
                className="flex min-w-0 items-center truncate"
              >
                {idx > 0 && (
                  <span className="px-2 opacity-30" aria-hidden="true">|</span>
                )}
                {item.tooltip !== undefined && item.tooltip.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {trigger}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="whitespace-pre-line text-left">
                      {item.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  trigger
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      {visibleToast !== null && (hasContent || leaving) ? (
        <div
          className={titlebar
            ? `pointer-events-none relative flex w-full min-w-0 justify-end ${leaving ? "ave-anim-fade-out" : "ave-anim-fade-in"}`
            : `pointer-events-none absolute inset-x-0 bottom-full z-30 mb-2 flex items-start justify-end ${leaving ? "ave-anim-notice-out" : "ave-anim-notice-in"}`}
          data-testid="status-bar-presence"
          data-leaving={leaving ? "true" : undefined}
          onAnimationEnd={onAnimationEnd}
        >
          <NoticeToast
            key={visibleToast.id}
            toast={visibleToast}
            className="pointer-events-auto"
            variant={titlebar ? "titlebar" : "standard"}
            pendingCount={pendingCount}
            onDismiss={onToastDismiss}
            {...(onToastClick ? { onOpen: onToastClick } : {})}
            {...(onToastSuppress ? { onSuppress: onToastSuppress } : {})}
          />
        </div>
      ) : null}
    </footer>
    </TooltipProvider>
  );
}

/**
 * The one transient notice, drawn wherever a notice queue shows its head (the window strip, a tile's composer dock, the side
 * chat, the settings save confirmation). Its rules live here so no surface re-derives them:
 * - it is not itself a live region: the strip's `NoticeLiveRegion` announces it, error assertive and the rest polite, and
 *   nothing moves focus;
 * - it always has a close button, and an error (sticky in the queue) stays until that button is used;
 * - a `suppressible` notice offers "Don't show again";
 * - width is capped at min(100%, 24rem) and it fades in on the fast motion step.
 */
export function NoticeToast({
  toast,
  pendingCount = 0,
  onDismiss,
  onOpen,
  onSuppress,
  wrap = false,
  variant = "standard",
  className,
}: {
  toast: ToastItem;
  /** Wrap the message instead of scrolling it on one line: for notices drawn inline in a page, where height is free. */
  wrap?: boolean;
  pendingCount?: number;
  onDismiss: (toast: ToastItem) => void;
  /** Present for notices that carry notification metadata: "Details" restores the window and opens the source. */
  onOpen?: (toast: ToastItem) => void;
  onSuppress?: (toast: ToastItem) => void;
  className?: string;
  variant?: "standard" | "titlebar";
}) {
  const titlebar = variant === "titlebar";
  const linkClass =
    "shrink-0 text-body-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const openable = toast.notification !== undefined && typeof onOpen === "function";
  const toastElementRef = useWebSurfaceOccluder(toast.id);
  return (
    <div
      ref={toastElementRef}
      data-testid="status-toast"
      data-severity={toast.severity}
      data-notice-kind={toast.kind}
      style={titlebar ? { WebkitAppRegion: "no-drag" } as CSSProperties : undefined}
      className={`${chatSurface()} ave-anim-fade-in flex min-w-0 w-full max-w-[min(100%,24rem)] text-input-bar-foreground ${titlebar ? "@container/notice h-(--chrome-control-height) items-center gap-0.5 px-1 text-dense" : "items-start gap-2 px-3 py-2 text-body-sm"}${className ? ` ${className}` : ""}`}
    >
      <span className={`${titlebar ? "h-1.5 w-1.5" : "mt-1 h-2 w-2"} shrink-0 rounded-full ${SEVERITY_DOT[toast.severity]}`} aria-hidden="true" />
      {wrap ? (
        <span className="min-w-0 flex-1 break-words text-left [overflow-wrap:anywhere]" data-testid="status-toast-message">{toast.message}</span>
      ) : (
        <MarqueeText text={toast.message} className="flex-1 text-left" data-testid="status-toast-message" />
      )}
      {openable ? (
        <button type="button" onClick={() => onOpen?.(toast)} className={`${linkClass}${titlebar ? " min-w-0 max-w-[40%]" : ""}`} aria-label={t("statusBar.toastDetailsAction")} title={t("statusBar.toastDetailsAction")}>
          {titlebar ? <>
            <ArrowUpRight className="h-3 w-3 @[12rem]/notice:hidden" aria-hidden="true" />
            <span className="hidden truncate @[12rem]/notice:block">{t("statusBar.toastDetailsAction")}</span>
          </> : t("statusBar.toastDetailsAction")}
        </button>
      ) : toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDismiss(toast);
          }}
          className={`${linkClass}${titlebar ? " min-w-0 max-w-[40%]" : ""}`}
          data-testid="status-toast-action"
          aria-label={toast.action.label}
          title={toast.action.label}
        >
          {titlebar ? <>
            <ArrowUpRight className="h-3 w-3 @[12rem]/notice:hidden" aria-hidden="true" />
            <span className="hidden truncate @[12rem]/notice:block">{toast.action.label}</span>
          </> : toast.action.label}
        </button>
      ) : null}
      {toast.suppressible && onSuppress ? (
        <button type="button" onClick={() => onSuppress(toast)} className={linkClass} data-testid="status-toast-suppress" aria-label={t("statusBar.toastSuppressAction")} title={t("statusBar.toastSuppressAction")}>
          {titlebar ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : t("statusBar.toastSuppressAction")}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onDismiss(toast)}
        className={`${titlebar ? "h-5 w-5" : "mt-[-0.125rem] h-6 w-6"} inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
        aria-label={t("statusBar.toastDismissAriaLabel")}
        data-testid="status-toast-dismiss"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {pendingCount > 0 ? (
        <Badge
          variant="outline"
          className="shrink-0 border-border bg-background/(--opacity-stronger) px-1.5 text-dense font-normal text-muted-foreground tabular-nums"
        >
          +{pendingCount}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * The strip's screen-reader voice. A live region announces changes to text it already holds; one mounted together with its
 * text, as a per-notice element is, may never be read, so the next queued notice could go unannounced. Each strip renders
 * this once, unconditionally, and only its text follows the queue head: errors through the assertive region, every other
 * severity through the polite one. The visible notice carries no live role of its own.
 */
export function NoticeLiveRegion({ toast }: { toast: ToastItem | null }) {
  const isError = toast?.severity === "error";
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-notice-live="" data-testid="notice-live-polite">
        {toast !== null && !isError ? toast.message : ""}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-notice-live="" data-testid="notice-live-assertive">
        {toast !== null && isError ? toast.message : ""}
      </div>
    </>
  );
}
