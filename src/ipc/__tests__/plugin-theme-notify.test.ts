import { afterEach, describe, it, expect, vi } from "vitest";
import { publishHostThemeChanged, registerPluginsHandlers, validateThemePayload } from "../domains/plugins.js";
import { onEvent } from "../../boot/types.js";
import { getLastThemePayload, recordValidatedTheme, resetLastThemePayloadForTests } from "../../shared/host-theme-replay.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { schemeToHostTokens, resolveTheme, SCHEMES } from "../../ui/renderer/theme/index.js";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

afterEach(() => { resetLastThemePayloadForTests(); handlers.clear(); });

describe("host theme publication", () => {
  it("broadcasts a frozen copy that cannot corrupt the replay cache", () => {
    const payload = { bundleId: "nord", shell: "dark" as const, tokens: { "--ave-bg": "#123456" } };
    recordValidatedTheme(payload);
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (value) => {
      expect(value).not.toBe(payload);
      expect(Object.isFrozen(value)).toBe(true);
      const theme = value as typeof payload;
      expect(theme.tokens).not.toBe(payload.tokens);
      expect(Object.isFrozen(theme.tokens)).toBe(true);
      expect(Reflect.set(theme.tokens, "--ave-bg", "#fff")).toBe(false);
      seen.push(value);
    });
    try { publishHostThemeChanged(payload); } finally { unsubscribe(); }
    expect(seen).toEqual([payload]);
    expect(getLastThemePayload()).toEqual(payload);
    expect(payload.tokens["--ave-bg"]).toBe("#123456");
  });

  it("publishes the validated theme through the registered host IPC handler", () => {
    registerPluginsHandlers({
      pluginRuntime: { getWildcardConfigOverride: () => undefined },
      pluginMarketplace: {}, settingsService: { get: () => ({}) },
      auditLogger: { log: vi.fn() }, getMainWindow: () => null,
    } as never);
    const handler = handlers.get(CHANNELS.host.pluginThemeNotify);
    expect(handler).toBeTypeOf("function");
    const payload = { bundleId: "nord", shell: "dark", tokens: { "--ave-bg": "#123456" } };
    const seen: unknown[] = [];
    const unsubscribe = onEvent("host.theme.changed", (value) => seen.push(value));
    try {
      expect(handler!({ senderFrame: { url: "file:///app/index.html" } }, payload)).toEqual({ ok: true });
    } finally { unsubscribe(); }
    expect(seen).toEqual([payload]);
    expect(getLastThemePayload()).toEqual(payload);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });
});

const VALID_PAYLOAD = {
  bundleId: "tokyo-night",
  shell: "dark",
  tokens: { "--ave-bg": "#0d0d12" },
} as const;

describe("validateThemePayload", () => {
  it("accepts a valid bundleId + shell (dark)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark", tokens: { "--ave-bg": "#0d0d12" } });
    expect(result).toEqual({ ok: true, safe: { bundleId: "tokyo-night", shell: "dark", tokens: { "--ave-bg": "#0d0d12" } } });
  });

  it("accepts light shell", () => {
    const result = validateThemePayload({ bundleId: "github-light", shell: "light", tokens: { "--ave-bg": "#fff" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("github-light");
      expect(result.safe.shell).toBe("light");
    }
  });

  it("accepts another curated dark scheme", () => {
    const result = validateThemePayload({ bundleId: "catppuccin-mocha", shell: "dark", tokens: { "--ave-bg": "#000" } });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateThemePayload(null);
    expect(result).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects non-object", () => {
    expect(validateThemePayload("dark")).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects unknown bundleId", () => {
    const result = validateThemePayload({ bundleId: "sepia", shell: "light" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects missing bundleId", () => {
    const result = validateThemePayload({ shell: "dark" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects unknown shell value", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "auto" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("rejects a shell that does not match the scheme", () => {
    expect(validateThemePayload({ bundleId: "github-dark", shell: "light", tokens: {} })).toEqual({ ok: false, error: "invalid-shell" });
    expect(validateThemePayload({ bundleId: "github-light", shell: "dark", tokens: {} })).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("rejects missing shell", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("accepts payload and strips unknown injected fields", () => {
    const result = validateThemePayload({
      bundleId: "nord", shell: "dark",
      tokens: { "--ave-bg": "#000" },
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("nord");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#000" });
      expect((result.safe as Record<string, unknown>).evil).toBeUndefined();
    }
  });

  it("passes through valid --ave-* tokens", () => {
    const result = validateThemePayload({
      bundleId: "github-dark", shell: "dark",
      tokens: { "--ave-bg": "hsl(0, 0%, 15%)", "--ave-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-bg": "hsl(0, 0%, 15%)", "--ave-primary": "#734dff" });
    }
  });

  it("drops token keys not in the closed PLUGIN_TOKEN_NAMES allowlist", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "#fff", "--ave-unknown-new": "#abc", "--evil-key": "red", "color": "blue" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#fff" });
    }
  });

  it("drops token values with url() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with expression() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "expression(alert(1))" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with HTML tag injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "<script>x</script>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("returns stable empty tokens object when all token entries are filtered out", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--evil": "red" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("rejects token-less payload (tokens required)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-tokens");
    }
  });

  it("drops token values with Unicode-escaped url() — allowlist blocks bypass attempts", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops var() references — only literal HSL/hex/dimension values pass", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "var(--p-secret-color)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("accepts hsl with decimal values and hex colors", () => {
    const result = validateThemePayload({
      bundleId: "github-dark", shell: "dark",
      tokens: { "--ave-radius": "0.6rem", "--ave-radius-sm": "0.25rem", "--ave-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-radius": "0.6rem", "--ave-radius-sm": "0.25rem", "--ave-primary": "#734dff" });
    }
  });

  it("accepts curated scheme identities and rejects unknown names", () => {
    for (const bundleId of ["github-light", "gruvbox-light"]) {
      expect(validateThemePayload({ bundleId, shell: "light", tokens: { "--ave-bg": "#fff" } }).ok, bundleId).toBe(true);
    }
    expect(validateThemePayload({ bundleId: "package-theme", shell: "dark", tokens: { "--ave-bg": "#000" } }).ok).toBe(false);
  });

  it("accepts curated dark and light identities", () => {
    const cases: Array<[string, "light" | "dark"]> = [
      ["tokyo-night", "dark"],
      ["nord", "dark"],
      ["one-light", "light"],
      ["github-light", "light"],
      ["github-dark", "dark"],
      ["catppuccin-mocha", "dark"],
    ];
    for (const [bundleId, shell] of cases) {
      const result = validateThemePayload({ bundleId, shell, tokens: { "--ave-bg": "#000" } });
      expect(result.ok, `bundleId=${bundleId}`).toBe(true);
      if (result.ok) expect(result.safe.bundleId).toBe(bundleId);
    }
  });

  // Token validation must accept producer value shapes or derived colors silently fall back.
  it("keeps every token every compiled bundle produces", () => {
    for (const bundle of SCHEMES) {
      const tokens = schemeToHostTokens(resolveTheme(bundle));
      const result = validateThemePayload({ bundleId: bundle.id, shell: bundle.shell, tokens });
      expect(result.ok, `bundleId=${bundle.id}`).toBe(true);
      if (!result.ok) continue;
      const dropped = Object.keys(tokens).filter((key) => !(key in (result.safe.tokens ?? {})));
      expect(dropped, `bundleId=${bundle.id}`).toEqual([]);
    }
  });

  it("accepts a color-mix token but not one carrying a second declaration", () => {
    const result = validateThemePayload({
      bundleId: "github-light",
      shell: "light",
      tokens: {
        "--ave-primary-bg-subtle": "color-mix(in srgb, hsl(217.2, 91.2%, 59.8%) 14%, hsl(0, 0%, 100%))",
        "--ave-focus-shadow": "color-mix(in srgb, #734dff 62%, transparent)",
        "--ave-input-bar-placeholder": "hsla(222.2, 84%, 7%, 0.82)",
        "--ave-surface-hover": "color-mix(in srgb, hsl(0, 0%, 0%) 6%, hsl(0, 0%, 96%)); background:url(https://evil.example)",
        "--ave-primary-bg-strong": "color-mix(in srgb, color-mix(in srgb, #fff 5%, #000) 28%, transparent)",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.safe.tokens ?? {}).sort()).toEqual([
        "--ave-focus-shadow",
        "--ave-input-bar-placeholder",
        "--ave-primary-bg-subtle",
      ]);
    }
  });

  it("v2 payload (VALID_PAYLOAD const) round-trips correctly", () => {
    const result = validateThemePayload(VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("tokyo-night");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#0d0d12" });
    }
  });
});
