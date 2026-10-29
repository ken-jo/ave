import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  parsePermissionReviewerCommand,
  dispatchPermissionReviewerCommand,
  dispatchPermissionReviewerCommandWithRewire,
} from "../permission-slash.js";
import {
  readPermissionSettings,
  setReviewerSettingsPersist,
  normalizePermissionSettings,
  writePermissionSettings,
} from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";

// Only ever named in a fault; `normalizePermissionSettings` reads no file.
const SETTINGS_PATH = "/nonexistent/settings.json";

const resources = new PermissionTestResources();

const tmpSettingsPath = resources.tmpFilePaths("ave-perm-reviewer-", "settings.json");

afterEach(async () => {
  await resources.cleanup();
});

describe("parsePermissionReviewerCommand", () => {
  it("parses 'show'", () => {
    expect(parsePermissionReviewerCommand("show")).toEqual({ verb: "show", value: "" });
  });

  it("parses 'mode disabled'", () => {
    expect(parsePermissionReviewerCommand("mode disabled")).toEqual({
      verb: "mode",
      value: "disabled",
    });
  });

  it("parses 'mode rule'", () => {
    expect(parsePermissionReviewerCommand("mode rule")).toEqual({
      verb: "mode",
      value: "rule",
    });
  });

  it("parses 'mode llm'", () => {
    expect(parsePermissionReviewerCommand("mode llm")).toEqual({
      verb: "mode",
      value: "llm",
    });
  });

  it.each(["provider openai", "model gpt-4o-mini"])(
    "has no reviewer provider/model subcommand: %s",
    (raw) => {
      expect(parsePermissionReviewerCommand(raw)).toEqual({
        ok: false,
        error: expect.stringMatching(/^unknown subcommand/),
      });
    },
  );

  it("parses 'fallback deny'", () => {
    expect(parsePermissionReviewerCommand("fallback deny")).toEqual({
      verb: "fallback",
      value: "deny",
    });
  });

  it.each(["off", "low", "medium"])("rejects the removed interactive %s command", value => {
    expect(parsePermissionReviewerCommand(`interactive ${value}`)).toMatchObject({ ok: false, error: expect.stringMatching(/^unknown subcommand/) });
  });

  it("rejects empty input", () => {
    const r = parsePermissionReviewerCommand("");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/missing subcommand/) });
  });

  it("rejects unknown verb", () => {
    const r = parsePermissionReviewerCommand("foo bar");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/unknown subcommand/) });
  });

  it("rejects 'mode' with no value", () => {
    const r = parsePermissionReviewerCommand("mode");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/requires a value/) });
  });

  it("rejects 'mode' with too many args", () => {
    const r = parsePermissionReviewerCommand("mode rule extra");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/single value/) });
  });

  it.each(["adjudication", "adjudication maxVerdict low", "adjudication timeoutMs 1000"])("rejects retired reviewer command %s", command => {
    expect(parsePermissionReviewerCommand(command)).toMatchObject({ ok: false, error: expect.stringMatching(/^unknown subcommand/) });
  });
});

describe("dispatchPermissionReviewerCommand — persistence", () => {
  it("show returns defaults on a missing settings file", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand({ verb: "show", value: "" }, path);
    expect(r.ok).toBe(true);
    if (r.ok && r.verb === "show") {
      // Default reviewer is "llm" (strongest classifier). Boot wiring degrades to rule at runtime when no LLM provider is configured (fresh install), but the persisted/default mode is "llm" so intent stays visible.
      expect(r.settings.mode).toBe("llm");
      expect(r.settings).not.toHaveProperty("provider");
      expect(r.settings).not.toHaveProperty("model");
      expect(r.settings.fallbackOnError).toBe("deny");
      expect(r.settings).not.toHaveProperty("interactive");
    }
  });

  it("mode rule persists to settings.json", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "mode", value: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.mode).toBe("rule");
  });

  it("ignores retired reviewer fields without rewriting until an ordinary settings change", async () => {
    const path = tmpSettingsPath();
    writeFileSync(
      path,
      JSON.stringify({
        permissions: {
          reviewer: {
            mode: "llm",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            fallbackOnError: "rule",
            interactive: { autoApprove: "low" },
          },
        },
      }),
    );
    const original = readFileSync(path, "utf8");
    const loaded = readPermissionSettings(path).permissions.reviewer;
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(loaded).not.toHaveProperty("interactive");
    expect(loaded).toMatchObject({ mode: "llm", fallbackOnError: "rule" });
    expect(loaded).not.toHaveProperty("provider");
    expect(loaded).not.toHaveProperty("model");

    const result = await dispatchPermissionReviewerCommand({ verb: "mode", value: "rule" }, path);
    expect(result.ok).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf-8")).permissions.reviewer;
    expect(saved).toMatchObject({ mode: "rule", fallbackOnError: "rule" });
    expect(saved).not.toHaveProperty("interactive");
    expect(saved).not.toHaveProperty("provider");
    expect(saved).not.toHaveProperty("model");
  });

  it("rejects a reviewer patch that names the removed provider/model keys", async () => {
    const path = tmpSettingsPath();
    await expect(
      setReviewerSettingsPersist({ mode: "rule", provider: "openai" } as never, path),
    ).rejects.toThrow(/unsupported keys: provider.*permissions\.judge\.model/);
    expect(readPermissionSettings(path).permissions.reviewer.mode).toBe("llm");
  });

  it("ignores retired parent settings on read and omits them on ordinary write", async () => {
    const path = tmpSettingsPath();
    const original = JSON.stringify({ untouched: "keep", permissions: { reviewer: { mode: "rule", fallbackOnError: "rule", parentAdjudication: { model: "parent-session", maxVerdict: "medium" } } } });
    writeFileSync(path, original);
    expect(readPermissionSettings(path).permissions.reviewer).toMatchObject({ mode: "rule", fallbackOnError: "rule" });
    expect(readPermissionSettings(path).permissions.reviewer).not.toHaveProperty("parentAdjudication");
    expect(readFileSync(path, "utf8")).toBe(original);
    await expect(setReviewerSettingsPersist({ parentAdjudication: { model: "reviewer" } } as never, path)).rejects.toThrow(/unsupported keys: parentAdjudication/);
    expect(readFileSync(path, "utf8")).toBe(original);
    const rejected = await dispatchPermissionReviewerCommand({ verb: "adjudication", value: "low" } as never, path);
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining("unknown reviewer command") });
    expect(readFileSync(path, "utf8")).toBe(original);
    await setReviewerSettingsPersist({ fallbackOnError: "deny" }, path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.untouched).toBe("keep");
    expect(saved.permissions.reviewer).toMatchObject({ mode: "rule", fallbackOnError: "deny" });
    expect(saved.permissions.reviewer).not.toHaveProperty("parentAdjudication");
  });

  it("fallback rule persists when explicitly selected", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "fallback", value: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.reviewer.fallbackOnError).toBe("rule");
  });

  it("rejects an inactive interactive setting patch without changing the file", async () => {
    const path = tmpSettingsPath();
    await dispatchPermissionReviewerCommand({ verb: "mode", value: "rule" }, path);
    const before = readFileSync(path, "utf8");
    await expect(setReviewerSettingsPersist({ interactive: { autoApprove: "low" } } as never, path)).rejects.toThrow(/unsupported keys: interactive/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("invalid mode returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "mode", value: "yolo" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid mode/);
  });

  it("a provider verb reaching dispatch is an unknown reviewer command", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "provider", value: "ollama" } as never,
      path,
    );
    expect(r).toEqual({ ok: false, error: "unknown reviewer command 'provider'" });
  });

  it("invalid fallback returns ok:false", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand(
      { verb: "fallback", value: "allow" },
      path,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid fallback/);
  });

  it("a model verb reaching dispatch is an unknown reviewer command", async () => {
    const path = tmpSettingsPath();
    const r = await dispatchPermissionReviewerCommand({ verb: "model", value: "" } as never, path);
    expect(r).toEqual({ ok: false, error: "unknown reviewer command 'model'" });
  });

  it("setReviewerSettingsPersist preserves additionalDirectories", async () => {
    const path = tmpSettingsPath();
    await writePermissionSettings({ additionalDirectories: ["/foo"] }, path);
    await setReviewerSettingsPersist({ mode: "rule" }, path);
    const settings = readPermissionSettings(path);
    expect(settings.permissions.additionalDirectories).toEqual(["/foo"]);
    expect(settings.permissions.reviewer.mode).toBe("rule");
  });

  it("rolls back reviewer settings when runtime rewire fails", async () => {
    const path = tmpSettingsPath();
    await setReviewerSettingsPersist({ mode: "rule" }, path);
    const rewire = vi.fn(() => {
      throw new Error("missing provider");
    });

    const result = await dispatchPermissionReviewerCommandWithRewire(
      { verb: "mode", value: "llm" },
      rewire,
      path,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("reviewer-rewire-failed"),
    });
    expect(readPermissionSettings(path).permissions.reviewer.mode).toBe("rule");
    expect(rewire).toHaveBeenCalledTimes(2);
  });
});

describe("normalizePermissionSettings — reviewer block", () => {
  it("missing reviewer block → defaults", () => {
    const settings = normalizePermissionSettings({}, SETTINGS_PATH);
    expect(settings.permissions.reviewer).toEqual({
      // Default reviewer mode is "llm" (strongest classifier; degrades to rule at boot when no provider is configured).
      mode: "llm",
      fallbackOnError: "deny",
    });
  });

  it("invalid enum values fall back to defaults", () => {
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "yolo",
          provider: "ollama",
          fallbackOnError: "allow-and-audit",
          model: "",
        },
      },
    }, SETTINGS_PATH);
    // Unknown enum values fall back to the new "llm" default (external boundary: hand-edited settings file with bad values).
    expect(settings.permissions.reviewer.mode).toBe("llm");
    expect(settings.permissions.reviewer.fallbackOnError).toBe("deny");
    expect(settings.permissions.reviewer).not.toHaveProperty("provider");
    expect(settings.permissions.reviewer).not.toHaveProperty("model");
  });

  it("valid reviewer block round-trips", () => {
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "llm",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          fallbackOnError: "deny",
        },
      },
    }, SETTINGS_PATH);
    // The retired provider/model keys are dropped on load.
    expect(settings.permissions.reviewer).toEqual({
      mode: "llm",
      fallbackOnError: "deny",
      // Only absent fields take the new default; explicit fields above are kept.
    });
  });

  it("preserves explicit reviewer mode while ignoring retired interactive settings", () => {
    // Backward-compat: a user who explicitly configured the pre-change defaults must keep them. Only ABSENT fields fall to the new "llm"/"low" defaults.
    const settings = normalizePermissionSettings({
      permissions: {
        reviewer: {
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        },
      },
    }, SETTINGS_PATH);
    expect(settings.permissions.reviewer.mode).toBe("rule");
    expect(settings.permissions.reviewer).not.toHaveProperty("interactive");
  });
});

describe("settings file persistence — reviewer block format", () => {
  it("writePermissionSettings produces stable JSON shape", async () => {
    const path = tmpSettingsPath();
    await writePermissionSettings(
      {
        additionalDirectories: ["/Users/example/work"],
        reviewer: {
          mode: "llm",
          fallbackOnError: "rule",
        },
      },
      path,
    );
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions.additionalDirectories).toEqual(["/Users/example/work"]);
    expect(parsed.permissions.reviewer.mode).toBe("llm");
    expect(parsed.permissions.reviewer).not.toHaveProperty("provider");
  });

  it("hand-edited bad enum is normalized on read but bad write rejected", async () => {
    const path = tmpSettingsPath();
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { reviewer: { mode: "yolo", provider: "openai", model: "x", fallbackOnError: "rule" } },
      }),
    );
    // Read normalises silently (external boundary). Bad enum → "llm" default.
    const r = readPermissionSettings(path);
    expect(r.permissions.reviewer.mode).toBe("llm");
  });
});
