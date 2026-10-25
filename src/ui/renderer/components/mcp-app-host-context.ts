/** Translate host theme tokens into standard MCP UI style variables; proprietary tokens must not leak to guests. */

// `McpUiDisplayMode` is the ONE standard type NOT re-declared below: the host's
// supported SET (`MCP_APP_AVAILABLE_DISPLAY_MODES`) and the predicate the
// `onrequestdisplaymode` handler checks a request against are the same fact as the
// `availableDisplayModes` this module publishes, so the type and those values share a
// single SoT module (repo-local — no package import, so the module stays portable).
import {
  MCP_APP_AVAILABLE_DISPLAY_MODES,
  type McpUiDisplayMode,
} from "../../../shared/mcp-app-display-mode.js";

export type { McpUiDisplayMode };

/** @see ext-apps `McpUiTheme` */
export type McpUiTheme = "light" | "dark";

/**
 * The FIXED standard CSS-variable vocabulary exposed to MCP apps.
 * @see ext-apps `McpUiStyleVariableKey` (copied verbatim — order irrelevant).
 */
export type McpUiStyleVariableKey =
  | "--color-background-primary"
  | "--color-background-secondary"
  | "--color-background-tertiary"
  | "--color-background-inverse"
  | "--color-background-ghost"
  | "--color-background-info"
  | "--color-background-danger"
  | "--color-background-success"
  | "--color-background-warning"
  | "--color-background-disabled"
  | "--color-text-primary"
  | "--color-text-secondary"
  | "--color-text-tertiary"
  | "--color-text-inverse"
  | "--color-text-ghost"
  | "--color-text-info"
  | "--color-text-danger"
  | "--color-text-success"
  | "--color-text-warning"
  | "--color-text-disabled"
  | "--color-border-primary"
  | "--color-border-secondary"
  | "--color-border-tertiary"
  | "--color-border-inverse"
  | "--color-border-ghost"
  | "--color-border-info"
  | "--color-border-danger"
  | "--color-border-success"
  | "--color-border-warning"
  | "--color-border-disabled"
  | "--color-ring-primary"
  | "--color-ring-secondary"
  | "--color-ring-inverse"
  | "--color-ring-info"
  | "--color-ring-danger"
  | "--color-ring-success"
  | "--color-ring-warning"
  | "--font-sans"
  | "--font-mono"
  | "--font-weight-normal"
  | "--font-weight-medium"
  | "--font-weight-semibold"
  | "--font-weight-bold"
  | "--font-text-xs-size"
  | "--font-text-sm-size"
  | "--font-text-md-size"
  | "--font-text-lg-size"
  | "--font-heading-xs-size"
  | "--font-heading-sm-size"
  | "--font-heading-md-size"
  | "--font-heading-lg-size"
  | "--font-heading-xl-size"
  | "--font-heading-2xl-size"
  | "--font-heading-3xl-size"
  | "--font-text-xs-line-height"
  | "--font-text-sm-line-height"
  | "--font-text-md-line-height"
  | "--font-text-lg-line-height"
  | "--font-heading-xs-line-height"
  | "--font-heading-sm-line-height"
  | "--font-heading-md-line-height"
  | "--font-heading-lg-line-height"
  | "--font-heading-xl-line-height"
  | "--font-heading-2xl-line-height"
  | "--font-heading-3xl-line-height"
  | "--border-radius-xs"
  | "--border-radius-sm"
  | "--border-radius-md"
  | "--border-radius-lg"
  | "--border-radius-xl"
  | "--border-radius-full"
  | "--border-width-regular"
  | "--shadow-hairline"
  | "--shadow-sm"
  | "--shadow-md"
  | "--shadow-lg";

/** @see ext-apps `McpUiStyles` — hosts MAY provide any subset. */
export type McpUiStyles = Record<McpUiStyleVariableKey, string | undefined>;

/** @see ext-apps `McpUiHostStyles` */
export interface McpUiHostStyles {
  variables?: McpUiStyles;
  css?: { fonts?: string };
}

/**
 * @see ext-apps `McpUiHostContext`.
 * Only the fields this host populates are declared explicitly; the `[key: string]`
 * index signature carries the rest of the standard (and forward-compat) surface.
 */
export interface McpUiHostContext {
  /** Forward-compat: hosts MAY carry additional standard fields. */
  [key: string]: unknown;
  theme?: McpUiTheme;
  styles?: McpUiHostStyles;
  /** How the card is presented RIGHT NOW — updated after every applied mode change. */
  displayMode?: McpUiDisplayMode;
  /** The modes the app may ask for. `ui/request-display-mode` honours exactly these. */
  availableDisplayModes?: McpUiDisplayMode[];
  locale?: string;
  timeZone?: string;
  platform?: "web" | "desktop" | "mobile";
  deviceCapabilities?: {
    touch?: boolean;
    hover?: boolean;
  };
}

/** Emit only present source tokens; map primary accent to standard info colors and both primary/info focus rings. */
const TOKEN_TO_STYLE_KEY: ReadonlyArray<readonly [string, McpUiStyleVariableKey]> = [
  // Neutrals
  ["--ave-bg", "--color-background-primary"],
  ["--ave-surface", "--color-background-secondary"],
  ["--ave-surface-overlay", "--color-background-tertiary"],
  ["--ave-fg", "--color-text-primary"],
  ["--ave-fg-muted", "--color-text-secondary"],
  ["--ave-fg-disabled", "--color-text-disabled"],
  ["--ave-border", "--color-border-primary"],
  // Accent — Ave "primary" brand → closest standard bucket is "info" (see note above).
  ["--ave-primary", "--color-background-info"],
  ["--ave-primary-fg", "--color-text-inverse"],
  ["--ave-ring", "--color-ring-primary"],
  ["--ave-ring", "--color-ring-info"],
  // Status (1:1)
  ["--ave-danger", "--color-background-danger"],
  ["--ave-danger-fg", "--color-text-danger"],
  ["--ave-warning", "--color-background-warning"],
  ["--ave-warning-fg", "--color-text-warning"],
  ["--ave-success", "--color-background-success"],
  ["--ave-success-fg", "--color-text-success"],
  ["--ave-radius-xs", "--border-radius-xs"],
  ["--ave-radius-sm", "--border-radius-sm"],
  ["--ave-radius", "--border-radius-md"],
  ["--ave-radius-lg", "--border-radius-lg"],
  ["--ave-radius-full", "--border-radius-full"],
  // Fonts
  ["--ave-text-xs", "--font-text-xs-size"],
  ["--ave-text-sm", "--font-text-sm-size"],
  ["--ave-text-base", "--font-text-md-size"],
  ["--ave-text-lg", "--font-text-lg-size"],
  ["--ave-weight-normal", "--font-weight-normal"],
  ["--ave-weight-medium", "--font-weight-medium"],
  ["--ave-weight-semibold", "--font-weight-semibold"],
  // Font family — only present when the user set a custom family (ThemeProvider writes `--ave-font-family` on the document
  // root). Absent from the curated bundle token map, so it is emitted only when the caller threads it in.
  ["--ave-font-family", "--font-sans"],
];

export interface McpAppHostContextInput {
  /** Active shell scheme (maps 1:1 to the standard `McpUiTheme`). */
  shell: "light" | "dark";
  /** Resolved `--ave-*` token → CSS value map (from `bundleToPluginTokens`). */
  tokens: Record<string, string>;
  /** BCP-47 language tag (e.g. "en", "ko"). */
  locale: string;
  /** IANA time zone (e.g. "America/New_York"). */
  timeZone: string;
  /**
   * The card's CURRENT display mode. McpAppView owns the renderer location
   * (inline, fullscreen, or PiP) and re-publishes the context through
   * `bridge.setHostContext(...)` after every applied change, which is how the
   * app learns the mode actually took effect.
   */
  displayMode: McpUiDisplayMode;
}

/** Translate Ave host theme + locale + timezone into the standard `McpUiHostContext`. Emits ONLY standard
 * `McpUiStyleVariableKey` style variables — never a `--ave-*` key. */
export function buildMcpAppHostContext(input: McpAppHostContextInput): McpUiHostContext {
  const { shell, tokens, locale, timeZone, displayMode } = input;

  const variables: Partial<Record<McpUiStyleVariableKey, string>> = {};
  for (const [source, target] of TOKEN_TO_STYLE_KEY) {
    const value = tokens[source];
    if (typeof value === "string" && value.length > 0) {
      variables[target] = value;
    }
  }

  const theme: McpUiTheme = shell;
  const context: McpUiHostContext = {
    theme,
    displayMode,
    // The host's advertised set — the SAME SoT the `onrequestdisplaymode` handler
    // checks a request against, so "what the app may ask for" and "what the host will
    // apply" are one fact. Copied (not aliased) so a guest-facing context object can
    // never hand out a reference to the host's frozen constant.
    availableDisplayModes: [...MCP_APP_AVAILABLE_DISPLAY_MODES],
    locale,
    timeZone,
    // Electron desktop host with a pointer, no touch.
    platform: "desktop",
    deviceCapabilities: { hover: true, touch: false },
  };

  if (Object.keys(variables).length > 0) {
    // `McpUiStyles` is declared `Record<key, string | undefined>` but the spec states hosts MAY provide any subset, so a
    // partial object is the intended shape. Narrow the accumulator to the standard type at this single point.
    context.styles = { variables: variables as McpUiStyles };
  }

  return context;
}
