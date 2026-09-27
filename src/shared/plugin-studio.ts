import type { AgentPluginComponents } from "../marketplace/catalog/types.js";
import type { McpServerConfigDto } from "../mcp/types.js";

export type StudioOrigin =
  | { kind: "copied"; from: { kind: string; name: string; version?: string } }
  | { kind: "user-store"; path: string }
  | { kind: "conversation"; sessionId: string }
  | { kind: "typed" };

export interface StudioPart { path: string; origin: StudioOrigin }
export interface StudioDiagnostic {
  group: "lost" | "rewritten" | "needs-input";
  path: string;
  message: string;
}
export interface StudioLintFinding { path: string; matched: string; message: string }
export interface StudioDraft {
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  parts: StudioPart[];
  reviewed?: { treeDigest: string; at: string };
  writeState?: "pending";
  sharedAt?: string;
  diagnostics: StudioDiagnostic[];
  pendingHooks: Array<{ event: string; matcher?: string; command: string[]; timeoutMs?: number; needsAdaptation: true }>;
  connectorCopies?: StudioConnectorCopy[];
}
interface StudioConnectorCopy {
  serverId: string;
  specDigest?: string;
  confirmedArgs: Record<string, string>;
  confirmedEnv: Record<string, string>;
  argsCount: number;
  envCount: number;
}
export interface StudioConnectorStatus {
  serverId: string;
  argsCount: number;
  envCount: number;
  confirmedArgs: number;
  confirmedEnv: number;
  status: "needs-confirmation" | "confirmed" | "stale";
}
export interface StudioConnectorCopyPreview {
  serverId: string;
  spec: McpServerConfigDto;
  specDigest: string;
  args: Array<{ index: number; value: string; digest: string; warning?: string }>;
  env: Array<{ name: string; value: string; digest: string; warning?: string }>;
}
export interface StudioConnectorConfirmation {
  specDigest: string;
  args: Array<{ index: number; digest: string }>;
  env: Array<{ name: string; digest: string }>;
}
export interface StudioDraftView {
  draft: StudioDraft;
  files: Array<{ path: string; text: string | null }>;
  treeDigest: string;
  reviewStatus: "reviewed" | "needs-review";
  diagnostics: StudioDiagnostic[];
  lint: StudioLintFinding[];
  components: AgentPluginComponents | null;
  errors: string[];
  connectorStatuses: StudioConnectorStatus[];
}
export interface StudioWriteRequest {
  name: string;
  version?: string;
  description?: string;
  files?: Array<{ path: string; text: string }>;
  removePaths?: string[];
  references?: Array<{ kind: "skill" | "routine" | "prompt" | "agent" | "connector"; name: string }>;
  adaptedHooks?: Array<{ index: number; command: string[] }>;
}
export interface StudioAvailableParts {
  skills: Array<{ name: string; description: string }>;
  routines: Array<{ name: string; description: string }>;
  connectors: Array<{ name: string; description: string }>;
  prompts: Array<{ name: string; description: string }>;
  agents: Array<{ name: string; description: string }>;
}
export interface StudioLocalPreview {
  previewId: string;
  name: string;
  version: string;
  description: string;
  files: Array<{ path: string; text: string | null }>;
  components: AgentPluginComponents;
  treeDigest: string;
  expiresAt: string;
}
export type StudioErrorCode = "invalid-request" | "unavailable" | "connector-changed";
export type StudioResult<T> = { ok: true; value: T } | { ok: false; code: StudioErrorCode; message: string };
export function parseStudioResult<T>(value: unknown): StudioResult<T> {
  if (value && typeof value === "object" && "ok" in value) {
    const result = value as StudioResult<T>;
    if (result.ok === true && "value" in result) return result;
    if (result.ok === false && (["invalid-request", "unavailable", "connector-changed"] as const).includes(result.code) && typeof result.message === "string") return result;
  }
  return { ok: false, code: "unavailable", message: "Studio returned an invalid response" };
}
export interface PluginStudioApi {
  availableParts(): Promise<StudioResult<StudioAvailableParts>>;
  listDrafts(): Promise<StudioResult<StudioDraft[]>>;
  readDraft(name: string): Promise<StudioResult<StudioDraftView>>;
  writeDraft(request: StudioWriteRequest): Promise<StudioResult<StudioDraftView>>;
  validateDraft(name: string): Promise<StudioResult<StudioDraftView>>;
  connectorCopyPreview(serverId: string): Promise<StudioResult<StudioConnectorCopyPreview>>;
  confirmConnectorCopy(name: string, serverId: string, confirmation: StudioConnectorConfirmation): Promise<StudioResult<StudioDraftView>>;
  importPackage(): Promise<StudioResult<StudioDraftView | null>>;
  reviewDraft(name: string, treeDigest: string): Promise<StudioResult<StudioDraftView>>;
  exportDraft(name: string, projection: boolean): Promise<StudioResult<string | null>>;
  exportToCheckout(name: string): Promise<StudioResult<{ path: string; steps: string[] } | null>>;
  previewInstallFromFile(): Promise<StudioResult<StudioLocalPreview | null>>;
  previewInstallDraft(name: string): Promise<StudioResult<StudioLocalPreview>>;
  installFromFile(previewId: string, approvedMcpServers: Array<{ name: string; digest: string }>): Promise<StudioResult<{ name: string; version: string; sourceId: null }>>;
}
