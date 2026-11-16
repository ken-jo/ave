export type TemplateConfirmationOrigin = "local-desktop" | "tailnet-surface";
export type TemplateScope = { kind: "all" } | { kind: "project"; projectRoot: string };
type StageGate = { type: "human" } | {
  type: "auto";
  pass: { kind: "stage_ok" } | { kind: "check_exit_zero"; command: string }
    // Scheduler predicate labelled as a model judgement; never answers, skips or pre-fills a permission card (D9).
    | { kind: "model_verdict" };
};
export type RequestedOutputKind = "upload" | "send-message" | "publish-post" | "external-write" | "other";
export interface RequestedOutputDecl { kind: RequestedOutputKind; toolName: string; owner: "server" | "plugin" | "host"; ownerId: string }
export interface StageGenerationTool {
  name: string;
  effect: "generate" | "fetch";
  dataSent: boolean;
}
export interface StageEnvelope {
  tools: string[];
  writePaths: string[];
  readRoots: string[];
  network: { host: string; port?: number }[];
  commands: string[];
  mcpReadOnlyTools: string[];
  mcpGenerationTools: StageGenerationTool[];
  pluginGenerationTools: StageGenerationTool[];
  outputs: ("branch" | RequestedOutputKind)[];
  budget: { rounds: number; minutes: number; costUsd: number };
}
export type StageInputDecl = { from: "project"; paths: string[] } | { from: "stage"; stageId: string };
export interface TemplateStage {
  id: string;
  name: string;
  goal: string;
  kind?: "plan";
  inputs: string[];
  toolScope: "read" | "all";
  agentName?: string;
  allowSubAgents: boolean;
  gate: StageGate;
  envelope?: StageEnvelope;
  requestedOutputs?: RequestedOutputDecl[];
  inputFiles?: StageInputDecl[];
  outputs?: string[];
}
interface TemplateEdge { from: string; to: string }
export interface TemplateGraph { stages: TemplateStage[]; edges: TemplateEdge[]; setupCommands?: string[] }
export interface WorkflowTemplate {
  id: string;
  name: string;
  scope: TemplateScope;
  description?: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
export interface TemplateVersionPin { templateId: string; version: number; graphHash: string }
interface TemplateConfirmation extends TemplateVersionPin {
  who: string;
  at: string;
  origin: TemplateConfirmationOrigin;
}
export interface TemplateVersion extends TemplateGraph, TemplateVersionPin {
  confirmedAt: string;
  confirmation: TemplateConfirmation;
  basedOn?: number;
}
export interface WorkflowTemplateDraftInput extends TemplateGraph {
  name: string;
  scope: TemplateScope;
  description?: string;
  basedOn?: number;
}
interface WorkflowTemplateDraft extends WorkflowTemplateDraftInput {
  graphHash: string;
  revision: string;
  updatedAt: string;
}
export interface ScheduleAttachmentInput extends TemplateVersionPin { scheduleId: string }
export interface ScheduleAttachment extends ScheduleAttachmentInput {
  id: string;
  /** Approved project-registry root, canonicalized at authorization; compared exactly. */
  approvedScope: TemplateScope;
  detachedAt?: string;
  who: string;
  at: string;
  origin: TemplateConfirmationOrigin;
}
export interface WorkflowTemplateRecord {
  template: WorkflowTemplate;
  versions: TemplateVersion[];
  scheduleAttachments?: ScheduleAttachment[];
  draft?: WorkflowTemplateDraft;
}
export interface WorkflowTemplateConfirmInput { expectedGraphHash: string; expectedDraftRevision: string }
export type WorkflowTemplateErrorCode =
  | "invalid-input" | "template-not-found" | "unknown-version" | "graph-hash-mismatch"
  | "confirmed-version-immutable" | "stale-draft" | "no-draft" | "template-archived"
  | "bad-stage-id" | "too-many-entries" | "envelope-refused"
  | "scope-changed" | "project-mismatch" | "scope-not-authorised" | "output-not-declared"
  | "invalid-template-file" | "invalid-template-run" | "schedule-requires-read-only";
export type WorkflowTemplateIpcResult<T> = { ok: true; value: T } | { ok: false; refusals?: EnvelopeRefusal[]; error: WorkflowTemplateErrorCode | "unauthorized-frame" | "no-store" | "user-gesture-required" | "storage-error" };

export interface WorkItemStageRun {
  stageId: string;
  attempt: number;
  status: "waiting" | "running" | "awaiting_gate" | "passed" | "failed" | "cancelled" | "rejected";
  failure?: "error" | "gate" | "interrupted" | "denied-tool" | "workspace-lost" | "workspace-revoked" | "budget" | "seed";
  taint?: "file-content" | "agent-message";
  workspace?: { root: string; kind: "git" | "folder"; baseCommit?: string; sealCommit?: string; manifest?: OutputFile[] };
  blocked?: { code: LaneBlockCode; at: string };
  requestedOutputs?: RequestedOutput[];
  outputExecutions?: OutputExecution[];
  usage?: { rounds: number; startedAt: string; denials: number; costUsd?: number };
  childSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  /** At most 48,000 characters; the engine truncates before storing. */
  output?: string;
  resultHash?: string;
  outputHash?: string;
  gate?: { type: "human"; status: "pending" | "approved" | "changes_requested" | "rejected"; note?: string; decidedAt?: string; revision: number; judgedBy?: "host" | "model" }
    | { type: "auto"; passed: boolean; evidence: string; evaluatedAt: string; judgedBy?: "host" | "model" };
}
export type WorkItemStageRunSummary = Pick<WorkItemStageRun, "stageId" | "attempt" | "status" | "startedAt" | "endedAt" | "resultHash">;

export type EnvelopeRefusal = "tools-broader-than-scope" | "host-shell" | "floor-target" | "secret-path" | "user-owned-surface"
  | "outputs-need-human-gate" | "setup-outside-commands" | "bad-stage-id" | "too-many-entries";
type RunPin = TemplateVersionPin;
export type RunAuthoritySource = { kind: "local-create-and-run"; pin: RunPin; projectRoot?: string }
  | { kind: "schedule-attachment"; attachmentId: string; pin: RunPin; firedAt: string };
export interface RunWorkspace { kind: "git" | "folder"; runRoot: string; branch?: string; baseCommit?: string; outputDir?: string }
type LaneBlockCode = "envelope-missing" | "isolation-unproven" | "lane-unavailable";
interface OutputFile { path: string; sha256: string; size: number }
export interface RequestedOutput { id: string; decl: RequestedOutputDecl; args: string; files?: OutputFile[]; summary: string }
interface OutputExecution { id: string; status: "pending" | "done" | "failed" | "denied"; at?: string; detail?: string }
interface JoinConflict { conflictHash: string; reason: "merge-conflict" | "same-path" | "identity-missing" | "interrupted"; files: { path: string; stageIds: string[] }[]; excerpt?: string }
export interface StageJoin { joinId: string; stageIds: string[]; status: "integrating" | "integrated" | "conflict" | "rejected"; conflict?: JoinConflict; decidedAt?: string }
export interface TemplateRunStart extends RunPin { source: RunAuthoritySource; stageRuns: WorkItemStageRun[] }
/** Template-run state. It is stored only in the covered run file, keyed by runId; a board row names its run by runId alone. */
export interface WorkflowRunRecord {
  runId: string;
  /** The board row this run belongs to. A row naming another row's run is refused. */
  itemId: number;
  pin: TemplateVersionPin;
  runStartedBy: RunAuthoritySource;
  startedAt: string;
  stageRuns: WorkItemStageRun[];
  stageJoins?: StageJoin[];
  runWorkspace?: RunWorkspace;
}
/** invalid: the stored entry is unreadable and stays untouched. pending-review: the run file awaits home content review. */
export type WorkflowRunReadResult = { status: "found"; run: WorkflowRunRecord } | { status: "not-found" | "invalid" | "pending-review" };
export type WorkflowRunWriteResult = { status: "stored"; run: WorkflowRunRecord } | { status: "not-found" | "invalid" | "pending-review" | "refused" };
