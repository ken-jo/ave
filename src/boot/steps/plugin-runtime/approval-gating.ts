/** Share one issuer registry between approval requests and responses. */
import { createLogger } from "../../../lib/logger.js";
import type { AuditEntry } from "../../../audit/audit-logger.js";
import {
  ApprovalIssuerRegistry,
  ApprovalOriginError,
} from "../../../permissions/agent-action-requester.js";

const log = createLogger("ave");

/** Audit failures are non-fatal; always rethrow the original approval-origin error. */
export function auditApprovalViolation(
  err: unknown,
  auditLogger: { log(entry: AuditEntry): void },
  pluginId: string,
  requestId: string,
): never {
  try {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gating",
      type: "error",
      input: err instanceof ApprovalOriginError
        ? `[${err.code}] plugin='${pluginId}' requestId='${requestId}' ${err.message}`
        : `[approval-gating] plugin='${pluginId}' requestId='${requestId}' ${String(err)}`,
    });
  } catch (auditErr) {
    log.warn(
      "approval-gating audit log failed (non-fatal): %s",
      (auditErr as Error).message,
    );
  }
  throw err;
}

/** Bind request ids to issuer and scope so response checks reject cross-plugin and scope attacks. */
export const approvalIssuerRegistry = new ApprovalIssuerRegistry();
