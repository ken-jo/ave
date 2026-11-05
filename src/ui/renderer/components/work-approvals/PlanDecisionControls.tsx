// The work approval of a stored plan (permission-decision-tree.md "Work approvals"): approve and run, send back with a note, or reject.
// It is the user's own decision on the item, not a tool-approval card, so it waits without a timeout and survives a restart. The buttons
// send the run id and the stored plan hash, never the plan text. Used by the 확인 필요 plan card and by the work item's detail.
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2 } from "lucide-react";
import { t } from "../../../../i18n/runtime.js";
import { Button } from "../../../../components/ui/button.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { MARKDOWN_REMARK_PLUGINS } from "../../utils/markdown-plugins.js";
import { MARKDOWN_SAFE_COMPONENTS, markdownUrlTransform } from "../../utils/markdown-safe.js";
import type { AveApi } from "../../types.js";
import { MAX_PLAN_NOTE_LENGTH, type WorkPlanDecideIpcResult, type WorkPlanDecision } from "../../../../shared/work-board-types.js";
import { formatIpcError } from "../../format-ipc-error.js";

type PlanDecisionRefusal = Extract<WorkPlanDecideIpcResult, { ok: false }>["reason"];

/** Refusals after which there is nothing left to decide: the item or its pending plan is gone. */
const GONE_REFUSALS: ReadonlySet<string> = new Set(["not_found", "not_pending", "plan_mismatch"]);

/** The user-facing sentence for each refusal; a stale plan names the way forward (send it back for changes). */
function planDecisionRefusalText(reason: PlanDecisionRefusal | string): string {
  switch (reason) {
    case "plan_stale":
      return t("workBoard.planDecisionStale");
    case "not_pending":
    case "plan_mismatch":
      return t("workBoard.planDecisionNotPending");
    case "note_required":
      return t("workBoard.planDecisionNoteRequired");
    case "note_too_long":
      return t("workBoard.planDecisionNoteTooLong", { max: MAX_PLAN_NOTE_LENGTH });
    case "note_invalid":
      return t("workBoard.planDecisionNoteInvalid");
    case "already_running":
      return t("workBoard.planDecisionBusy");
    case "plan_settling":
      return t("workBoard.planDecisionSettling");
    case "not_found":
      return t("workBoard.planDecisionItemGone");
    default:
      return formatIpcError(reason, undefined);
  }
}

export interface PlanSections {
  summary: string;
  steps: string;
  changes: string;
  risks: string;
}

const SECTION_ORDER: ReadonlyArray<keyof PlanSections> = ["summary", "steps", "changes", "risks"];
const SECTION_HEADING = /^##\s+(summary|steps|changes|risks)\s*:?\s*$/i;
const FENCE = /^(`{3,}|~{3,})/;

/** The plan prompt asks for four `##` headings in this order: Summary, Steps, Changes, Risks. A plan that has exactly those, in that
 * order, outside code fences, is split for display; any other plan is shown whole, so text the model wrote inside a code block cannot
 * pose as a section. Text before the first heading belongs to the summary. Display only: the decision binds to the whole plan. */
export function splitPlanSections(plan: string): PlanSections | null {
  const bodies: string[][] = [];
  const preamble: string[] = [];
  let fence: string | null = null;
  for (const line of plan.split("\n")) {
    const trimmed = line.trim();
    const marker = FENCE.exec(trimmed)?.[1];
    if (fence !== null) {
      // A fence closes on the same character, at least as long as it opened.
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = null;
    } else if (marker !== undefined) {
      fence = marker;
    } else {
      const heading = SECTION_HEADING.exec(trimmed);
      if (heading) {
        if (heading[1]!.toLowerCase() !== SECTION_ORDER[bodies.length]) return null;
        bodies.push([]);
        continue;
      }
    }
    (bodies.at(-1) ?? preamble).push(line);
  }
  if (fence !== null || bodies.length !== SECTION_ORDER.length) return null;
  const text = (index: number) => bodies[index]!.join("\n").trim();
  const lead = preamble.filter((line) => line.trim().length > 0);
  const summary = [...lead, text(0)].filter((part) => part.length > 0).join("\n");
  return { summary, steps: text(1), changes: text(2), risks: text(3) };
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm ave-prose max-w-none break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} urlTransform={markdownUrlTransform} components={MARKDOWN_SAFE_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** The agent's plan, split by its four headings when it has them. The risk section is the agent's own rating, never a host risk level. */
export function PlanText({ plan, testIdPrefix }: { plan: string; testIdPrefix: string }) {
  const sections = splitPlanSections(plan);
  if (sections === null) return <Markdown text={plan} />;
  const rows: Array<{ id: keyof PlanSections; label: string }> = [
    { id: "summary", label: t("workApprovals.planSectionSummary") },
    { id: "steps", label: t("workApprovals.planSectionSteps") },
    { id: "changes", label: t("workApprovals.planSectionChanges") },
    { id: "risks", label: t("workApprovals.planSectionRisks") },
  ];
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} data-testid={`${testIdPrefix}-section-${row.id}`}>
          <h5 className="text-[11px] font-semibold text-muted-foreground">{row.label}</h5>
          <Markdown text={sections[row.id]} />
        </div>
      ))}
    </div>
  );
}

export interface PlanDecisionControlsProps {
  api: Pick<AveApi, "decideWorkPlan">;
  itemId: number;
  runId: string;
  planHash: string;
  /** The item changed after planning: approve is refused, so 수정 요청 leads. */
  stale: boolean;
  /** The decision was stored. */
  onDecided: () => void;
  /** The plan is gone (deleted, or decided elsewhere); the caller re-reads. */
  onGone: () => void;
  /** Test ids are `<prefix>-approve`, `<prefix>-note`, … so two surfaces can show the same plan. */
  testIdPrefix: string;
}

const PENDING_LABEL: Record<WorkPlanDecision, string> = {
  approve: "workApprovals.planApproving",
  reject: "workApprovals.planRejecting",
  request_changes: "workApprovals.planSendingBack",
};

export function PlanDecisionControls({ api, itemId, runId, planHash, stale, onDecided, onGone, testIdPrefix: p }: PlanDecisionControlsProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<WorkPlanDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteMissing, setNoteMissing] = useState(false);
  const [gone, setGone] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const approveRef = useRef<HTMLButtonElement | null>(null);

  const decide = async (decision: WorkPlanDecision) => {
    const trimmed = note.trim();
    // A change request needs to say what to change; caught here, before anything is sent.
    if (decision === "request_changes" && trimmed.length === 0) {
      setNoteMissing(true);
      setError(t("workApprovals.planNoteRequired"));
      noteRef.current?.focus();
      return;
    }
    if (decision === "approve" && stale) return;
    setPending(decision);
    setError(null);
    try {
      const result = await api.decideWorkPlan(itemId, {
        runId,
        planHash,
        decision,
        ...(trimmed.length > 0 ? { note: trimmed } : {}),
      });
      if ("ok" in result && result.ok) {
        setNote("");
        onDecided();
        return;
      }
      const reason = "reason" in result ? result.reason : result.error;
      setGone(GONE_REFUSALS.has(reason));
      setError(planDecisionRefusalText(reason));
    } catch {
      // The decision did not reach the store, so nothing ran; the note stays for the retry.
      setError(t("workApprovals.planSaveFailed"));
      requestAnimationFrame(() => approveRef.current?.focus());
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const label = (decision: WorkPlanDecision, idle: string) => (pending === decision ? t(PENDING_LABEL[decision]) : idle);
  const spinner = (decision: WorkPlanDecision) =>
    pending === decision ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null;

  if (gone) {
    return (
      <div className="space-y-2" data-testid={`${p}-gone`}>
        <p role="alert" className="rounded-md border border-destructive/(--opacity-medium) p-2 text-[11px] text-destructive" data-testid={`${p}-decision-error`}>
          {error} {t("workApprovals.planNothingRan")}
        </p>
        <div className="flex justify-end">
          <Button size="sm" autoFocus onClick={onGone} data-testid={`${p}-clear`}>
            {t("workApprovals.planClear")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {stale && (
        <p role="status" className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) p-2 text-[11px]" data-testid={`${p}-stale`}>
          {t("workBoard.planDecisionStale")}
        </p>
      )}
      <Textarea
        ref={noteRef}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          if (noteMissing && event.target.value.trim().length > 0) {
            setNoteMissing(false);
            setError(null);
          }
        }}
        maxLength={MAX_PLAN_NOTE_LENGTH}
        placeholder={t("workBoard.planDecisionNotePlaceholder")}
        aria-label={t("workBoard.planDecisionNoteLabel")}
        aria-invalid={noteMissing ? true : undefined}
        className={noteMissing ? "border-destructive" : undefined}
        disabled={busy}
        rows={2}
        data-testid={`${p}-note`}
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{t("workApprovals.planNoteHelper")}</span>
        <span className="shrink-0 tabular-nums" data-testid={`${p}-note-count`}>{note.length} / {MAX_PLAN_NOTE_LENGTH}</span>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide("reject")} data-testid={`${p}-reject`}>
          {spinner("reject")}
          {label("reject", t("workBoard.planDecisionReject"))}
        </Button>
        <Button
          variant={stale ? "default" : "outline"}
          size="sm"
          disabled={busy}
          autoFocus={stale}
          onClick={() => void decide("request_changes")}
          data-testid={`${p}-request-changes`}
        >
          {spinner("request_changes")}
          {label("request_changes", t("workBoard.planDecisionRequestChanges"))}
        </Button>
        <Button
          ref={approveRef}
          variant={stale ? "outline" : "default"}
          size="sm"
          disabled={busy}
          aria-disabled={stale ? true : undefined}
          className={stale ? "opacity-(--opacity-disabled) cursor-not-allowed" : undefined}
          title={stale ? t("workBoard.planDecisionStale") : undefined}
          onClick={() => void decide("approve")}
          data-testid={`${p}-approve`}
        >
          {spinner("approve")}
          {label("approve", t("workBoard.planDecisionApprove"))}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-[11px] text-destructive" data-testid={`${p}-decision-error`}>{error}</p>
      )}
    </div>
  );
}
