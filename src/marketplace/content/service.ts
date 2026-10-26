/** Duplicate locales or font families fail installation; corrupt ledgers apply the first claimant deterministically. */
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
import type { ContentKind } from "./rules.js";
import type { ParsedContent } from "./kinds.js";
import type { ContentStore, LoadedContent } from "./store.js";
import { parseAgentPluginRoutineTemplates } from "./agent-plugin-components.js";
import type { AgentPluginRoutineTemplate } from "../../shared/agent-plugin-routine-template.js";

const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const FONT_TYPES: Readonly<Record<string, string>> = { woff2: "font/woff2", woff: "font/woff", truetype: "font/ttf", opentype: "font/otf" };

export interface ServedContentFile {
  path: string;
  contentType: string;
}

export interface InstalledInstruction {
  kind: "skill" | "agent";
  name: string;
  dir: string;
}

export interface InstalledAgentPlugin {
  name: string;
  version: string;
  content: Extract<ParsedContent, { kind: "agent-plugin" }>;
}

export interface InstalledAgentPluginRuntime extends InstalledAgentPlugin {
  dir: string;
  generationId: string;
}

export class InstalledContentService {
  private view: InstalledContentView = { themes: [], languages: [], fonts: [], routineTemplates: [], broken: [] };
  private catalogs = new Map<string, Record<string, string>>();
  private served = new Map<string, ServedContentFile>();
  private instructions: InstalledInstruction[] = [];
  private agentPlugins: InstalledAgentPlugin[] = [];
  private agentPluginRuntime: InstalledAgentPluginRuntime[] = [];

  /** Revoked bound versions remain listed as broken and are never applied. */
  constructor(
    private readonly store: ContentStore,
    private readonly assetToken: string,
    private readonly revoked: (kind: ContentKind, name: string, version: string) => string | null,
  ) {}

  async reload(): Promise<InstalledContentView> {
    const { loaded, broken } = await this.store.load();
    const themes: InstalledThemeView[] = [];
    const languages: InstalledLanguageView[] = [];
    const fonts: InstalledFontView[] = [];
    const routineTemplates: AgentPluginRoutineTemplate[] = [];
    const brokenViews: BrokenContentView[] = broken.map(({ entry, problem }) => ({ kind: entry.kind, name: entry.name, problem }));
    const catalogs = new Map<string, Record<string, string>>();
    const served = new Map<string, ServedContentFile>();
    const instructions: InstalledInstruction[] = [];
    const agentPlugins: InstalledAgentPlugin[] = [];
    const agentPluginRuntime: InstalledAgentPluginRuntime[] = [];
    const from = (item: LoadedContent) => {
      if (item.entry.origin.sourceId === null) throw new Error(`${item.entry.kind} ${item.entry.name} has no catalog source`);
      return { sourceId: item.entry.origin.sourceId, version: item.entry.version };
    };
    const refuse = (item: LoadedContent, problem: string) => brokenViews.push({ kind: item.entry.kind, name: item.entry.name, problem });

    for (const item of loaded) {
      const { content, entry, dir } = item;
      const revocation = entry.origin.sourceId === null ? null : this.revoked(entry.kind, entry.name, entry.version);
      if (revocation !== null) {
        refuse(item, revocation);
        continue;
      }
      if (content.kind === "theme") {
        let previewUrl: string | undefined;
        if (content.preview) {
          const type = IMAGE_TYPES[content.preview.slice(content.preview.lastIndexOf(".")).toLowerCase()];
          if (type) {
            served.set(`theme/${entry.name}/${content.preview}`, { path: join(dir, ...content.preview.split("/")), contentType: type });
            previewUrl = contentAssetUrl(this.assetToken, "theme", entry.name, content.preview);
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
          ...(content.pair ? { pair: content.pair } : {}),
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
          faces: content.faces.map((face) => ({ url: contentAssetUrl(this.assetToken, "font", entry.name, face.file), format: face.format, weight: face.weight, style: face.style })),
          ...from(item),
        });
      } else if (content.kind === "skill" || content.kind === "agent") {
        instructions.push({ kind: content.kind, name: entry.name, dir });
      } else if (content.kind === "agent-plugin") {
        agentPlugins.push({ name: entry.name, version: entry.version, content });
        agentPluginRuntime.push({ name: entry.name, version: entry.version, content, dir, generationId: entry.origin.contentSha256 });
        if (content.components.routineTemplates.length > 0) {
          const bytes = content.files.find((file) => file.path === "ai.agent-connector.ave/routines.json")?.data;
          if (!bytes) throw new Error(`installed agent plugin ${entry.name} is missing its routine templates`);
          const parsed = parseAgentPluginRoutineTemplates(bytes);
          if (parsed.length !== content.components.routineTemplates.length) {
            throw new Error(`installed agent plugin ${entry.name} has inconsistent routine templates`);
          }
          routineTemplates.push(...parsed.map((template) => ({
            ...template, packageName: entry.name, version: entry.version,
          })));
        }
      }
    }
    this.view = { themes, languages, fonts, routineTemplates, broken: brokenViews };
    this.catalogs = catalogs;
    this.served = served;
    this.instructions = instructions;
    this.agentPlugins = agentPlugins;
    this.agentPluginRuntime = agentPluginRuntime;
    return this.installed();
  }

  installed(): InstalledContentView {
    return structuredClone(this.view);
  }

  installedInstructions(): InstalledInstruction[] {
    return this.instructions.map((item) => ({ ...item }));
  }

  installedAgentPlugins(): readonly InstalledAgentPlugin[] {
    return this.agentPlugins;
  }

  installedAgentPluginRuntime(): readonly InstalledAgentPluginRuntime[] {
    return this.agentPluginRuntime;
  }

  languageMessages(locale: string): Record<string, string> {
    const catalog = this.catalogs.get(locale);
    if (!catalog) throw new Error(`no installed language provides ${locale}`);
    return { ...catalog };
  }

  /** Serves only applied theme previews and listed font faces; all other asset paths return null. */
  servedFile(kind: string, name: string, path: string): ServedContentFile | null {
    return this.served.get(`${kind}/${name}/${path}`) ?? null;
  }
}
