import { describe, expect, it } from "vitest";
import { clearedImportedHooks, exportLegacyHooks, importLegacyHooks } from "../hook-import-export.js";

const block = (handler: unknown) => [{ matcher: "read_*", hooks: [handler] }];
const sourcePath = "hooks/hooks.json";

describe("hook import and export review", () => {
  it("maps every supported event and keeps each entry blocked for protocol review", () => {
    const names = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit",
      "PostToolUseFailure", "PermissionDenied", "SessionStart", "SessionEnd", "Notification", "Stop",
      "PreCompact", "PostCompact", "SubagentStart", "SubagentStop"];
    const source = { hooks: Object.fromEntries(names.map((name) => [name, block({ type: "command",
      command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.js", "${CLAUDE_PLUGIN_DATA}/state.json"],
      env: { STATE: "${CLAUDE_PLUGIN_DATA}/state.json" }, timeoutMs: 1200 })])) };
    const result = importLegacyHooks(source, sourcePath);
    expect(result.entries).toHaveLength(names.length);
    expect(result.entries[0]).toMatchObject({ sourcePath, event: "pre", matcher: "read_*", timeoutMs: 1200,
      needsAdaptation: true,
      command: ["node", "${PLUGIN_ROOT}/server/hook.js", "${PLUGIN_DATA}/state.json"],
      env: { STATE: "${PLUGIN_DATA}/state.json" } });
    expect(result.diagnostics.filter((item) => item.group === "needs your input")).toHaveLength(names.length);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ group: "needs your input", sourcePath,
      entry: "PreToolUse[0].hooks[0]" }));
    expect(() => clearedImportedHooks(result.entries)).toThrow(/needs adaptation/);
    const cleared = result.entries.map((entry) => ({ ...entry, needsAdaptation: false }));
    expect(Object.keys(clearedImportedHooks(cleared).hooks)).toEqual(names);
  });

  it.each([
    ["UnknownEvent", { type: "command", command: "node", args: ["./hook.js"] }, /no equivalent/],
    ["PreToolUse", { type: "prompt", command: "node", args: ["./hook.js"] }, /no command equivalent/],
    ["PreToolUse", { type: "command", command: "node ./hook.js" }, /shell strings are unsupported/],
    ["PreToolUse", { type: "command", command: "node", args: ["${user_config.token}"] }, /unsupported setting/],
  ] as const)("drops unmappable entry %# with its reason", (event, handler, reason) => {
    const result = importLegacyHooks({ hooks: { [event]: block(handler) } }, sourcePath);
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]?.sourcePath).toBe(sourcePath);
    expect(result.diagnostics[0]?.message).toMatch(reason);
  });

  it("locates each rejected and review-required handler in its source file", () => {
    const path = "declared/hooks/extra.json";
    const result = importLegacyHooks({ hooks: { PreToolUse: [{ matcher: "read_*", hooks: [
      { type: "prompt", prompt: "inspect" },
      { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.js"], timeoutMs: 1500 },
    ] }] } }, path);
    expect(result.entries).toEqual([expect.objectContaining({ sourcePath: path, event: "pre",
      matcher: "read_*", command: ["node", "${PLUGIN_ROOT}/server/hook.js"], timeoutMs: 1500,
      needsAdaptation: true })]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "lost", sourcePath: path, entry: "PreToolUse[0].hooks[0]" }),
      expect.objectContaining({ group: "needs your input", sourcePath: path, entry: "PreToolUse[0].hooks[1]" }),
    ]));
    expect(() => importLegacyHooks({}, "")).toThrow("source path");
  });

  it("exports names, argv, placeholders, and the protocol notice", () => {
    const result = exportLegacyHooks([{ id: "one", event: "pre", source: "config", timeoutMs: 1200,
      command: ["node", "${PLUGIN_ROOT}/server/hook.js"], env: { STATE: "${PLUGIN_DATA}/state.json" } }]);
    expect(result.hooks.PreToolUse).toMatchObject([{ hooks: [{ command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.js"], env: { STATE: "${CLAUDE_PLUGIN_DATA}/state.json" } }] }]);
    expect(result.notice).toMatch(/Stdin payload.*decision output.*matcher semantics/);
  });
});
