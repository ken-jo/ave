/**
 * Installed content as the app applies it (blueprint P3): the loaded store
 * turned into what the renderer's pickers list, the language catalogs, and
 * the files the `ave-content:` scheme may serve.
 *
 * Two packages may not claim the same locale or font family. Installing a
 * second one is refused; should a ledger hold two anyway, the first in ledger
 * order is applied and the second is listed as broken, so which one wins
 * never depends on load timing.
 */
import { join } from "node:path";
import {
  contentAssetUrl,
  installedFontStack,
  type BrokenContentView,
  type InstalledContentView,
  type InstalledFontView,
  type InstalledLanguageView,
  type InstalledThemeView,
} from "../../shared/installed-content.js";
import type { ContentStore, LoadedContent } from "./store.js";

const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const FONT_TYPES: Readonly<Record<string, string>> = { woff2: "font/woff2", woff: "font/woff", truetype: "font/ttf", opentype: "font/otf" };

export interface ServedContentFile {
  path: string;
  contentType: string;
}

export class InstalledContentService {
  private view: InstalledContentView = { themes: [], languages: [], fonts: [], broken: [] };
  private catalogs = new Map<string, Record<string, string>>();
  /** `<kind>/<name>/<path>` → the file and its type, for the asset scheme. */
  private served = new Map<string, ServedContentFile>();

  constructor(private readonly store: ContentStore) {}

  /** Re-read the store and rebuild everything derived from it. */
  async reload(): Promise<InstalledContentView> {
    const { loaded, broken } = await this.store.load();
    const themes: InstalledThemeView[] = [];
    const languages: InstalledLanguageView[] = [];
    const fonts: InstalledFontView[] = [];
    const brokenViews: BrokenContentView[] = broken.map(({ entry, problem }) => ({ kind: entry.kind, name: entry.name, problem }));
    const catalogs = new Map<string, Record<string, string>>();
    const served = new Map<string, ServedContentFile>();
    const from = (item: LoadedContent) => ({ sourceId: item.entry.origin.sourceId, version: item.entry.version });
    const refuse = (item: LoadedContent, problem: string) => brokenViews.push({ kind: item.entry.kind, name: item.entry.name, problem });

    for (const item of loaded) {
      const { content, entry, dir } = item;
      if (content.kind === "theme") {
        let previewUrl: string | undefined;
        if (content.preview) {
          const type = IMAGE_TYPES[content.preview.slice(content.preview.lastIndexOf(".")).toLowerCase()];
          if (type) {
            served.set(`theme/${entry.name}/${content.preview}`, { path: join(dir, ...content.preview.split("/")), contentType: type });
            previewUrl = contentAssetUrl("theme", entry.name, content.preview);
          }
        }
        themes.push({
          id: entry.name,
          name: content.name,
          description: content.description,
          shell: content.shell,
          highContrast: content.highContrast,
          tokens: content.tokens,
          surfaces: content.surfaces,
          ...(previewUrl ? { previewUrl } : {}),
          ...from(item),
        });
      } else if (content.kind === "language") {
        const holder = languages.find((language) => language.locale === content.locale);
        if (holder) {
          refuse(item, `${holder.name} already provides ${content.locale}`);
          continue;
        }
        catalogs.set(content.locale, content.messages);
        languages.push({
          name: entry.name,
          locale: content.locale,
          nativeName: content.nativeName,
          englishName: content.englishName,
          missingKeys: content.missingKeys,
          ...from(item),
        });
      } else if (content.kind === "font") {
        const holder = fonts.find((font) => font.family === content.family);
        if (holder) {
          refuse(item, `${holder.name} already provides the ${content.family} family`);
          continue;
        }
        for (const face of content.faces) {
          served.set(`font/${entry.name}/${face.file}`, { path: join(dir, ...face.file.split("/")), contentType: FONT_TYPES[face.format]! });
        }
        fonts.push({
          name: entry.name,
          family: content.family,
          stack: installedFontStack(entry.name),
          faces: content.faces.map((face) => ({ url: contentAssetUrl("font", entry.name, face.file), format: face.format, weight: face.weight, style: face.style })),
          ...from(item),
        });
      }
      // Providers and messaging connections take effect through settings (their activation).
    }
    this.view = { themes, languages, fonts, broken: brokenViews };
    this.catalogs = catalogs;
    this.served = served;
    return this.installed();
  }

  installed(): InstalledContentView {
    return structuredClone(this.view);
  }

  /** The catalog of an installed language; throws for a locale no package provides. */
  languageMessages(locale: string): Record<string, string> {
    const catalog = this.catalogs.get(locale);
    if (!catalog) throw new Error(`no installed language provides ${locale}`);
    return { ...catalog };
  }

  /**
   * The file behind `ave-content://<kind>/<name>/<path>`: only a theme's
   * preview image or a listed font face of an applied package. Null for
   * anything else.
   */
  servedFile(kind: string, name: string, path: string): ServedContentFile | null {
    return this.served.get(`${kind}/${name}/${path}`) ?? null;
  }
}
