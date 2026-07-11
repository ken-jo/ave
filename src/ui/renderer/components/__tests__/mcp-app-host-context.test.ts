import { describe, expect, it } from "vitest";
// Upstream type imported for the anti-drift PIN below. Type-only, so it is erased
// at build time (the package's extensionless re-exports never resolve under
// NodeNext, which is exactly why `mcp-app-host-context.ts` re-declares the twin).
import type { McpUiHostContext as UpstreamMcpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { buildMcpAppHostContext } from "../mcp-app-host-context.js";
import type { McpUiHostContext } from "../mcp-app-host-context.js";

// A representative subset of the curated `--ave-*` token map (values are the
// resolved CSS strings `bundleToPluginTokens` produces). Deliberately omits some
// tokens (e.g. `--ave-warning`) to exercise "emit only present keys".
const LIGHT_TOKENS: Record<string, string> = {
  "--ave-bg": "hsl(0, 0%, 100%)",
  "--ave-surface": "hsl(0, 0%, 98%)",
  "--ave-surface-overlay": "hsl(0, 0%, 96%)",
  "--ave-fg": "hsl(222, 47%, 11%)",
  "--ave-fg-muted": "hsl(215, 16%, 47%)",
  "--ave-fg-disabled": "hsl(215, 16%, 65%)",
  "--ave-border": "hsl(214, 32%, 91%)",
  "--ave-primary": "hsl(217, 91%, 60%)",
  "--ave-primary-fg": "hsl(0, 0%, 100%)",
  "--ave-ring": "hsl(217, 91%, 60%)",
  "--ave-danger": "hsl(0, 84%, 60%)",
  "--ave-danger-fg": "hsl(0, 0%, 100%)",
  "--ave-success": "hsl(142, 71%, 45%)",
  "--ave-success-fg": "hsl(0, 0%, 100%)",
  "--ave-radius": "0.6rem",
  "--ave-radius-full": "9999px",
  "--ave-text-base": "1rem",
  "--ave-text-lg": "1.125rem",
  "--ave-weight-semibold": "600",
};

const DARK_TOKENS: Record<string, string> = {
  "--ave-bg": "hsl(222, 84%, 5%)",
  "--ave-fg": "hsl(210, 40%, 98%)",
  "--ave-primary": "hsl(217, 91%, 60%)",
  "--ave-ring": "hsl(217, 91%, 65%)",
};

describe("buildMcpAppHostContext", () => {
  it("maps the light shell + locale/timeZone/platform to standard fields", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "America/New_York",
    });

    expect(ctx.theme).toBe("light");
    expect(ctx.locale).toBe("en");
    expect(ctx.timeZone).toBe("America/New_York");
    expect(ctx.platform).toBe("desktop");
    expect(ctx.deviceCapabilities).toEqual({ hover: true, touch: false });
  });

  it("maps the dark shell to theme=dark", () => {
    const ctx = buildMcpAppHostContext({
      shell: "dark",
      tokens: DARK_TOKENS,
      locale: "ko",
      timeZone: "Asia/Seoul",
    });

    expect(ctx.theme).toBe("dark");
    expect(ctx.locale).toBe("ko");
    expect(ctx.timeZone).toBe("Asia/Seoul");
  });

  it("translates Ave tokens to the standard style-variable vocabulary", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    // Neutrals
    expect(variables["--color-background-primary"]).toBe(LIGHT_TOKENS["--ave-bg"]);
    expect(variables["--color-background-secondary"]).toBe(LIGHT_TOKENS["--ave-surface"]);
    expect(variables["--color-background-tertiary"]).toBe(LIGHT_TOKENS["--ave-surface-overlay"]);
    expect(variables["--color-text-primary"]).toBe(LIGHT_TOKENS["--ave-fg"]);
    expect(variables["--color-text-secondary"]).toBe(LIGHT_TOKENS["--ave-fg-muted"]);
    expect(variables["--color-text-disabled"]).toBe(LIGHT_TOKENS["--ave-fg-disabled"]);
    expect(variables["--color-border-primary"]).toBe(LIGHT_TOKENS["--ave-border"]);

    // Accent → info bucket, and inverse text for the on-accent foreground.
    expect(variables["--color-background-info"]).toBe(LIGHT_TOKENS["--ave-primary"]);
    expect(variables["--color-text-inverse"]).toBe(LIGHT_TOKENS["--ave-primary-fg"]);

    // Status (1:1)
    expect(variables["--color-background-danger"]).toBe(LIGHT_TOKENS["--ave-danger"]);
    expect(variables["--color-text-danger"]).toBe(LIGHT_TOKENS["--ave-danger-fg"]);
    expect(variables["--color-background-success"]).toBe(LIGHT_TOKENS["--ave-success"]);
    expect(variables["--color-text-success"]).toBe(LIGHT_TOKENS["--ave-success-fg"]);

    // Radius + fonts
    expect(variables["--border-radius-md"]).toBe(LIGHT_TOKENS["--ave-radius"]);
    expect(variables["--border-radius-full"]).toBe(LIGHT_TOKENS["--ave-radius-full"]);
    expect(variables["--font-text-md-size"]).toBe(LIGHT_TOKENS["--ave-text-base"]);
    expect(variables["--font-text-lg-size"]).toBe(LIGHT_TOKENS["--ave-text-lg"]);
    expect(variables["--font-weight-semibold"]).toBe(LIGHT_TOKENS["--ave-weight-semibold"]);
  });

  it("fans the focus ring out to BOTH the primary and info standard ring keys", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "dark",
      tokens: DARK_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    expect(variables["--color-ring-primary"]).toBe(DARK_TOKENS["--ave-ring"]);
    expect(variables["--color-ring-info"]).toBe(DARK_TOKENS["--ave-ring"]);
  });

  it("emits ONLY standard keys — never a proprietary --ave-* name", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const keys = Object.keys(styles?.variables ?? {});

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("--ave-")).toBe(false);
    }
    // Every emitted key is a standard ext-apps variable (starts with one of the
    // fixed prefixes), never a bespoke bucket.
    for (const key of keys) {
      expect(
        key.startsWith("--color-") ||
          key.startsWith("--font-") ||
          key.startsWith("--border-") ||
          key.startsWith("--shadow-"),
      ).toBe(true);
    }
  });

  it("emits only keys whose source token is present", () => {
    const { styles } = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    const variables = styles?.variables ?? {};

    // LIGHT_TOKENS has no `--ave-warning`, so its standard key must be absent.
    expect(variables["--color-background-warning"]).toBeUndefined();
    expect("--color-background-warning" in variables).toBe(false);
  });

  it("maps --ave-font-family to --font-sans only when the caller threads it in", () => {
    const withFamily = buildMcpAppHostContext({
      shell: "light",
      tokens: { ...LIGHT_TOKENS, "--ave-font-family": "Inter, sans-serif" },
      locale: "en",
      timeZone: "UTC",
    });
    expect(withFamily.styles?.variables?.["--font-sans"]).toBe("Inter, sans-serif");

    const withoutFamily = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });
    expect(withoutFamily.styles?.variables?.["--font-sans"]).toBeUndefined();
  });

  it("omits styles entirely when no tokens are provided", () => {
    const ctx = buildMcpAppHostContext({
      shell: "light",
      tokens: {},
      locale: "en",
      timeZone: "UTC",
    });

    expect(ctx.styles).toBeUndefined();
    // Non-style fields still populate.
    expect(ctx.theme).toBe("light");
    expect(ctx.platform).toBe("desktop");
  });

  it("local McpUiHostContext twin stays structurally compatible with upstream", () => {
    const built = buildMcpAppHostContext({
      shell: "light",
      tokens: LIGHT_TOKENS,
      locale: "en",
      timeZone: "UTC",
    });

    // Type-level PIN (erased at runtime): the local twin must be assignable BOTH
    // ways with the upstream `McpUiHostContext`. If ext-apps renames/retypes a
    // field, the local twin in mcp-app-host-context.ts must be updated to match.
    const asUpstream: UpstreamMcpUiHostContext = built;
    const asLocal: McpUiHostContext = asUpstream;

    expect(asLocal.theme).toBe("light");
  });
});
