import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { cn } from "../../../lib/utils.js";
import { PendingAnswerDot, StatusDot } from "./PendingAnswerDot.js";

/**
 * The states that need a person, each drawn as a corner badge on the mark. Idle and done draw no badge, and working is not
 * a badge: it replaces the mark (see DESIGN.md, "Agent status slot").
 */
export type AgentStatusBadge = "waiting" | "blocked" | "error" | "connecting" | "exited";

/** One semantic token per meaning. `waiting` is the pending-answer dot itself, so it is not in this table. */
const BADGE_STYLE: Record<Exclude<AgentStatusBadge, "waiting">, { tone: string; labelKey: string }> = {
  blocked: { tone: "bg-destructive", labelKey: "agentStatus.blocked" },
  error: { tone: "bg-destructive", labelKey: "agentStatus.error" },
  connecting: { tone: "bg-info", labelKey: "agentStatus.connecting" },
  exited: { tone: "bg-muted-foreground", labelKey: "agentStatus.exited" },
};

const SIZE_CLASS = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
} as const;

export type AgentStatusSize = keyof typeof SIZE_CLASS;

/** The name of what the slot shows, for a surface that carries it in its own accessible name: working, then the badge. */
export function agentStatusLabels(
  t: (key: string) => string,
  working: boolean,
  badge: AgentStatusBadge | null,
): string[] {
  const labels: string[] = [];
  if (working) labels.push(t("agentStatus.working"));
  if (badge === "waiting") labels.push(t("pendingAnswerDot.label"));
  else if (badge !== null) labels.push(t(BADGE_STYLE[badge].labelKey));
  return labels;
}

/** The loader drawn for "working". The one place the spinner is chosen, so moving to the shared loader is this line. It
 * stands still under reduced motion; the slot's label carries the state then. */
export function WorkingLoader({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn("animate-spin motion-reduce:animate-none", className)} />;
}

/**
 * The agent status slot: a fixed square holding a conversation's or agent's identity mark. Working draws the loader in the
 * mark's place; a state that needs a person adds one corner badge. Both inputs are independent — a conversation can be
 * running while one of its chats waits on a card.
 */
export function AgentStatusGlyph({
  mark,
  working,
  badge,
  size = "sm",
  testId,
  workingTestId,
  badgeTestId,
  markClassName,
  className,
  hiddenFromAccessibility = false,
}: {
  /** The identity mark drawn while not working. The caller owns its accessibility (decorative or named). */
  mark: ReactNode;
  working: boolean;
  badge: AgentStatusBadge | null;
  size?: AgentStatusSize;
  testId?: string;
  workingTestId?: string;
  badgeTestId?: string;
  /** Applied to what fills the square (the mark or the loader), not to the badge — a row can hide its mark under a hover
   * control while the badge stays readable. */
  markClassName?: string;
  className?: string;
  /** The surface names the state in its own accessible name (a sidebar row's button), so the slot would only repeat it. The
   * tooltips stay. */
  hiddenFromAccessibility?: boolean;
}) {
  const { t } = useTranslation();
  const square = SIZE_CLASS[size];
  return (
    <span
      className={cn("relative flex shrink-0 items-center justify-center", square, className)}
      data-testid={testId}
      data-agent-status={working ? "working" : "idle"}
      data-agent-badge={badge ?? undefined}
      aria-hidden={hiddenFromAccessibility ? "true" : undefined}
    >
      {working ? (
        <span
          role="img"
          aria-label={t("agentStatus.working")}
          title={t("agentStatus.working")}
          data-testid={workingTestId}
          className={cn("flex items-center justify-center", square, markClassName)}
        >
          <WorkingLoader className={square} />
        </span>
      ) : markClassName ? (
        <span className={cn("flex items-center justify-center", square, markClassName)}>{mark}</span>
      ) : (
        mark
      )}
      {badge === null ? null : badge === "waiting" ? (
        <PendingAnswerDot placement="mark" testId={badgeTestId ?? `${testId ?? "agent-status"}-badge`} />
      ) : (
        <StatusDot
          tone={BADGE_STYLE[badge].tone}
          label={t(BADGE_STYLE[badge].labelKey)}
          testId={badgeTestId ?? `${testId ?? "agent-status"}-badge`}
          placement="mark"
        />
      )}
    </span>
  );
}
