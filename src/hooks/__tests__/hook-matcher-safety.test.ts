import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileHookMatcher, hookMatcherError } from "../hook-discovery.js";
import * as hookDiscovery from "../hook-discovery.js";
import { parseHookConfig } from "../hook-config.js";
import { buildHookRegistry } from "../hook-registry.js";
import { ScriptHookManager } from "../script-hook-manager.js";
import { hookJsonInput, lifecycleMatcherSubject } from "../hook-contract.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { FireOptions } from "../../main/notification-service.js";

const COMMAND = resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs");
const PAYLOAD = { toolName: "read_file", source: "builtin" as const, category: "read" as const,
  input: {}, sessionId: "session-example", trustOrigin: "user-keyboard" as const };

describe("hook matcher safety", () => {
  it("exposes invalid matchers through the compiled path without a swallowing shortcut", () => {
    expect(() => compileHookMatcher("*danger*")).toThrow();
    expect(hookDiscovery).not.toHaveProperty("hookMatchesTool");
  });

  it.each(["PreToolUse", "PermissionRequest"] as const)("invalid %s config matcher denies every tool with its file and pattern", async (event) => {
    const manager = new ScriptHookManager();
    const parsed = parseHookConfig({ hooks: { [event]: [{ matcher: "*danger*", hooks: [{ type: "command", command: ["node", COMMAND, "echo"] }] }] } });
    manager.setTrustedRegistry([], parsed.entries);
    for (const toolName of ["read_file", "mcp__server__tool"]) {
      const result = await (event === "PreToolUse" ? manager.runPreToolUse({ ...PAYLOAD, toolName }) : manager.runPermissionRequest({ ...PAYLOAD, toolName }));
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("hooks.json");
      expect(result.reason).toContain("*danger*");
      expect(result.results).toEqual([]);
    }
  });

  it.each(["pre", "perm"] as const)("invalid legacy %s matcher retains a denial guard", async (event) => {
    const manager = new ScriptHookManager();
    manager.setTrustedHooks([{ path: `/home/alice/.config/ave/hooks/${event}-guard.sh`, fileName: `${event}-guard.sh`, hookType: event, matcher: "*danger*", sha256: "hash", size: 1 }]);
    const result = await (event === "pre" ? manager.runPreToolUse(PAYLOAD) : manager.runPermissionRequest(PAYLOAD));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(`${event}-guard.sh`);
    expect(result.reason).toContain("*danger*");
  });

  it("boot emits existing notifications for refused and ignored matchers, including quarantined guards on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-matcher-"));
    try {
      const hooksDir = join(dir, "hooks");
      mkdirSync(hooksDir);
      for (const prefix of ["pre", "perm", "post"]) writeFileSync(join(hooksDir, `${prefix}-guard.sh`), "#!/bin/sh\n# ave-hook-matcher: *danger*\nexit 0\n");
      writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: "[", hooks: [{ type: "command", command: ["node", COMMAND] }] }],
        SessionStart: [{ matcher: "[", hooks: [{ type: "command", command: ["node", COMMAND] }] }],
        UserPromptSubmit: [{ matcher: "[", hooks: [{ type: "command", command: ["node", COMMAND] }] }],
      } }));
      const notificationService = { fire: vi.fn<(notice: FireOptions) => void>() };
      const options = { hooksDir, disabledDir: join(hooksDir, ".disabled"), lockfilePath: join(hooksDir, ".lockfile.json"), notificationService };
      for (let boot = 0; boot < 2; boot += 1) {
        notificationService.fire.mockClear();
        const result = await wireHookSystem(options);
        const notices = notificationService.fire.mock.calls.map(([notice]) => notice.body).join("");
        expect(notices).toContain("pre-guard.sh");
        expect(notices).toContain("perm-guard.sh");
        expect(notices).toContain("post-guard.sh");
        expect(notices).toContain('matcher "*danger*"');
        expect(notices).toContain("SessionStart[0]");
        expect(notices).toContain("UserPromptSubmit[0]");
        expect(notices).toContain("ignored");
        expect(await result.manager.runPreToolUse(PAYLOAD)).toMatchObject({ decision: "deny" });
        expect(await result.manager.runPermissionRequest(PAYLOAD)).toMatchObject({ decision: "deny" });
        expect(await result.manager.runPostToolUse(PAYLOAD)).toMatchObject({ decision: "allow", results: [] });
      }
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it.each(["UserPromptSubmit", "Stop"] as const)("%s ignores even invalid matchers and always runs", async (event) => {
    const parsed = parseHookConfig({ hooks: { [event]: [{ matcher: "[", hooks: [{ type: "command", command: ["node", COMMAND, "silent"] }] }] } });
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("ignored");
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], parsed.entries);
    const result = event === "Stop"
      ? await manager.runLifecycleEvent(event, "session-example", "user-keyboard")
      : await manager.runUserPromptSubmit("session-example", "user-keyboard", { inputText: "a".repeat(100_000) });
    expect(result.decision).toBe("allow");
    expect(result.results).toHaveLength(1);
  });

  it("direct registry entries also ignore prompt and Stop matchers without evaluating free text", async () => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], ["UserPromptSubmit", "Stop"].map((event) => ({ id: event, event: event as "Stop" | "UserPromptSubmit", source: "config" as const, matcher: "nomatch", command: ["node", COMMAND, "silent"], timeoutMs: 5000 })));
    expect((await manager.runUserPromptSubmit("session-example", "user-keyboard", { inputText: "a".repeat(100_000) })).results).toHaveLength(1);
    expect((await manager.runLifecycleEvent("Stop", "session-example", "user-keyboard")).results).toHaveLength(1);
  });

  it("uses source and notification category, preserves agent-type SubagentStop matching, and serializes them", () => {
    expect(lifecycleMatcherSubject("SessionStart", "wrong", { sessionSource: "resume" })).toBe("resume");
    expect(lifecycleMatcherSubject("SessionStart", "wrong", {})).toBe("startup");
    expect(lifecycleMatcherSubject("Notification", "wrong", { notificationType: "agent_completed" })).toBe("agent_completed");
    expect(lifecycleMatcherSubject("Notification", "wrong", {})).toBe("agent_completed");
    expect(lifecycleMatcherSubject("SubagentStop", "wrong", { agentType: "reviewer" })).toBe("reviewer");
    expect(hookJsonInput({ hookType: "SessionStart", event: "SessionStart", sessionId: "example", trustOrigin: "unknown", sessionSource: "resume" }, "/workspace")).toMatchObject({ source: "resume" });
    expect(hookJsonInput({ hookType: "Notification", event: "Notification", sessionId: "example", trustOrigin: "unknown", notificationType: "agent_completed" }, "/workspace")).toMatchObject({ notification_type: "agent_completed" });
  });

  it("caps patterns and subjects on the real compiled predicate path", () => {
    expect(hookMatcherError("a".repeat(257))).toContain("256");
    expect(compileHookMatcher("a".repeat(256))("a".repeat(256))).toBe(true);
    for (const matcher of [undefined, "*", "read_file", "mcp__.*"]) {
      expect(() => compileHookMatcher(matcher)("a".repeat(257))).toThrow("256");
    }
  });

  it.each(["pre", "perm"] as const)("oversized tool subjects fail closed for %s", async (event) => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], [{ id: "guard", event, matcher: "^write", source: "config", command: ["node", COMMAND], timeoutMs: 5000 }]);
    const result = await (event === "pre" ? manager.runPreToolUse({ ...PAYLOAD, toolName: "a".repeat(257) }) : manager.runPermissionRequest({ ...PAYLOAD, toolName: "a".repeat(257) }));
    expect(result).toMatchObject({ decision: "deny", results: [] });
    expect(result.reason).toContain("hooks.json");
    expect(result.reason).toContain("256");
  });

  it.each(["post", "Notification"] as const)("oversized subjects refuse observation hook %s", async (event) => {
    const manager = new ScriptHookManager();
    manager.setTrustedRegistry([], [{ id: "observe", event, matcher: "a.*", source: "config", command: ["node", COMMAND], timeoutMs: 5000 }]);
    const result = event === "post" ? await manager.runPostToolUse({ ...PAYLOAD, toolName: "a".repeat(257) }) : await manager.runLifecycleEvent("Notification", "example", "unknown", { notificationType: "a".repeat(257) });
    expect(result).toMatchObject({ decision: "allow", results: [] });
  });

  it("rejects catastrophic shapes at the caps well within the dispatch budget", () => {
    const pattern = "(\\w+)+-".padEnd(256, "x");
    // Fail before evaluation on an implementation without the load-time guard.
    expect(hookMatcherError(pattern)).toBeDefined();
    const times: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const start = performance.now();
      const registry = buildHookRegistry([], [{ id: "bounded", event: "pre", matcher: pattern, source: "config", command: ["node", COMMAND], timeoutMs: 5000 }]);
      expect(registry[0].matcherError).toBeDefined();
      expect(registry[0].matchesSubject("a".repeat(256))).toBe(false);
      times.push(performance.now() - start);
    }
    const maximum = Math.max(...times);
    process.stdout.write(`catastrophic matcher: pattern=256 subject=256 iterations=100 max=${maximum.toFixed(3)}ms bound=50ms\n`);
    expect(maximum).toBeLessThan(50);
    for (const unsafe of ["(a|aa)+$", "a*a*a*", "(a+)+$", "a{999999}", "(a)\\1+"]) expect(hookMatcherError(unsafe), unsafe).toBeDefined();
  });

  it("valid reference matchers and bounded MCP names remain usable", async () => {
    for (const matcher of ["Edit|Write", "Edit, Write", "code-reviewer", "^Notebook", "mcp__memory__.*", "mcp__.*__write.*", "^(manual|auto)$"]) expect(hookMatcherError(matcher), matcher).toBeUndefined();
    expect(compileHookMatcher("mcp__.*__write.*")("mcp__" + "s".repeat(120) + "__write" + "t".repeat(124))).toBe(true);
    const manager = new ScriptHookManager();
    const parsed = parseHookConfig({ hooks: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: ["node", COMMAND, "echo"] }] }] } });
    manager.setTrustedRegistry([], parsed.entries);
    expect(await manager.runPreToolUse(PAYLOAD)).toMatchObject({ decision: "allow", results: [] });
    expect((await manager.runPreToolUse({ ...PAYLOAD, toolName: "write_file" })).results).toHaveLength(1);
  });

  it("bounds accepted repeated atoms at both length caps", () => {
    for (const pattern of ["a{0,256}a{0,256}b", "a{0,256}a{0,256}b".padEnd(256, "b")]) {
      const predicate = compileHookMatcher(pattern);
      const times: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const start = performance.now();
        expect(predicate("a".repeat(256))).toBe(false);
        times.push(performance.now() - start);
      }
      process.stdout.write(`accepted matcher: pattern=${pattern.length} subject=256 iterations=100 max=${Math.max(...times).toFixed(3)}ms bound=50ms\n`);
      expect(Math.max(...times)).toBeLessThan(50);
    }
  });

  it("registry and validation rethrow unexpected matcher construction failures", () => {
    const error = new Error("unexpected construction failure");
    const constructor = vi.spyOn(globalThis, "RegExp").mockImplementation(function () { throw error; });
    try {
      expect(() => buildHookRegistry([], [{ id: "config", event: "pre", matcher: "mcp__.*", source: "config", command: ["node", COMMAND], timeoutMs: 5000 }])).toThrow(error);
      expect(() => buildHookRegistry([{ path: "/home/alice/pre-guard.sh", fileName: "pre-guard.sh", hookType: "pre", matcher: "mcp__.*", sha256: "hash", size: 1 }], [])).toThrow(error);
      expect(() => hookMatcherError("mcp__.*")).toThrow(error);
    } finally {
      constructor.mockRestore();
    }
  });
});
