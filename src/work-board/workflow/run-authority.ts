import type {
  EnvelopeToolRef, RunAuthoritySource, ScheduleAttachment, TemplateScope, TemplateVersion, UnattendedQualification, WorkflowTemplate,
} from "../../shared/workflow-template-types.js";
import { attachmentScopeMatches } from "../template-graph.js";
import type { RunPin } from "./shipped-shapes.js";

/** Decided by the source kind, never by whether a window is open. */
type RunLane = "attended" | "unattended";
export type RunAuthorityVerdict =
  | { ok: true; source: RunAuthoritySource["kind"]; lane: RunLane }
  | { ok: false; code: "source-not-authorised" | "pin-mismatch" | "not-current-version" | "template-archived" | "version-missing"
      | "graph-mismatch" | "attachment-missing" | "attachment-detached" | "scope-changed" | "scope-not-authorised" | "project-mismatch" | "unattended-not-read-only" }
  | { ok: false; code: "outward-effect-tool" | "tool-effect-unknown"; tool: EnvelopeToolRef };

export interface AuthoriseRunSourceArgs {
  /** `start` names a version to run; `spawn` rechecks a run that is already pinned to one. */
  phase: "start" | "spawn";
  source: RunAuthoritySource;
  runPin: RunPin;
  /** null when the template is gone. */
  template: WorkflowTemplate | null;
  /** The stored version the pin names; null when it does not exist. */
  stored: TemplateVersion | null;
  /** false when the stored content no longer hashes to the pin. */
  storedHashMatches: boolean;
  attachment: ScheduleAttachment | null;
  /** The project the run would use: the item's for Create and run, the snapshot's for a schedule. */
  runProjectRoot: string | undefined;
  /** Applied to the scope the approval bound, never to the template's live scope. */
  scopeAuthorised: (scope: TemplateScope) => boolean;
  unattendedAllowed: (version: TemplateVersion) => UnattendedQualification;
}
export type AuthoriseRunSource = (a: AuthoriseRunSourceArgs) => RunAuthorityVerdict;

const samePin = (a: RunPin, b: RunPin): boolean => a.templateId === b.templateId && a.version === b.version && a.graphHash === b.graphHash;
const refuse = <C extends string>(code: C): { ok: false; code: C } => ({ ok: false, code });

/** The one host function that says which sources may create a run's stage children. Called at start and before every spawn. */
export const authoriseRunSource: AuthoriseRunSource = (a) => {
  const kind: unknown = (a.source as { kind?: unknown } | null)?.kind;
  if (kind !== "local-create-and-run" && kind !== "schedule-attachment") return refuse("source-not-authorised");
  const source = a.source;
  if (!samePin(source.pin, a.runPin)) return refuse("pin-mismatch");
  if (!a.storedHashMatches) return refuse("graph-mismatch");
  if (!a.template || !a.stored) return refuse("version-missing");
  if (!samePin(a.stored, a.runPin)) return refuse("graph-mismatch");

  if (source.kind === "local-create-and-run") {
    if (a.template.archivedAt !== undefined) return refuse("template-archived");
    // Which version Create and run may name is a start rule: a run keeps its pinned version when a newer one is confirmed meanwhile.
    if (a.phase === "start" && a.template.currentVersion !== a.runPin.version) return refuse("not-current-version");
    if (source.projectRoot !== a.runProjectRoot) return refuse("project-mismatch");
    const bound: TemplateScope = source.projectRoot === undefined ? { kind: "all" } : { kind: "project", projectRoot: source.projectRoot };
    if (!a.scopeAuthorised(bound)) return refuse("scope-not-authorised");
    return { ok: true, source: source.kind, lane: "attended" };
  }

  const attachment = a.attachment;
  if (!attachment || attachment.id !== source.attachmentId) return refuse("attachment-missing");
  if (attachment.detachedAt !== undefined) return refuse("attachment-detached");
  if (!samePin(attachment, a.runPin)) return refuse("pin-mismatch");
  const scope = attachmentScopeMatches(attachment, a.template);
  if (!scope.ok) return refuse(scope.code);
  const approved = attachment.approvedScope;
  if ((approved.kind === "project" ? approved.projectRoot : undefined) !== a.runProjectRoot) return refuse("project-mismatch");
  if (!a.scopeAuthorised(approved)) return refuse("scope-not-authorised");
  const qualification = a.unattendedAllowed(a.stored);
  if (!qualification.ok) return qualification;
  return { ok: true, source: source.kind, lane: "unattended" };
};
