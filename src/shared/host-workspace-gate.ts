/**
 * The one gate every host-side consumer of a workspace's protected names asks before it reads or runs them (host Git, project
 * commands, project hooks, stage seeding). The sandbox installs the check; a check that throws refuses.
 */
let workspaceGuard: ((workspace: string) => boolean) | undefined;

export function setHostWorkspaceGuard(guard: (workspace: string) => boolean): void {
  workspaceGuard = guard;
}

export function isHostWorkspaceConsumable(workspace: string): boolean {
  if (workspaceGuard === undefined) return true;
  try { return workspaceGuard(workspace); }
  catch { return false; }
}
