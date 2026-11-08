import { useTranslation } from "../../../i18n/react.js";

/** Where a status dot sits. `control`: the top-right corner of the button it marks. `mark`: the top-right corner of an
 * identity mark's square (the agent status slot). `inline`: in the flow, after what it marks. */
export type StatusDotPlacement = "control" | "mark" | "inline";

const PLACEMENT_CLASS: Record<StatusDotPlacement, string> = {
  control: "pointer-events-none absolute right-0.5 top-0.5",
  // Takes the pointer even inside a slot that does not, so its tooltip shows.
  mark: "pointer-events-auto absolute -right-1 -top-1",
  inline: "",
};

/** The one dot every attention and status badge draws: one size, a ring of the surface colour, one semantic tone. What it
 * means is the caller's — the tone and the label naming it travel together. */
export function StatusDot({
  tone,
  label,
  title = label,
  testId,
  placement,
}: {
  /** A background utility on a semantic token (`bg-warning`, `bg-destructive`, ...). */
  tone: string;
  /** The state's name, read by assistive tech. */
  label: string;
  /** The tooltip; the label unless the caller has more to say (a terminal's notification text). */
  title?: string;
  testId: string;
  placement: StatusDotPlacement;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      data-testid={testId}
      className={["block h-[9px] w-[9px] shrink-0 rounded-full ring-2 ring-card", tone, PLACEMENT_CLASS[placement]]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

/** pendingAnswers decides attention ownership; this component only draws the shared warning dot. */
export function PendingAnswerDot({
  testId,
  inline = false,
  placement,
}: {
  testId: string;
  inline?: boolean;
  /** Overrides `inline`; the agent status slot passes `mark`. */
  placement?: StatusDotPlacement;
}) {
  const { t } = useTranslation();
  return (
    <StatusDot
      tone="bg-warning"
      label={t("pendingAnswerDot.label")}
      testId={testId}
      placement={placement ?? (inline ? "inline" : "control")}
    />
  );
}
