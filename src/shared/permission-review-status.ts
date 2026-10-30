/** Host review progress and outcomes displayed in the transcript. */
export type PermissionReviewStatus =
  | "reviewing"
  | "needs_approval"
  | "auto_approved"
  | "failed";

/** Tool origin determines the source-to-trust mapping in permission-policy-design.md. */
export type ToolSource = "builtin" | "plugin" | "mcp";

/** Permission categories follow permission-policy-design.md: reads are scope-checked, writes ask, shells add AST validation, networks add endpoint checks, and meta calls delegate to ToolDecisionOverride. */
export type ToolCategory = "read" | "write" | "shell" | "network" | "meta";

/** Reviewer verdicts are discrete levels, never scalar scores. */
export type RiskLevel = "low" | "medium" | "high";

export type ApprovalPurposeSuggestion = {
  text: string;
  source: "conversation" | "tool-input";
  confidence: "sufficient" | "insufficient";
};

/** Use one coarse-identifier grammar at every remote boundary; whitespace, controls, arguments, and paths must not pass. */
const SHARED_APPROVAL_TOOL_IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function isSharedApprovalToolIdentifier(value: unknown): value is string {
  return typeof value === "string" && SHARED_APPROVAL_TOOL_IDENTIFIER.test(value);
}

export type PermissionReviewEvent = {
  status: PermissionReviewStatus;
  toolName: string;
  toolCategory?: ToolCategory;
  source?: ToolSource;
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  verdictLevel?: RiskLevel;
  reason?: string;
  approvalPurpose?: ApprovalPurposeSuggestion;
};
