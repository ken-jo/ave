import { raceWithTimeout } from '../../shared/abortable-deadline.js';
import { TOOL_TIMEOUT_POLICY } from '../../shared/tool-timeout-policy.js';
import { ManagedExitUnconfirmedError } from '../managed-child-processes.js';

export interface MemoryWorkerExit {
  starting(): void;
  confirmed(): void;
}

export class MemoryBuildTeardown {
  private readonly unconfirmed = new Set<Promise<boolean>>();
  private cancelResult?: Promise<boolean>;

  get confirmed(): boolean { return this.unconfirmed.size === 0; }

  async track<T>(run: (exit: MemoryWorkerExit) => Promise<T>): Promise<T> {
    let settle!: (confirmed: boolean) => void;
    const outcome = new Promise<boolean>(resolve => { settle = resolve; });
    try {
      return await run({
        starting: () => { this.unconfirmed.add(outcome); },
        confirmed: () => {
          this.unconfirmed.delete(outcome);
          settle(true);
        },
      });
    } finally {
      settle(false);
    }
  }

  waitForExit(): Promise<boolean> {
    if (this.confirmed) return Promise.resolve(true);
    this.cancelResult ??= raceWithTimeout(
      Promise.all(this.unconfirmed).then(outcomes => outcomes.every(Boolean)),
      TOOL_TIMEOUT_POLICY.windowsMemoryBuildCancelMs,
      () => new ManagedExitUnconfirmedError(),
    ).catch(() => false);
    return this.cancelResult;
  }
}
