// Work approvals ("확인 필요") re-list on a payload-free broadcast. Each source store signals after its own write, whichever path made it (IPC,
// plugin HostApi, scheduler, model tool), so the stack never polls. Wired at boot, where the real stores exist, rather than at IPC registration.
import { WORK_APPROVALS } from "../../shared/ipc-channels.js";
import { fanOutToAllWindows } from "../../ipc/window-fanout.js";
import type { BootContext } from "../context.js";

export function wireWorkApprovalsChanged(
  ctx: Pick<BootContext, "workBoardStore" | "routinesStore" | "memoryManager" | "getMainWindow" | "host">,
): void {
  const appWindows = () => ctx.host.desktop?.getAppWindows() ?? [ctx.getMainWindow()];
  const broadcast = (): void => {
    fanOutToAllWindows(appWindows(), WORK_APPROVALS.changed, undefined);
  };
  ctx.workBoardStore.proposalsChanged.subscribe(broadcast);
  ctx.routinesStore.changed.subscribe(broadcast);
  ctx.memoryManager.candidatesChanged.subscribe(broadcast);
}
