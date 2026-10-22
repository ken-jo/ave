export function resolveHostLockSettings(env?: NodeJS.ProcessEnv): {
  directory: string;
  timeoutMs: number;
  fastSlots: number;
};
export function withHostLock<T>(
  options: {
    name: string;
    label: string;
    directory: string;
    timeoutMs: number;
    slots?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => void;
    log?: (message: string) => void;
  },
  callback: () => T,
): T;
