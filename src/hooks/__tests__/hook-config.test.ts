// Config parsing rejects unsafe handlers and matchers, recognizes only closed-set events, and clamps timeouts (docs/architecture/hook-runtime-expansion-design.md).
import { describe, expect, it } from "vitest";
import { parseHookConfig } from "../hook-config.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../script-hook-types.js";

describe("parseHookConfig — empty / missing", () => {
  it("returns empty entries for undefined / null / non-object", () => {
    for (const raw of [undefined, null]) {
      const r = parseHookConfig(raw);
      expect(r.entries).toEqual([]);
      expect(r.errors).toEqual([]);
    }
    const r = parseHookConfig(42);
    expect(r.entries).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("treats a config with no hooks key as a valid empty config", () => {
    const r = parseHookConfig({ version: 1 });
    expect(r.entries).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("warns when hooks is not an object", () => {
    const r = parseHookConfig({ version: 1, hooks: [] });
    expect(r.entries).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });
});

describe("parseHookConfig — valid parse", () => {
  it("parses a well-formed command hook with a local-script command", () => {
    const r = parseHookConfig({
      version: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: "^mcp__.*$",
            hooks: [
              {
                type: "command",
                command: "~/.config/ave/hooks/pre_policy.py",
                timeoutMs: 3000,
              },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      event: "pre",
      matcher: "^mcp__.*$",
      command: ["~/.config/ave/hooks/pre_policy.py"],
      timeoutMs: 3000,
      source: "config",
    });
    expect(r.entries[0].id).toContain("PreToolUse");
  });

  it("accepts an argv-array command and preserves order", () => {
    const r = parseHookConfig({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              { type: "command", command: ["python3", "./hooks/audit.py", "--strict"] },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries[0].command).toEqual(["python3", "./hooks/audit.py", "--strict"]);
    expect(r.entries[0].event).toBe("post");
  });

  it("maps all three closed event keys", () => {
    const mk = (cmd: string) => ({
      hooks: [{ type: "command", command: cmd }],
    });
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [mk("./a.sh")],
        PostToolUse: [mk("./b.sh")],
        PermissionRequest: [mk("./c.sh")],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries.map((e) => e.event).sort()).toEqual(["perm", "post", "pre"]);
  });

  it("treats matcher '*' and '' as match-all (undefined matcher)", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "./a.sh" }] },
          { matcher: "  ", hooks: [{ type: "command", command: "./b.sh" }] },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].matcher).toBeUndefined();
    expect(r.entries[1].matcher).toBeUndefined();
  });

  it("rejects a block whose matcher is an invalid regular expression", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          { matcher: "*danger*", hooks: [{ type: "command", command: "./a.sh" }] },
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "./b.sh" }] },
        ],
      },
    });
    expect(r.entries.map((e) => e.matcher)).toEqual(["*danger*", "Edit|Write"]);
    expect(r.entries[0].matcherError).toBeDefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('PreToolUse[0].matcher "*danger*" is not a valid regular expression');
  });
});

describe("parseHookConfig — unknown event ignored + warned (decision b)", () => {
  it("ignores an unknown event key and emits a warning", () => {
    const r = parseHookConfig({
      hooks: {
        TotallyUnknownEvent: [{ hooks: [{ type: "command", command: "./x.sh" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "./pre.sh" }] }],
      },
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].event).toBe("pre");
    expect(r.warnings.some((w) => w.includes("TotallyUnknownEvent"))).toBe(true);
    // Never silently active.
    expect(r.entries.some((e) => e.command[0] === "./x.sh")).toBe(false);
  });

  it.each(["constructor", "toString", "__proto__"])("ignores inherited event name %s", (event) => {
    const result = parseHookConfig({ hooks: { [event]: [{ hooks: [{ type: "command", command: "./hook.sh" }] }] } });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toContain(`hooks.json: unknown event "${event}" — entry ignored`);
  });
});

// Lifecycle events are config-only; legacy scripts have no lifecycle filename prefix.
describe("parseHookConfig — lifecycle event keys recognized (#811 m2)", () => {
  it.each([
    ["PostToolUseFailure"],
    ["PermissionDenied"],
    ["SessionStart"],
    ["Stop"],
    ["PreCompact"],
    ["PostCompact"],
    ["SubagentStart"],
    ["SubagentStop"],
    ["SessionEnd"],
    ["Notification"],
  ])("maps lifecycle event %s to itself with no warning", (eventKey) => {
    const r = parseHookConfig({
      hooks: {
        [eventKey]: [{ hooks: [{ type: "command", command: "./life.sh" }] }],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(1);
    // Lifecycle events map to themselves (not the pre|post|perm projection).
    expect(r.entries[0].event).toBe(eventKey);
    expect(r.warnings.some((w) => w.includes("unknown event"))).toBe(false);
  });
});

describe("parseHookConfig — handler validation", () => {
  it("defers file-anchor eligibility to config loading", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "curl https://evil.example/x" }] },
        ],
      },
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].command).toEqual(["curl", "https://evil.example/x"]);
    expect(r.errors).toEqual([]);
  });

  it("accepts a PATH-binary that references a local script argument", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "python3 ~/.config/ave/hooks/p.py" },
            ],
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].command).toEqual(["python3", "~/.config/ave/hooks/p.py"]);
  });

  it("rejects an unsupported handler type", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Check the call" }] }],
      },
    });
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0]).toContain("command");
  });

  it("rejects a handler with an empty / missing command", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "   " }] }],
      },
    });
    expect(r.entries).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
  });
});

describe("parseHookConfig — timeoutMs clamp (decision d)", () => {
  it("clamps a too-large timeout down to the ceiling", () => {
    const r = parseHookConfig({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "./a.sh",
                timeoutMs: DEFAULT_HOOK_TIMEOUT_MS + 999_999,
              },
            ],
          },
        ],
      },
    });
    expect(r.entries[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
  });

  it("keeps an in-range timeout as-is", () => {
    const r = parseHookConfig({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./a.sh", timeoutMs: 1234 }] }] },
    });
    expect(r.entries[0].timeoutMs).toBe(1234);
  });

  it("defaults a missing / invalid / non-positive timeout to the ceiling", () => {
    const cases = [
      undefined,
      "5000",
      0,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ];
    for (const t of cases) {
      const handler: Record<string, unknown> = { type: "command", command: "./a.sh" };
      if (t !== undefined) handler.timeoutMs = t;
      const r = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [handler] }] } });
      expect(r.entries[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    }
  });

  it.each([0, -1, 0.5, 1.5])("warns about timeoutMs %s using the positive-integer diagnostic", (timeoutMs) => {
    const result = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./a.sh", timeoutMs }] }] } });
    expect(result.entries[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(result.warnings).toContain(`hooks.json: PreToolUse#0.0 handler.timeoutMs must be a positive integer — defaulting to ${DEFAULT_HOOK_TIMEOUT_MS}ms`);
  });
});

describe("parseHookConfig — argument text", () => {
  it("preserves bare file operands, plain strings, and slash-containing options", () => {
    const command = ["node", "policy.cjs", "data/input.json", "application/json", "--output=/tmp/result.json", "--relative=./result.json"];
    const parsed = parseHookConfig({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries[0].command).toEqual(command);
  });
});
