/** Keep renderer re-exports identical to their owning types so drift fails typechecking. */
import { describe, expectTypeOf, it } from "vitest";
import type {
  AppSettings,
  ApprovalChoice,
  ApprovalDecision,
  ApprovalRequest,
  RecentlyDeniedEntry,
  ExecutionMode,
  HookTrustRow,
  MemoryCaptureMode,
  ParentAdjudicationBackgroundEscalation,
  ParentAdjudicationMaxVerdict,
  ParentAdjudicationModelSource,
  PermissionRule,
  PluginContributionTrustRow,
  PluginPerfStats,
  RemoteA2AActionStatus,
} from "../types.js";
import type {
  AppSettings as HostAppSettings,
  MemoryCaptureMode as HostMemoryCaptureMode,
} from "../../../data/settings-store.js";
import type { RendererSettingsSnapshot } from "../../../ipc/domains/settings.js";
import type {
  ApprovalChoice as GateApprovalChoice,
  ApprovalDecision as GateApprovalDecision,
  ApprovalRequest as GateApprovalRequest,
} from "../../../permissions/approval-gate.js";
import type { PermissionRule as HostPermissionRule } from "../../../permissions/permission-manager.js";
import type {
  ParentAdjudicationBackgroundEscalation as HostParentAdjudicationBackgroundEscalation,
  ParentAdjudicationMaxVerdict as HostParentAdjudicationMaxVerdict,
  ParentAdjudicationModelSource as HostParentAdjudicationModelSource,
} from "../../../permissions/permission-settings-store.js";
import type { HookTrustRow as HostHookTrustRow } from "../../../hooks/hook-trust-commands.js";
import type { ScriptHookType } from "../../../hooks/script-hook-types.js";
import type { PluginPerfStats as HostPluginPerfStats } from "../../../plugins/runtime/index.js";
import type { PluginContributionTrustRow as HostPluginContributionTrustRow } from "../../../plugins/plugin-bundle-lifecycle.js";
import type { RemoteA2AActionStatus as HostRemoteA2AActionStatus } from "../../../main/remote-a2a-action-controller.js";
import type { RecentlyDeniedEntry as HostRecentlyDeniedEntry } from "../../../shared/recently-denied.js";
import type {
  RiskLevel,
  ToolCategory,
  ToolSource,
} from "../../../shared/permission-review-status.js";
import type {
  ToolCategory as ToolsToolCategory,
  ToolSource as ToolsToolSource,
} from "../../../tools/types.js";
import type { RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import type { ExecutionMode as HostExecutionMode } from "../../../shared/permission-mode.js";
import type { PermissionModeCommand } from "../../../permissions/permission-slash.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import type { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
import type { ActiveChatModel } from "../../../shared/active-chat-model.js";

describe("renderer types are the owner types", () => {
  it("AppSettings is the host settings minus the main-only a2aRemote block and the upstream proxy (own channels)", () => {
    expectTypeOf<AppSettings>().toEqualTypeOf<RendererSettingsSnapshot>();
    expectTypeOf<AppSettings>().toEqualTypeOf<
      Omit<HostAppSettings, "a2aRemote" | "upstreamProxy"> & { readonly activeChatModel: ActiveChatModel }
    >();
    expectTypeOf<"a2aRemote">().not.toMatchTypeOf<keyof AppSettings>();
    expectTypeOf<"upstreamProxy">().not.toMatchTypeOf<keyof AppSettings>();
    expectTypeOf<MemoryCaptureMode>().toEqualTypeOf<HostMemoryCaptureMode>();
  });

  it("approval and permission contracts are the gate's own types", () => {
    expectTypeOf<ApprovalRequest>().toEqualTypeOf<GateApprovalRequest>();
    expectTypeOf<ApprovalDecision>().toEqualTypeOf<GateApprovalDecision>();
    expectTypeOf<ApprovalChoice>().toEqualTypeOf<GateApprovalChoice>();
    expectTypeOf<PermissionRule>().toEqualTypeOf<HostPermissionRule>();
    expectTypeOf<ParentAdjudicationMaxVerdict>().toEqualTypeOf<HostParentAdjudicationMaxVerdict>();
    expectTypeOf<ParentAdjudicationBackgroundEscalation>().toEqualTypeOf<HostParentAdjudicationBackgroundEscalation>();
    expectTypeOf<ParentAdjudicationModelSource>().toEqualTypeOf<HostParentAdjudicationModelSource>();
  });

  it("plugin, hook and remote-A2A rows are the host row types", () => {
    expectTypeOf<PluginPerfStats>().toEqualTypeOf<HostPluginPerfStats>();
    expectTypeOf<PluginContributionTrustRow>().toEqualTypeOf<HostPluginContributionTrustRow>();
    expectTypeOf<HookTrustRow>().toEqualTypeOf<HostHookTrustRow>();
    expectTypeOf<HookTrustRow["hookType"]>().toEqualTypeOf<ScriptHookType>();
    expectTypeOf<RemoteA2AActionStatus>().toEqualTypeOf<HostRemoteA2AActionStatus>();
  });

  it("shared unions are spelled once", () => {
    expectTypeOf<ToolsToolCategory>().toEqualTypeOf<ToolCategory>();
    expectTypeOf<ToolsToolSource>().toEqualTypeOf<ToolSource>();
    expectTypeOf<RiskVerdict["level"]>().toEqualTypeOf<RiskLevel>();
    expectTypeOf<RecentlyDeniedEntry["source"]>().toEqualTypeOf<ToolSource>();
    expectTypeOf<RecentlyDeniedEntry["category"]>().toEqualTypeOf<ToolCategory>();
    expectTypeOf<RecentlyDeniedEntry>().toEqualTypeOf<HostRecentlyDeniedEntry>();
  });

  it("ExecutionMode is one union across host, slash parser and renderer", () => {
    expectTypeOf<ExecutionMode>().toEqualTypeOf<HostExecutionMode>();
    expectTypeOf<PermissionModeCommand["mode"]>().toEqualTypeOf<HostExecutionMode>();
    expectTypeOf<ExecutionMode>().toEqualTypeOf<"default" | "strict" | "auto" | "allow">();
  });

  it("TranslateFn is the signature of both t entry points", () => {
    expectTypeOf(t).toEqualTypeOf<TranslateFn>();
    expectTypeOf<ReturnType<typeof useTranslation>["t"]>().toEqualTypeOf<TranslateFn>();
  });
});
