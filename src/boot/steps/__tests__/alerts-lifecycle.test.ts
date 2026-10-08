import { describe, expect, it, vi } from "vitest";
import { createLifecycleCallbacks } from "../plugin-runtime/lifecycle.js";

// Lifecycle callbacks must schedule inheritance without awaiting a mutation
// that can need the install lock held by the callback's caller.
describe("alert inheritance lifecycle wakeups", () => {
  it("retries on admission and retirement without holding either callback open", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const reconcileMigration = vi.fn(() => pending);
    const callbacks = createLifecycleCallbacks({
      getAlertsService: () => ({ reconcileMigration }) as never,
      getAppWindows: () => [], mainWindow: null,
      lateBinding: { conversationLoopRef: { fn: undefined } } as never,
      installLoadedPluginPartitionPolicy: vi.fn(), getBundleLifecycle: () => undefined,
    });
    expect(callbacks.onEnable!("successor")).toBeUndefined();
    expect(reconcileMigration).toHaveBeenCalledTimes(1);
    expect(callbacks.onDisable!("predecessor")).toBeUndefined();
    expect(reconcileMigration).toHaveBeenCalledTimes(2);
    finish(); await pending;
  });
});
