import type { RequestedOutputCardResolution, RequestedOutputGateBinding } from "../shared/requested-output-card.js";
import type { WorkDecisionAuthority } from "../work-board/work-decision-authority.js";

export interface RequestedOutputApproval {
  readonly binding: RequestedOutputGateBinding & { readonly outputId: string };
  readonly toolName: string;
  readonly source: "plugin" | "mcp";
  readonly ownerId: string;
  readonly serviceEndpoint?: string;
  readonly projectRoot?: string;
  readonly signal: AbortSignal;
  readonly canExecute: () => boolean;
  readonly refuseDisplay: () => void;
  readonly recordWinner: (winner: WorkDecisionAuthority | undefined) => void;
}

export interface RequestedOutputPage {
  readonly id: string;
  readonly login: string;
  readonly authority: WorkDecisionAuthority;
  readonly canViewProject: (root: string | undefined) => boolean;
}

export interface RequestedOutputResolution {
  readonly by: RequestedOutputCardResolution;
  readonly expiresAt: number;
  readonly projectRoot?: string;
}
