import { describe, expect, it } from "vitest";
import type { ConversationLoopDeps } from "../types.js";

type TurnPluginRuntime = NonNullable<ConversationLoopDeps["pluginRuntime"]>;

describe("turn plugin runtime contract", () => {
  it("requires an enabled-state query alongside the plugin inventory", () => {
    // @ts-expect-error A present runtime must answer enabled-state queries.
    const missingEnabledQuery: TurnPluginRuntime = { listPluginIds: () => [] };
    const runtime: TurnPluginRuntime = {
      listPluginIds: () => ["example"],
      isPluginEnabled: () => false,
    };

    expect(missingEnabledQuery.listPluginIds()).toEqual([]);
    expect(runtime.isPluginEnabled("example")).toBe(false);
  });
});
