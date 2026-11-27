import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../contract/app-contract.js";
import { SHA256_HEX } from "../../lib/hex-digest-equal.js";
import { mainWindowForContents } from "../../main/app-state.js";
import { isAuthorizedWorkspaceProjectRoot } from "../../main/project-root-authorization.js";
import { isSkillMemoryProposalCurrent } from "../../memory/skill-memory-service.js";
import { securitySettingsGestures } from "../security-settings-gesture.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";

const Hash = z.string().regex(SHA256_HEX);
const Id = z.uuid();
const Decision = z.union([
  z.object({ action: z.enum(["apply", "reject"]), scopeId: Hash, lessonId: Id, digest: Hash }).strict(),
  z.object({ action: z.literal("undo"), scopeId: Hash, changeId: Id, digest: Hash }).strict(),
]);

export function isAttendedSkillMemoryOwner(event: IpcMainInvokeEvent): boolean {
  if (!validateHostRendererSender(event) || !event.sender || event.sender.isDestroyed()
    || event.senderFrame !== event.sender.mainFrame) return false;
  return mainWindowForContents(event.sender)?.isFocused() === true;
}

export function registerSkillMemoryHandlers(deps: IpcDeps): void {
  const { list, decide } = CHANNELS.skillMemory;
  const store = () => deps.conversationLoop.deps?.skillMemory?.store;
  ipcMain.handle(list, (event, ...args: unknown[]) => {
    if (!isAttendedSkillMemoryOwner(event)) {
      auditUnauthorized(deps.auditLogger, list, event);
      return UNAUTHORIZED_FRAME;
    }
    if (args.length > 0) return { ok: false };
    try {
      const groups = store()?.list();
      return groups ? { ok: true, groups } : { ok: false };
    } catch { return { ok: false }; }
  });
  ipcMain.handle(decide, async (event, raw: unknown, ...extra: unknown[]) => {
    if (!isAttendedSkillMemoryOwner(event)) {
      auditUnauthorized(deps.auditLogger, decide, event);
      return UNAUTHORIZED_FRAME;
    }
    const parsed = Decision.safeParse(raw);
    const current = store();
    if (!parsed.success || extra.length || !current) return { ok: false };
    const operation = { channel: decide, payload: parsed.data };
    const proof = securitySettingsGestures.consume(event.sender, operation);
    if (!proof) return { ok: false };
    try {
      const scopeId = parsed.data.scopeId;
      const skillName = parsed.data.action === "apply" ? current.list().find(group => group.scope.id === scopeId)?.scope.skill : undefined;
      const skill = skillName ? await deps.skillStore?.load(skillName) : undefined;
      let redeemed = false;
      return { ok: await current.decide(parsed.data, (scope, lesson) => {
        if (!isAttendedSkillMemoryOwner(event)) return false;
        if (parsed.data.action === "apply" && (!isAuthorizedWorkspaceProjectRoot(scope.projectRoot)
          || !isSkillMemoryProposalCurrent(scope, lesson.fingerprint, skill))) return false;
        // A transient rename retry stays within this decision and must still have the same live receipt.
        if (redeemed) return securitySettingsGestures.matches(event.sender, proof, operation);
        redeemed = securitySettingsGestures.redeem({ surface: event.sender, proof }, operation) === event.sender;
        return redeemed;
      }) };
    } catch { return { ok: false }; }
  });
}
