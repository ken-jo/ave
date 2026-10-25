// Permission handlers share one transport-independent apply path after wrappers validate sender and keyboard intent.
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";
import type {
  LoosePermissionModeApprovalBypass,
} from "../../permissions/permission-mode-apply.js";
import type { PermissionModeCommand } from "../../permissions/permission-slash.js";

export function handleGetMode(deps: IpcDeps): { mode: string } {
  const mode = deps.conversationLoop.permissionManager?.getMode() ?? "default";
  return { mode };
}

// Out-of-band trust metadata must pass the shared bypass resolver; payload fields alone grant no authority.
export type SetPermissionModeBypass = LoosePermissionModeApprovalBypass;

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

function broadcastPermissionModeChanged(deps: IpcDeps, mode: string): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.modeChanged, { mode });
  }
}

// Apply through the shared permission command path after mode validation and any required durable confirmation.
export async function handleSetPermissionMode(
  deps: IpcDeps,
  mode: unknown,
  bypass: SetPermissionModeBypass,
): Promise<{ ok: true; mode: string } | { ok: false; error: string; message: string }> {
  if (typeof mode !== "string") {
    return { ok: false, error: "invalid-mode", message: "mode must be a string" };
  }
  const { applyPermissionModeCommand, resolvePermissionModeApprovalBypass, isExternalApprovalBypass } =
    await import("../../permissions/permission-mode-apply.js");
  const approvalBypass = resolvePermissionModeApprovalBypass(bypass);
  const external = isExternalApprovalBypass(approvalBypass);
  const { parsePermissionModeCommand } = await import("../../permissions/permission-slash.js");
  const parsed = parsePermissionModeCommand(external ? mode : `${mode} --durable`);
  if (isParseError<PermissionModeCommand>(parsed)) {
    return { ok: false, error: "invalid-mode", message: parsed.error };
  }
  // Only in-app callers assert durability; leave external --durable intact so the command ceiling rejects it.
  if (!external && parsed.durable !== true) {
    return { ok: false, error: "missing-durable-confirm", message: "durable mode command must require modal confirmation" };
  }
  const pm = deps.conversationLoop.permissionManager;
  if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
  const result = await applyPermissionModeCommand(parsed, {
    permissionManager: pm,
    approvalGate: deps.approvalGate,
    auditLogger: deps.auditLogger,
    approvalBypass,
  });
  if (!result.ok) return result;
  broadcastPermissionModeChanged(deps, result.mode);
  return { ok: true, mode: result.mode };
}
