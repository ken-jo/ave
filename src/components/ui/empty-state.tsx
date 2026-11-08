import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button.js";
import { cn } from "../../lib/utils.js";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** A 14px glyph drawn before the label. */
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

/**
 * The one empty (and idle-state) message. It states what is empty, not how the feature works (DESIGN.md, Interaction
 * states), and its hierarchy is fixed here so surfaces stop inventing their own:
 * - one line (`title` only) reads as quiet muted `text-dense`, the same step as the secondary line;
 * - two lines read as a title (body-sm, medium) over a muted secondary line (dense), a small gap apart;
 * - at most one primary button (`action`); every other action is a link (`links`).
 * `icon` is a muted mark above the text, for surfaces that draw one (a folder column, a panel landing).
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  links,
  align = "start",
  className,
  ...rest
}: Omit<ComponentProps<"div">, "title" | "children"> & {
  title: string;
  description?: string | undefined;
  icon?: ReactNode;
  action?: EmptyStateAction | undefined;
  links?: readonly EmptyStateAction[] | undefined;
  align?: "start" | "center";
}) {
  const twoLine = description !== undefined && description.length > 0;
  const hasActions = action !== undefined || (links?.length ?? 0) > 0;
  return (
    <div
      data-empty-state=""
      className={cn(
        "flex min-w-0 flex-col p-4",
        align === "center" ? "items-center justify-center text-center" : "items-start text-left",
        className,
      )}
      {...rest}
    >
      {icon ? <div className="mb-2 flex text-muted-foreground" aria-hidden="true">{icon}</div> : null}
      {twoLine ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-body-sm font-medium text-foreground" data-empty-state-title="">{title}</div>
          <div className="text-dense text-muted-foreground" data-empty-state-description="">{description}</div>
        </div>
      ) : (
        <div className="text-dense text-muted-foreground" data-empty-state-title="">{title}</div>
      )}
      {hasActions ? (
        <div className={cn("mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5", align === "center" && "justify-center")}>
          {action ? (
            <Button type="button" size="sm" className="gap-1" onClick={action.onClick} disabled={action.disabled} data-testid={action.testId}>
              {action.icon}
              {action.label}
            </Button>
          ) : null}
          {links?.map((link) => (
            <Button
              key={link.label}
              type="button"
              variant="link"
              className="h-auto gap-1 p-0 text-dense"
              onClick={link.onClick}
              disabled={link.disabled}
              data-testid={link.testId}
            >
              {link.icon}
              {link.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
