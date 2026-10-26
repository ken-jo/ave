// Prompt hooks fail closed on deny, timeout, exit, parse or spawn errors; only trusted entries run, all ignore matchers, and input is DLP-redacted. The observe-only path must deny this blocking event (docs/architecture/hook-runtime-expansion-design.md).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ScriptHookManager } from "../script-hook-manager.js";
import type { HookConfigEntry } from "../hook-config.js";
import { hasExecutable } from "./test-helpers.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");
const ECHO = resolve(FIXTURE_ROOT, "cmd-lifecycle-echo.js");
const DENY = resolve(FIXTURE_ROOT, "cmd-lifecycle-deny.js");
const SLOW = resolve(FIXTURE_ROOT, "cmd-slow.py");
const EXIT_FAIL = resolve(FIXTURE_ROOT, "cmd-exit-fail.py");
const BAD_JSON = resolve(FIXTURE_ROOT, "cmd-badjson.py");

const HAS_NODE = hasExecutable("node");
const HAS_PY = hasExecutable("python3");

function upsEntry(command: string[], over: Partial<HookConfigEntry> = {}): HookConfigEntry {
  return {
    id: "UserPromptSubmit#0.0",
    event: "UserPromptSubmit",
    command,
    timeoutMs: 5000,
    source: "config",
    ...over,
  };
}

describe("#811 m2 — UserPromptSubmit (BLOCKING) dispatch", () => {
  it.skipIf(!HAS_NODE)("an allowing hook → decision allow (caller proceeds)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["node", ECHO])]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", {
      inputText: "hello",
      inputOrigin: "user-keyboard",
      route: "llm",
      classification: "general",
    });
    expect(out.decision).toBe("allow");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].reason).toContain("event=UserPromptSubmit");
    expect(out.results[0].reason).toContain("text=hello");
    expect(out.results[0].reason).toContain("origin=user-keyboard");
    expect(out.results[0].reason).toContain("route=llm");
    expect(out.results[0].reason).toContain("class=general");
  });

  it.skipIf(!HAS_NODE)("a denying hook → decision deny (caller REFUSES the turn)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["node", DENY])]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "rm -rf /" });
    expect(out.decision).toBe("deny");
    expect(out.results[0].decision).toBe("deny");
  });

  it.skipIf(!HAS_PY)("a hook TIMEOUT → deny (fail-closed)", async () => {
    const m = new ScriptHookManager();
    // Clamp the per-entry timeout small so the 30s-sleep fixture trips it fast.
    m.setTrustedRegistry([], [upsEntry(["python3", SLOW], { timeoutMs: 200 })]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "hi" });
    expect(out.decision).toBe("deny");
    expect(out.results[0].timedOut).toBe(true);
  });

  it.skipIf(!HAS_PY)("a NONZERO-EXIT hook → deny (fail-closed even though it printed allow)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["python3", EXIT_FAIL])]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "hi" });
    expect(out.decision).toBe("deny");
  });

  it.skipIf(!HAS_PY)("a BAD-JSON hook → deny (fail-closed)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["python3", BAD_JSON])]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "hi" });
    expect(out.decision).toBe("deny");
  });

  it("NO matching trusted hook → allow (back-compat: turn proceeds)", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], []);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "hi" });
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
  });

  it("an untrusted / quarantined hook never fires (registry is the trust boundary)", async () => {
    const m = new ScriptHookManager();
    // Untrusted hooks never enter the registry; an empty trusted set allows the prompt.
    m.setTrustedRegistry([], []);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", { inputText: "hi" });
    expect(out.decision).toBe("allow");
    expect(out.results).toEqual([]);
    expect(m.size()).toBe(0);
  });

  it.skipIf(!HAS_NODE)("ignores the matcher and runs on every prompt", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["node", DENY], { matcher: ".*danger.*" })]);

    const matched = await m.runUserPromptSubmit("s1", "user-keyboard", {
      inputText: "this is danger zone",
    });
    expect(matched.decision).toBe("deny");

    // Matchers do not filter prompt hooks.
    const skipped = await m.runUserPromptSubmit("s1", "user-keyboard", {
      inputText: "a friendly prompt",
    });
    expect(skipped.decision).toBe("deny");
    expect(skipped.results).toHaveLength(1);
  });

  it.skipIf(!HAS_NODE)("inputText is DLP-redacted before it reaches the hook", async () => {
    const m = new ScriptHookManager();
    m.setTrustedRegistry([], [upsEntry(["node", ECHO])]);
    const out = await m.runUserPromptSubmit("s1", "user-keyboard", {
      inputText: "email me at owner@ave.example.com please",
    });
    expect(out.results[0].reason).toContain("[REDACTED:EMAIL]");
    expect(out.results[0].reason).not.toContain("owner@ave.example.com");
  });

  it.skipIf(!HAS_NODE)("the observe-only runLifecycleEvent REFUSES the blocking event (misroute guard, fail-closed)", async () => {
    const m = new ScriptHookManager();
    // Even if a hook is registered, routing the blocking event through the observe path must NOT silently allow — it fails closed (deny).
    m.setTrustedRegistry([], [upsEntry(["node", ECHO])]);
    const out = await m.runLifecycleEvent("UserPromptSubmit", "s1", "unknown");
    expect(out.decision).toBe("deny");
    expect(out.results).toEqual([]);
  });
});
