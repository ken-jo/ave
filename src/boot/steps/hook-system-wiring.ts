/** Hook trust contract: docs/architecture/permission-policy-design.md, Layer 6. */
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import {
  runHookTrustWorkflow,
  type RunHookTrustResult,
  type TrustPromptDispatcher,
} from "../../hooks/hook-trust-prompt.js";
import { HOOKS_CONFIG_FILENAME } from "../../hooks/hook-config-trust.js";
import { createLogger } from "../../lib/logger.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { randomUUID } from "node:crypto";
import type { HookCommandAuthorizer } from "../../hooks/hook-command-policy.js";
import { collectHookMatcherDiagnostics } from "../../hooks/hook-matcher-diagnostics.js";
import type { NotificationService } from "../../main/notification-service.js";

const log = createLogger("hook-system-wiring");

export interface WireHookSystemDeps {
  notificationService?: Pick<NotificationService, "fire">;
  authorizeCommand?: HookCommandAuthorizer;
  hooksDir?: string;
  lockfilePath?: string;
  disabledDir?: string;
  /** Tests may inject trust decisions; production quarantines all new or changed hooks. */
  promptDispatcher?: TrustPromptDispatcher;
  auditLogger?: Pick<AuditLogger, "log" | "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
}

export interface HookSystemBootResult {
  manager: ScriptHookManager;
  trust: RunHookTrustResult;
}

/** Production never prompts at boot: new or changed scripts and hooks.json are quarantined. */
export async function wireHookSystem(
  deps: WireHookSystemDeps = {},
): Promise<HookSystemBootResult> {
  const diagnostics = collectHookMatcherDiagnostics(deps.hooksDir, deps.disabledDir);
  const trust = await runHookTrustWorkflow({
    hooksDir: deps.hooksDir,
    lockfilePath: deps.lockfilePath,
    disabledDir: deps.disabledDir,
    promptDispatcher: deps.promptDispatcher,
  });
  const manager = new ScriptHookManager();
  manager.setCommandAuthorizer(deps.authorizeCommand ?? (async () => ({
    decision: "deny", reason: "hook command policy is not wired",
  })));
  // Only trusted config contributes commands; the synthetic hooks.json trust unit is not a runnable script.
  const shHooks = trust.trustedHooks.filter((h) => h.fileName !== HOOKS_CONFIG_FILENAME);
  manager.setTrustedRegistry(shHooks, trust.trustedConfigEntries);
  manager.setMatcherGuards(diagnostics.guards);
  for (const notice of diagnostics.notices) {
    log.warn("%s", notice);
    // The existing notification service caps each body at 80 characters.
    const parts = notice.match(/[\s\S]{1,80}/gu) ?? [];
    parts.forEach((body, index) => deps.notificationService?.fire({
      kind: "system", title: `Hook configuration (${index + 1}/${parts.length})`, body, sticky: true,
    }));
  }
  log.info(
    "boot: hook system ready (sh=%d, config-entries=%d, disabled=%d)",
    shHooks.length,
    trust.trustedConfigEntries.length,
    trust.disabledHooks.length,
  );
  await emitHookQuarantineAudit(trust, deps.auditLogger);
  return { manager, trust };
}

async function emitHookQuarantineAudit(
  trust: RunHookTrustResult,
  auditLogger?: Pick<AuditLogger, "log" | "isPermissionAuditChainReady" | "appendPermissionAuditEntry">,
): Promise<void> {
  if (!auditLogger || trust.disabledHooks.length === 0) return;
  const disabled = new Set(trust.disabledHooks.map((hook) => hook.fileName));
  for (const entry of trust.diff) {
    if (entry.state !== "new" && entry.state !== "changed") continue;
    if (!disabled.has(entry.hook.fileName)) continue;
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "boot",
      type: "warn",
      input: JSON.stringify({
        kind: "hook.quarantined",
        fileName: entry.hook.fileName,
        hookType: entry.hook.hookType,
        sha256: entry.hook.sha256,
        state: entry.state,
        previousSha256: entry.previousSha256,
      }),
      output: "Hook quarantined during boot trust workflow",
      toolCalls: [{ name: "hook_trust_boot", isError: false, trust: "high" }],
    });
    if (auditLogger.isPermissionAuditChainReady()) {
      await auditLogger.appendPermissionAuditEntry({
        decision: "deny",
        auditId: randomUUID(),
        ts: new Date().toISOString(),
        trustOrigin: "unknown",
        tool: "hook_trust_boot",
        source: "builtin",
        category: "meta",
        denyReasons: [{
          reason: `hook.quarantined:${entry.hook.fileName}:${entry.state}`,
          source: "hook-trust-workflow",
        }],
      });
    }
  }
}
