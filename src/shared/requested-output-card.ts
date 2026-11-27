export interface RequestedOutputGateBinding {
  readonly itemId: number;
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly resultHash: string;
  readonly outputHash: string;
}

export interface RequestedOutputCardContent {
  readonly toolName: string;
  readonly ownerId: string;
  readonly argsText: string;
  readonly target?: string;
  readonly canonicalTarget?: string;
  readonly serviceEndpoint?: string;
}

export type RequestedOutputCardChoice = "allow-once" | "deny-once";
export type RequestedOutputCardResolution = "desk" | "tailnet-surface" | "expired";

export type RequestedOutputCardView = { requestId: string } & (
  | { content: RequestedOutputCardContent; handle: string }
  | { resolvedBy: RequestedOutputCardResolution }
);
