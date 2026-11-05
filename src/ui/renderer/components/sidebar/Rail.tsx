import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../components/ui/tooltip.js";
import { RAIL_CONTROL_SIZE_CLASS } from "../../../../shared/shell-geometry.js";
import { useTranslation } from "../../../../i18n/react.js";

export interface RailButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "aria-label" | "title" | "children"> {
  /** The name, shown only as the tooltip; it is also the accessible name, so it says which project the button acts in. */
  label: string;
  icon: ReactNode;
  /** The view this button shows is the current page. */
  current?: boolean;
  /** A dot or count pinned to the icon's corner. */
  badge?: ReactNode;
}

/** One square rail control. The name lives in the tooltip and `aria-label` only (case 03): the rail never shows text. */
export const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(function RailButton(
  { label, icon, current = false, badge, className, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-current={current ? "page" : undefined}
      className={[
        `relative ${RAIL_CONTROL_SIZE_CLASS} aspect-square flex shrink-0 items-center justify-center rounded-md transition-colors`,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        current ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        className ?? "",
      ].join(" ")}
      {...rest}
    >
      {current ? <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}
      <span className="relative flex h-4 w-4 items-center justify-center">{icon}{badge}</span>
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
});

export interface RailProps {
  /** The project dropdown: the trigger of `#project-menu`. */
  project: ReactNode;
  /** Open something new in the selected project: chat, web, terminal. */
  launchers: ReactNode;
  /** Places the window shows: the work board and routines, memory, and the extension group until it gets its own launcher. */
  views: ReactNode;
  /** Search and settings, pinned to the bottom. */
  footer: ReactNode;
}

/**
 * The 52px rail (case 01–03): the project dropdown, the launchers, the views, and search and settings. It stays whenever the
 * sidebar is not hidden; collapsing the sidebar folds only the list beside it (case 21).
 */
export function Rail({ project, launchers, views, footer }: RailProps) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("sidebar.railAriaLabel")}
      data-testid="sidebar-rail"
      className="ave-surface-raised flex min-h-0 w-(--shell-collapsed-rail-width) shrink-0 flex-col items-center overflow-hidden rounded-2xl bg-card py-2"
    >
      <div className="flex flex-col items-center gap-1">{project}</div>
      <div className="mt-2 flex flex-col items-center gap-1" data-testid="sidebar-rail-launchers">{launchers}</div>
      <div className="my-2 h-px w-6 shrink-0 bg-border" aria-hidden="true" />
      <div className="flex min-h-0 flex-col items-center gap-1" data-testid="sidebar-rail-views">{views}</div>
      <div className="mt-auto flex flex-col items-center gap-1 pt-2" data-testid="sidebar-rail-footer">{footer}</div>
    </nav>
  );
}
