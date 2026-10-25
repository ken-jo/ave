/** Trusted UI ancestry must survive nested plugin calls and asynchronous continuations. */
import { describe, it, expect } from "vitest";
import {
  runWithInvocationOrigin,
  currentInvocationOrigin,
} from "../origin-chain.js";

describe("runWithInvocationOrigin — issue #664 P2 UI-stickiness", () => {
  it("(a) UI → plugin → plugin keeps UI at the innermost frame", async () => {
    let innermost: string | undefined;
    await runWithInvocationOrigin("ui", undefined, async () => {
      expect(currentInvocationOrigin()).toBe("ui");
      await runWithInvocationOrigin("plugin", undefined, async () => {
        expect(currentInvocationOrigin()).toBe("ui");
        await runWithInvocationOrigin("plugin", undefined, async () => {
          innermost = currentInvocationOrigin();
        });
      });
    });
    expect(innermost).toBe("ui");
  });

  it("(b) plugin → plugin (no UI ancestor) stays plugin", async () => {
    let innermost: string | undefined;
    await runWithInvocationOrigin("plugin", undefined, async () => {
      expect(currentInvocationOrigin()).toBe("plugin");
      await runWithInvocationOrigin("plugin", undefined, async () => {
        innermost = currentInvocationOrigin();
      });
    });
    expect(innermost).toBe("plugin");
  });

  it("(c) setTimeout boundary preserves the chain (AsyncLocalStorage)", async () => {
    // Timers retain the effective invocation origin through async context.
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          observed.push(currentInvocationOrigin() ?? "undefined");
          resolve();
        }, 0);
      });
    });
    expect(observed).toEqual(["ui"]);
  });

  it("(c') queueMicrotask boundary preserves the chain", async () => {
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          observed.push(currentInvocationOrigin() ?? "undefined");
          resolve();
        });
      });
    });
    expect(observed).toEqual(["ui"]);
  });

  it("(d) concurrent inner calls share the same parent frame", async () => {
    const observed: string[] = [];
    await runWithInvocationOrigin("ui", undefined, async () => {
      await Promise.all([
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
        runWithInvocationOrigin("plugin", undefined, async () => {
          observed.push(currentInvocationOrigin() ?? "undefined");
        }),
      ]);
    });
    expect(observed).toEqual(["ui", "ui", "ui"]);
  });

  it("explicit parentOrigin=ui upgrades current=plugin to ui", async () => {
    // Explicit parent UI origin preserves ancestry across process boundaries.
    let observed: string | undefined;
    await runWithInvocationOrigin("plugin", "ui", async () => {
      observed = currentInvocationOrigin();
    });
    expect(observed).toBe("ui");
  });

  it("outside any scope → currentInvocationOrigin returns undefined", () => {
    expect(currentInvocationOrigin()).toBeUndefined();
  });
});
