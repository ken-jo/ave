import { join } from "node:path";
import {
  DurableRationaleAuditAdapter,
  type DurableRationaleAuditAdapterOptions,
  type RationaleAuditSink,
} from "../../audit/rationale-audit-adapter.js";
import { createLogger } from "../../lib/logger.js";
import { getSandboxGeneration } from "../../permissions/sandbox-capability.js";
import { aveHome } from "../../shared/ave-home.js";
import { FOREGROUND_RATIONALE_PRODUCTION_ENABLED } from "../../tools/pipeline/rationale-control.js";
import {
  RationaleHostService,
  type RationaleHostServiceOptions,
} from "../../tools/pipeline/rationale-host-service.js";
import {
  DurableHostInvocationStartCasStore,
  type DurableHostInvocationStartCasStoreOptions,
  type InvocationCrashRecoveryResult,
  type RecoveryInvocationAuditSink,
} from "../../tools/pipeline/rationale-invocation-journal.js";
import type { HostInvocationStartCas } from "../../tools/pipeline/rationale-ticket-lifecycle.js";
import type { BootContext } from "../context.js";

const log = createLogger("ave");

interface RecoverableInvocationStartCas extends HostInvocationStartCas {
  recoverAfterCrash(input: {
    persistAudit: RecoveryInvocationAuditSink;
    now?: number;
  }): Promise<InvocationCrashRecoveryResult>;
}

export interface RationaleHostWiringOverrides {
  readonly productionEnabled?: boolean;
  readonly createAuditSink?: (
    options: DurableRationaleAuditAdapterOptions,
  ) => RationaleAuditSink;
  readonly createInvocationJournal?: (
    options: DurableHostInvocationStartCasStoreOptions,
  ) => RecoverableInvocationStartCas;
  readonly createHostService?: (
    options: RationaleHostServiceOptions,
  ) => RationaleHostService;
}

/** Publish guarded authority only after audit preflight and recovery; resolve the reviewer at invocation. */
export async function wireRationaleHost(
  ctx: BootContext,
  overrides: RationaleHostWiringOverrides = {},
): Promise<void> {
  ctx.rationaleHostService = undefined;
  const productionEnabled =
    overrides.productionEnabled ?? FOREGROUND_RATIONALE_PRODUCTION_ENABLED;

  try {
    const auditSecret = ctx.bootAuditLogger.getPermissionAuditSecret();
    const sealStore = ctx.bootAuditLogger.getPermissionAuditSealStore();
    if (auditSecret === null || sealStore === null) {
      throw new Error("rationale audit authority is unavailable");
    }

    const auditOptions: DurableRationaleAuditAdapterOptions = {
      auditDir: ctx.bootAuditLogger.getAuditDir(),
      auditSecret,
      sealStore,
    };
    const auditSink =
      overrides.createAuditSink?.(auditOptions) ??
      new DurableRationaleAuditAdapter(auditOptions);

    const journalOptions: DurableHostInvocationStartCasStoreOptions = {
      filePath: join(aveHome(), "rationale", "invocation-journal-v1.json"),
      auditSecret,
      sealStore,
    };
    const invocationStartCas =
      overrides.createInvocationJournal?.(journalOptions) ??
      new DurableHostInvocationStartCasStore(journalOptions);

    if (productionEnabled) {
      auditSink.assertWritable();
      await invocationStartCas.recoverAfterCrash({
        persistAudit: (sessionId, record) => {
          auditSink.appendInvocation(sessionId, record);
        },
      });
    }

    const serviceOptions: RationaleHostServiceOptions = {
      approvalGate: ctx.approvalGate,
      onReviewerChoiceResolved: (sessionId, requestId, decision) =>
        ctx.permissionManager.resolveReviewerChoice(sessionId, requestId, decision),
      getRationaleScopeReviewer: () => ctx.rationaleScopeReviewer,
      getRegistryGeneration: () => ctx.toolRegistry.getGeneration(),
      getSandboxGeneration,
      invocationStartCas,
      auditSink,
    };
    const service =
      overrides.createHostService?.(serviceOptions) ??
      new RationaleHostService(serviceOptions);

    // Publish only fully recovered services.
    ctx.rationaleHostService = service;
  } catch {
    // Hide raw errors and paths; unavailable authority retains legacy batching and sandbox gaps force prompting.
    ctx.rationaleHostService = undefined;
    log.warn(
      "boot: foreground rationale authority unavailable; force-prompt one-shot sandbox permit fallback remains active",
    );
  }
}
