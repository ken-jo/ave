// Bound controllers follow the same hook dispatch rules as the local user.
import { describe, expect, it, vi } from "vitest";

import { HookRunner } from "../hook-runner.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { HookDispatchPayload } from "../script-hook-types.js";
import type { HookConfigEntry } from "../hook-config.js";
import type { TailnetControllerAuthority } from "../../shared/chat-origin.js";
import {
  resolveTurnExtensionPolicy,
  turnExtensionPolicyContext,
} from "../../shared/turn-extension-policy.js";

const TAILNET_AUTHORITY = {
  kind: "tailnet-controller",
  actorId: "tailnet:policy-regression-test",
} as const satisfies TailnetControllerAuthority;

const TAILNET_POLICY = resolveTurnExtensionPolicy(TAILNET_AUTHORITY);

const TOOL_PAYLOAD: HookDispatchPayload = {
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/remote-turn.txt" },
  sessionId: "tailnet-session",
  trustOrigin: "tailnet-surface",
};

const LIFECYCLE_EVENTS = [
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "Stop",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
] as const;

function inTailnetControllerTurn<T>(operation: () => Promise<T>): Promise<T> {
  return turnExtensionPolicyContext.run(TAILNET_POLICY, operation);
}

function deniedHook(event: HookConfigEntry["event"]): HookConfigEntry {
  return {
    id: `${event}#tailnet-regression`,
    event,
    // A guard regression runs this nonzero-exit command and denies dispatch.
    command: [process.execPath, "-e", "process.exit(1)"],
    timeoutMs: 1_000,
    source: "config",
  };
}

describe("Tailnet turn extension policy", () => {
  it("runs configured hook dispatches for controller turns", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], [
      deniedHook("pre"),
      deniedHook("post"),
      deniedHook("perm"),
      deniedHook("UserPromptSubmit"),
      ...LIFECYCLE_EVENTS.map(deniedHook),
    ]);
    expect(manager.size()).toBeGreaterThan(0);

    await inTailnetControllerTurn(async () => {
      const toolDispatches = await Promise.all([
        manager.runPreToolUse(TOOL_PAYLOAD),
        manager.runPostToolUse({ ...TOOL_PAYLOAD, toolOutput: "ok", isError: false }),
        manager.runPermissionRequest(TOOL_PAYLOAD),
        manager.runUserPromptSubmit("tailnet-session", "tailnet-surface", {
          inputText: "remote prompt",
          inputOrigin: "tailnet-surface",
          route: "llm",
          classification: "general",
        }),
      ]);
      for (const result of toolDispatches) expect(result.results.length).toBeGreaterThan(0);

      for (const event of LIFECYCLE_EVENTS) {
        await expect(
          manager.runLifecycleEvent(event, "tailnet-session", "tailnet-surface"),
        ).resolves.toMatchObject({ results: expect.any(Array) });
      }
    });
  });

  it("runs registered in-process pre and post hooks", async () => {
    const runner = new HookRunner();
    const preHook = vi.fn(() => ({ action: "deny" as const, reason: "must not run" }));
    const postHook = vi.fn(() => ({ feedback: "must not run" }));
    runner.registerPreHook("unexpected-pre", preHook);
    runner.registerPostHook("unexpected-post", postHook);

    const [pre, post] = await inTailnetControllerTurn(() =>
      Promise.all([
        runner.runPreHooks({ toolName: "fs_write", toolInput: { path: "/tmp/x" } }),
        runner.runPostHooks({
          toolName: "fs_write",
          toolInput: { path: "/tmp/x" },
          toolOutput: "ok",
          isError: false,
        }),
      ]),
    );

    expect(pre.action).toBe("deny");
    expect(post).toBe("must not run");
    expect(preHook).toHaveBeenCalledOnce();
    expect(postHook).toHaveBeenCalledOnce();
  });
});
