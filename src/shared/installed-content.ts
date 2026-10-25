/** Serve installed assets through launch-token URLs, never filesystem paths; contracts stay process-neutral. */
import { HOST_FONT_STACK } from "./host-font-stack.js";
import type { ThemeSurfaces, ThemeTokens } from "./theme-tokens.js";
import type { AgentPluginRoutineTemplate } from "./agent-plugin-routine-template.js";
import { isRecord } from "./is-record.js";

export const CONTENT_ASSET_SCHEME = "ave-content";

/** Prefix the random hex host with a letter so numeric tokens cannot parse as IPv4 addresses. */
export const CONTENT_ASSET_TOKEN = /^t[0-9a-f]{32}$/u;

/** `ave-content://<token>/<kind>/<name>/<package-relative path>` for a file of an installed package. */
export function contentAssetUrl(token: string, kind: "theme" | "font", name: string, path: string): string {
  return `${CONTENT_ASSET_SCHEME}://${token}/${kind}/${name}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

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

/** Derive CSS family aliases from package names so packages cannot shadow system or sibling fonts. */
export function fontAlias(packageName: string): string {
  return `ave-font-${packageName}`;
}

/** Select the package alias first, followed by the host stack. */
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

/** Malformed IPC projections return null. */
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
