// The sandbox HOMEs this process created and has not yet removed (`sandbox-process-home.ts`). A grant inside the Windows runtime root is admitted only for one of these.
export const liveSandboxProcessHomes = new Set<string>();
