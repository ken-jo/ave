import { test as base, type WorkerInfo } from "@playwright/test";
import type { ElectronApplication } from "playwright";

type ElectronContext = ElectronApplication | { app: ElectronApplication };

export interface SharedElectronAdapter<Context extends ElectronContext> {
  launch(key: string, workerInfo: WorkerInfo): Promise<Context>;
  reset(context: Context): Promise<void>;
  assertClean(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

/** Worker-owned serial lifetime for one launch configuration. A failed reset must never reach a test body. */
export class SharedElectronSession<Context extends ElectronContext> {
  private context: Context | undefined;

  constructor(
    private readonly adapter: SharedElectronAdapter<Context>,
    private readonly key: string,
    private readonly workerInfo: WorkerInfo,
  ) {}

  async prepare(onRecovery: (reason: string) => void): Promise<Context> {
    if (this.context) {
      try {
        const app = ("app" in this.context ? this.context.app : this.context) as ElectronApplication;
        const child = app.process();
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Shared test application exited");
        }
        await this.adapter.reset(this.context);
        await this.adapter.assertClean(this.context);
        return this.context;
      } catch (error) {
        await this.close();
        onRecovery(error instanceof Error ? error.message : String(error));
      }
    }
    this.context = await this.adapter.launch(this.key, this.workerInfo);
    try {
      await this.adapter.assertClean(this.context);
      return this.context;
    } catch (error) {
      await this.close();
      throw new Error("Fresh test application failed its clean-state assertion", { cause: error });
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    if (context) {
      await this.adapter.close(context);
      this.context = undefined;
    }
  }
}

export class SharedElectronPool {
  private readonly sessions = new Map<object, Map<string, { close(): Promise<void> }>>();

  constructor(private readonly workerInfo: WorkerInfo) {}

  session<Context extends ElectronContext>(adapter: SharedElectronAdapter<Context>, key: string): SharedElectronSession<Context> {
    let configurations = this.sessions.get(adapter);
    if (!configurations) {
      configurations = new Map();
      this.sessions.set(adapter, configurations);
    }
    let session = configurations.get(key) as SharedElectronSession<Context> | undefined;
    if (!session) {
      session = new SharedElectronSession(adapter, key, this.workerInfo);
      configurations.set(key, session);
    }
    return session;
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()].flatMap(configurations => [...configurations.values()]);
    const errors: unknown[] = [];
    for (const session of sessions) {
      try { await session.close(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Shared application pool teardown failed");
    this.sessions.clear();
  }
}

/** One fixture identity keeps compatible specs in the same worker. */
export const sharedElectronTest = base.extend<{ launchKey: string }, { sharedElectronPool: SharedElectronPool }>({
  launchKey: ["", { option: true }],
  sharedElectronPool: [async ({ browserName: _browserName }, use, workerInfo) => {
    const pool = new SharedElectronPool(workerInfo);
    try {
      await use(pool);
    } finally {
      await pool.close();
    }
  }, { scope: "worker" }],
});

/** Cache identity includes the adapter and every process-level launch option in launchKey. */
export function createSharedElectronTest<Context extends ElectronContext>(adapter: SharedElectronAdapter<Context>) {
  return sharedElectronTest.extend<{ sharedApp: Context; sharedElectronSession: SharedElectronSession<Context> }>({
    sharedElectronSession: async ({ sharedElectronPool, launchKey }, use) => {
      await use(sharedElectronPool.session(adapter, launchKey));
    },
    sharedApp: async ({ sharedElectronSession }, use, testInfo) => {
      const context = await sharedElectronSession.prepare(reason => {
        testInfo.annotations.push({ type: "app-relaunched", description: reason });
        console.warn(`Shared application reset required a relaunch: ${reason}`);
      });
      const app = ("app" in context ? context.app : context) as ElectronApplication;
      testInfo.annotations.push({ type: "shared-app-pid", description: String(app.process().pid) });
      await use(context);
    },
  });
}
