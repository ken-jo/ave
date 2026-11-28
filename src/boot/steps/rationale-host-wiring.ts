import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { logPermissionEvent } from "../../lib/permission-log.js";
import { SafeStorageSecretStore } from "../../lib/protected-secret-store.js";
import { withFileLock } from "../../lib/with-file-lock.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { getSandboxGeneration } from "../../permissions/sandbox-capability.js";
import { FOREGROUND_RATIONALE_PRODUCTION_ENABLED } from "../../tools/pipeline/rationale-control.js";
import {
  RationaleHostService,
  type RationaleHostServiceOptions,
} from "../../tools/pipeline/rationale-host-service.js";
import {
  DurableHostInvocationStartCasStore,
  type DurableHostInvocationStartCasStoreOptions,
  type InvocationCrashRecoveryResult,
} from "../../tools/pipeline/rationale-invocation-journal.js";
import type { HostInvocationStartCas } from "../../tools/pipeline/rationale-ticket-lifecycle.js";
import type { BootContext } from "../context.js";

const namespace = openFeatureNamespace("rationale-execution");
const EXECUTION_KEY_NAME = "invocation-execution.key";

interface RecoverableInvocationStartCas extends HostInvocationStartCas {
  recoverAfterCrash(): Promise<InvocationCrashRecoveryResult>;
}

export interface RationaleHostWiringOverrides {
  readonly productionEnabled?: boolean;
  readonly createInvocationJournal?: (
    options: DurableHostInvocationStartCasStoreOptions,
  ) => RecoverableInvocationStartCas;
  readonly createHostService?: (
    options: RationaleHostServiceOptions,
  ) => RationaleHostService;
}

async function checkDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Execution state requires a plain directory");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

async function openExecutionState(
  encryption: BootContext["host"]["encryption"],
): Promise<DurableHostInvocationStartCasStoreOptions> {
  await checkDirectory(namespace.dir);
  await checkDirectory(join(namespace.dir, "keys"));
  const keyDir = await namespace.childDir("keys");
  await checkDirectory(keyDir);
  const filePath = join(namespace.dir, "invocations.json");
  return withFileLock(filePath, async () => {
    const checkpointStore = await SafeStorageSecretStore.open(encryption, keyDir, "reject");
    let executionKey = checkpointStore.read(EXECUTION_KEY_NAME, 128);
    if (executionKey === null) {
      const existing = await lstat(filePath).catch((error: unknown) => {
        if (!isMissingPathError(error)) throw error;
        return null;
      });
      if (existing) throw new Error("Invocation execution key is missing");
      executionKey = randomBytes(32).toString("hex");
      checkpointStore.write(EXECUTION_KEY_NAME, executionKey);
    }
    if (!/^[0-9a-f]{64}$/.test(executionKey)) throw new Error("Invalid invocation execution key");
    return { filePath, executionKey, checkpointStore };
  }, { createTarget: false });
}

/** Publish execution authority after recovery and resolve the reviewer at invocation. */
export async function wireRationaleHost(
  ctx: BootContext,
  overrides: RationaleHostWiringOverrides = {},
): Promise<void> {
  ctx.rationaleHostService = undefined;
  const productionEnabled =
    overrides.productionEnabled ?? FOREGROUND_RATIONALE_PRODUCTION_ENABLED;

  try {
    const journalOptions = await openExecutionState(ctx.host.encryption);
    const invocationStartCas =
      overrides.createInvocationJournal?.(journalOptions) ??
      new DurableHostInvocationStartCasStore(journalOptions);

    if (productionEnabled) await invocationStartCas.recoverAfterCrash();

    const serviceOptions: RationaleHostServiceOptions = {
      approvalGate: ctx.approvalGate,
      onReviewerChoiceResolved: (sessionId, requestId, decision) =>
        ctx.permissionManager.resolveReviewerChoice(sessionId, requestId, decision),
      getRationaleScopeReviewer: () => ctx.rationaleScopeReviewer,
      getRegistryGeneration: () => ctx.toolRegistry.getGeneration(),
      getSandboxGeneration,
      invocationStartCas,
    };
    ctx.rationaleHostService =
      overrides.createHostService?.(serviceOptions) ??
      new RationaleHostService(serviceOptions);
  } catch {
    ctx.rationaleHostService = undefined;
    logPermissionEvent("rationale_unavailable", { reasonCode: "execution-state-unavailable" }, "warn");
  }
}
