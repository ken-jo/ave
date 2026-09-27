/**
 * What the renderer is told about installed content packages (blueprint P3):
 * the themes, languages and fonts the settings pickers list. Provider presets
 * and messaging connections reach the renderer through settings, as they do
 * today.
 *
 * Images and fonts are served through the `ave-content:` host scheme
 * (design §5.4), never by file path. Every asset URL carries a random token
 * the main process draws at launch as its host, so only a page the app gave
 * the URL to can name an installed file.
 *
 * No process-specific imports: main, preload and renderer load it.
 */
import { HOST_FONT_STACK } from "./host-font-stack.js";
import type { ThemeSurfaces, ThemeTokens } from "./theme-tokens.js";
import type { AgentPluginRoutineTemplate } from "./agent-plugin-routine-template.js";

export const CONTENT_ASSET_SCHEME = "ave-content";

/**
 * The launch token's form: `t` and 32 lowercase hex characters. The letter
 * keeps a token that happens to be all digits from reading as an IPv4 host.
 */
export const CONTENT_ASSET_TOKEN = /^t[0-9a-f]{32}$/u;

/** `ave-content://<token>/<kind>/<name>/<package-relative path>` for a file of an installed package. */
export function contentAssetUrl(token: string, kind: "theme" | "font", name: string, path: string): string {
  return `${CONTENT_ASSET_SCHEME}://${token}/${kind}/${name}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Whether `url` is an asset URL of `kind` in the form {@link contentAssetUrl} writes. */
export function isContentAssetUrl(url: string, kind: "theme" | "font"): boolean {
  const prefix = `${CONTENT_ASSET_SCHEME}://`;
  if (!url.startsWith(prefix)) return false;
  const [token, urlKind] = url.slice(prefix.length).split("/");
  return token !== undefined && CONTENT_ASSET_TOKEN.test(token) && urlKind === kind;
}

interface InstalledFrom {
  sourceId: string;
  version: string;
}

export interface InstalledThemeView extends InstalledFrom {
  /** The package name; what `appearance.bundleId` holds while the theme is selected. */
  id: string;
  name: string;
  description: string;
  shell: "light" | "dark";
  highContrast: boolean;
  tokens: ThemeTokens;
  surfaces: ThemeSurfaces;
  previewUrl?: string;
  /** The theme of the other shell `followSystem` switches to with this one. */
  pair?: string;
}

export interface InstalledLanguageView extends InstalledFrom {
  /** The package name. */
  name: string;
  /** BCP 47 tag; what `settings.language` holds while the language is selected. */
  locale: string;
  nativeName: string;
  englishName: string;
  /** English keys the catalog does not translate; they show in English. */
  missingKeys: string[];
}

export type FontFormat = "woff2" | "woff" | "truetype" | "opentype";

interface InstalledFontFace {
  url: string;
  format: FontFormat;
  /** CSS `font-weight`: one weight, or a `min max` range for a variable font. */
  weight: string;
  style: "normal" | "italic";
}

export interface InstalledFontView extends InstalledFrom {
  /** The package name. */
  name: string;
  /** The family name the package declares; a label only (see {@link fontAlias}). */
  family: string;
  /** The `appearance.font.family` value that selects this font. */
  stack: string;
  faces: InstalledFontFace[];
}

/** A ledger entry whose files no longer pass validation; listed, never applied. */
export interface BrokenContentView {
  kind: string;
  name: string;
  problem: string;
}

export interface InstalledContentView {
  themes: InstalledThemeView[];
  languages: InstalledLanguageView[];
  fonts: InstalledFontView[];
  routineTemplates: AgentPluginRoutineTemplate[];
  broken: BrokenContentView[];
}

/**
 * The CSS family an installed font package's faces are declared under. It is
 * derived from the package name, not the family the package declares, so a
 * package cannot shadow a system font or another package's family, and two
 * packages never share a selection.
 */
export function fontAlias(packageName: string): string {
  return `ave-font-${packageName}`;
}

/** The font stack an installed font package is selected with: its alias first, the host stack after it. */
export function installedFontStack(packageName: string): string {
  return `"${fontAlias(packageName)}", ${HOST_FONT_STACK}`;
}

export type InstalledContentResult =
  | { ok: true; content: InstalledContentView }
  | { ok: false; error: string; message?: string };

export type LanguageMessagesResult =
  | { ok: true; messages: Record<string, string> }
  | { ok: false; error: string; message?: string };

/** `window.aveApi.installedContent` (host renderer only). */
export interface InstalledContentApi {
  installed(): Promise<InstalledContentResult>;
  languageMessages(locale: string): Promise<LanguageMessagesResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The IPC answer as the renderer may use it, or null when it is not one. */
export function parseInstalledContentResult(value: unknown): InstalledContentResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false) return typeof value.error === "string" ? { ok: false, error: value.error } : null;
  const content = value.content;
  if (value.ok !== true || !isRecord(content)) return null;
  const lists = ["themes", "languages", "fonts", "routineTemplates", "broken"] as const;
  if (!lists.every((key) => Array.isArray(content[key]))) return null;
  return { ok: true, content: content as unknown as InstalledContentView };
}

export function parseLanguageMessagesResult(value: unknown): LanguageMessagesResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false) return typeof value.error === "string" ? { ok: false, error: value.error } : null;
  if (value.ok !== true || !isRecord(value.messages)) return null;
  const messages = value.messages;
  if (!Object.values(messages).every((message) => typeof message === "string")) return null;
  return { ok: true, messages: messages as Record<string, string> };
}
