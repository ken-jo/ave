import type { IpcMainInvokeEvent } from "electron";
import { isDeepStrictEqual } from "node:util";
import { CHANNELS } from "../../contract/app-contract.js";
import type { SessionRepository } from "../../memory/session-repository.js";
import { WindowsSessionRepository } from "../../memory/session-repository-win32.js";
import { commitUnderAdmission } from "../../shared/admission-commit.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";
import type { MemoryMapScopeResolver } from "./memory-map.js";

export function createWindowsSessionsSearchHandler(sessions: SessionRepository, auditLogger: IpcDeps["auditLogger"], parseMemoryProjectOptions: MemoryMapScopeResolver) {
  return async (e: IpcMainInvokeEvent, query: string, opts?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsSearch, e); return UNAUTHORIZED_FRAME; }
    const project = parseMemoryProjectOptions(opts);
    if (!project.ok) return [];
    if (!(sessions instanceof WindowsSessionRepository)) return [];
    let assertReply: (() => void) | undefined;
    const matches = await sessions.searchSessionsWithCurrentPolicy(query, project.options, assertLive => { assertReply = assertLive; });
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.memory.sessionsSearch, e); return UNAUTHORIZED_FRAME; }
    const latest = parseMemoryProjectOptions(opts);
    if (!latest.ok || !isDeepStrictEqual(latest.options, project.options) || !assertReply) return [];
    try { return commitUnderAdmission(assertReply, () => matches); } catch { return []; }
  };
}
