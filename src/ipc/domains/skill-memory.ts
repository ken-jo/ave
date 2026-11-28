import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../contract/app-contract.js";
import { SHA256_HEX } from "../../lib/hex-digest-equal.js";
import { mainWindowForContents } from "../../main/app-state.js";
import { isAuthorizedWorkspaceProjectRoot } from "../../main/project-root-authorization.js";
import { isSkillMemoryProposalCurrent } from "../../memory/skill-memory-service.js";
import { securitySettingsGestures } from "../security-settings-gesture.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { SkillMemoryApi } from "../../shared/skill-memory-types.js";
import type { IpcDeps } from "../types.js";

const Hash = z.string().regex(SHA256_HEX);
const Id = z.uuid();
const Decision = z.union([
  z.object({ action: z.enum(["apply", "reject", "delete"]), scopeId: Hash, lessonId: Id, digest: Hash }).strict(),
  z.object({ action: z.literal("undo"), scopeId: Hash, changeId: Id, digest: Hash }).strict(),
]);

function isSkillMemoryOwnerFrame(event: IpcMainInvokeEvent): boolean {
  return validateHostRendererSender(event) && !!event.sender && !event.sender.isDestroyed()
    && event.senderFrame === event.sender.mainFrame;
}

export function isAttendedSkillMemoryOwner(event: IpcMainInvokeEvent): boolean {
  return isSkillMemoryOwnerFrame(event) && mainWindowForContents(event.sender)?.isFocused() === true;
}

export function registerSkillMemoryHandlers(deps: IpcDeps): void {
  const { list, decide } = CHANNELS.skillMemory;
  const skillMemory = () => deps.conversationLoop.deps?.skillMemory;
  ipcMain.handle(list, async (event, ...args: unknown[]): Promise<Awaited<ReturnType<SkillMemoryApi["list"]>> | typeof UNAUTHORIZED_FRAME> => {
    if (!isSkillMemoryOwnerFrame(event)) {
      auditUnauthorized(list);
      return UNAUTHORIZED_FRAME;
    }
    if (args.length > 0) return { ok: false };
    try {
      const service = skillMemory();
      if (!service) return { ok: false };
      const review = service.ensureReviewAvailable();
      const groups = await service.store.listCurrent(async (scope, fingerprint) =>
        isAuthorizedWorkspaceProjectRoot(scope.projectRoot)
        && isSkillMemoryProposalCurrent(scope, fingerprint, await deps.skillStore?.load(scope.skill)));
      return { ok: true, groups, review };
    } catch { return { ok: false }; }
  });
  ipcMain.handle(decide, async (event, raw: unknown, ...extra: unknown[]) => {
    if (!isAttendedSkillMemoryOwner(event)) {
      auditUnauthorized(decide);
      return UNAUTHORIZED_FRAME;
    }
    const parsed = Decision.safeParse(raw);
    const current = skillMemory()?.store;
    if (!parsed.success || extra.length || !current) return { ok: false };
    const operation = { channel: decide, payload: parsed.data };
    const proof = securitySettingsGestures.consume(event.sender, operation);
    if (!proof) return { ok: false };
    try {
      const decision = parsed.data;
      const group = decision.action === "apply" || decision.action === "delete"
        ? current.list().find(group => group.scope.id === decision.scopeId) : undefined;
      const stagedDeletion = decision.action === "delete" && group?.staged.some(lesson =>
        lesson.id === decision.lessonId && lesson.digest === decision.digest);
      const skill = group && (decision.action === "apply" || stagedDeletion)
        ? await deps.skillStore?.load(group.scope.skill) : undefined;
      let redeemed = false;
      return { ok: await current.decide(decision, (scope, lesson, deletingStaged) => {
        if (!isAttendedSkillMemoryOwner(event)) return false;
        if (decision.action === "apply" && (!isAuthorizedWorkspaceProjectRoot(scope.projectRoot)
          || !isSkillMemoryProposalCurrent(scope, lesson.fingerprint, skill))) return false;
        if (deletingStaged && (!stagedDeletion || (isAuthorizedWorkspaceProjectRoot(scope.projectRoot)
          && isSkillMemoryProposalCurrent(scope, lesson.fingerprint, skill)))) return false;
        // A transient rename retry stays within this decision and must still have the same live receipt.
        if (redeemed) return securitySettingsGestures.matches(event.sender, proof, operation);
        redeemed = securitySettingsGestures.redeem({ surface: event.sender, proof }, operation) === event.sender;
        return redeemed;
      }) };
    } catch { return { ok: false }; }
  });
}
