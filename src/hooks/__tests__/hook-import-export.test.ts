import { describe, expect, it } from "vitest";
import { clearedImportedHooks, exportLegacyHooks, importLegacyHooks } from "../hook-import-export.js";

const block = (handler: unknown) => [{ matcher: "read_*", hooks: [handler] }];

describe("hook import and export review", () => {
  it("maps every supported event and keeps each entry blocked for protocol review", () => {
    const names = ["PreToolUse", "PostToolUse", "PermissionRequest", "UserPromptSubmit",
      "PostToolUseFailure", "PermissionDenied", "SessionStart", "SessionEnd", "Notification", "Stop",
      "PreCompact", "PostCompact", "SubagentStart", "SubagentStop"];
    const source = { hooks: Object.fromEntries(names.map((name) => [name, block({ type: "command",
      command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.js", "${CLAUDE_PLUGIN_DATA}/state.json"],
      env: { STATE: "${CLAUDE_PLUGIN_DATA}/state.json" } })])) };
    const result = importLegacyHooks(source);
    expect(result.entries).toHaveLength(names.length);
    expect(result.entries[0]).toMatchObject({ event: "pre", needsAdaptation: true,
      command: ["node", "${PLUGIN_ROOT}/server/hook.js", "${PLUGIN_DATA}/state.json"],
      env: { STATE: "${PLUGIN_DATA}/state.json" } });
    expect(result.diagnostics.filter((item) => item.group === "needs your input")).toHaveLength(names.length);
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
    const result = importLegacyHooks({ hooks: { [event]: block(handler) } });
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]?.message).toMatch(reason);
  });

  it("exports names, argv, placeholders, and the protocol notice", () => {
    const result = exportLegacyHooks([{ id: "one", event: "pre", source: "config", timeoutMs: 1200,
      command: ["node", "${PLUGIN_ROOT}/server/hook.js"], env: { STATE: "${PLUGIN_DATA}/state.json" } }]);
    expect(result.hooks.PreToolUse).toMatchObject([{ hooks: [{ command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server/hook.js"], env: { STATE: "${CLAUDE_PLUGIN_DATA}/state.json" } }] }]);
    expect(result.notice).toMatch(/Stdin payload.*decision output.*matcher semantics/);
  });
});
