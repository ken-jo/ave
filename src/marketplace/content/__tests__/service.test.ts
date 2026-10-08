import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
import type { ParsedContent } from "../kinds.js";
import type { LedgerEntry } from "../ledger.js";
import { InstalledContentService } from "../service.js";
import type { BrokenContent, ContentStore, LoadedContent } from "../store.js";

const TOKEN = "t0123456789abcdef0123456789abcdef";
const SURFACES = { "surface-sunken": "0 0% 97%", surface: "0 0% 100%", "surface-raised": "0 0% 100%", "surface-overlay": "0 0% 100%", "border-subtle": "0 0% 94%", "border-strong": "0 0% 84%" };

function entry(kind: LedgerEntry["kind"], name: string): LedgerEntry {
  return {
    kind,
    name,
    version: "1.0.0",
    origin: { sourceId: "acme", sourceOrigin: "custom", commit: "c".repeat(40), packagePath: `x/${name}`, version: "1.0.0", contentSha256: "d".repeat(64), installedAt: "2026-09-23T00:00:00.000Z" },
  };
}

const loaded = (kind: LedgerEntry["kind"], name: string, content: ParsedContent): LoadedContent => ({ entry: entry(kind, name), content, dir: `/pkgs/${kind}/${name}/1.0.0` });

function service(items: LoadedContent[], broken: BrokenContent[] = [], revoked: (kind: string, name: string, version: string) => string | null = () => null) {
  return new InstalledContentService({ load: async () => ({ loaded: items, broken }) } as unknown as ContentStore, TOKEN, revoked);
}

describe("InstalledContentService", () => {
  it("publishes verified routine template fields and removes them on reload", async () => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, templates: [{ id: "daily", title: "Daily draft", description: "Write it",
      trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } },
      execution: "llm-session", prePrompt: "Write the full draft", suggestedScope: { pluginIds: ["writer-extension"] } }] }));
    let items = [loaded("agent-plugin", "writer-plugin", { kind: "agent-plugin", files: [{ path: "ai.agent-connector.ave/routines.json", data: bytes }],
      components: { skills: [], mcpServers: {}, prompts: [], agents: [], routineTemplates: [{ id: "daily", title: "Daily draft", trigger: "schedule", schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } }, execution: "llm-session", digest: "a".repeat(64) }], hooks: [] } })];
    const svc = new InstalledContentService({ load: async () => ({ loaded: items, broken: [] }) } as unknown as ContentStore, TOKEN, () => null);
    expect((await svc.reload()).routineTemplates).toMatchObject([{ packageName: "writer-plugin", version: "1.0.0", id: "daily", prePrompt: "Write the full draft", suggestedScope: { pluginIds: ["writer-extension"] } }]);
    items = [];
    expect((await svc.reload()).routineTemplates).toEqual([]);
  });

  it("builds the picker view, the catalogs and the files the asset scheme may serve", async () => {
    const svc = service([
      loaded("theme", "harbor", { kind: "theme", name: "Harbor", description: "d", shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES, preview: "preview.webp", pair: "harbor-dark" }),
      loaded("language", "french", { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: { "app.title": "Ave" }, missingKeys: ["app.quit"] }),
      loaded("font", "harbor-sans", { kind: "font", family: "Harbor Sans", faces: [{ file: "files/Harbor Sans.woff2", format: "woff2", weight: "400", style: "normal" }] }),
      loaded("provider", "harbor-llm", { kind: "provider", preset: { providerId: "harbor-llm", label: "H", baseUrl: "https://h.example/v1", defaultModel: "m", modelOptions: ["m"], requiresApiKey: true } }),
    ], [{ entry: entry("theme", "tampered"), problem: "the installed files changed after install" }]);
    const view = await svc.reload();
    expect(view.themes).toEqual([expect.objectContaining({ id: "harbor", previewUrl: `ave-content://${TOKEN}/theme/harbor/preview.webp`, pair: "harbor-dark", sourceId: "acme", version: "1.0.0" })]);
    expect(view.languages).toEqual([{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: ["app.quit"], sourceId: "acme", version: "1.0.0" }]);
    expect(view.fonts[0]).toMatchObject({ family: "Harbor Sans", faces: [{ url: `ave-content://${TOKEN}/font/harbor-sans/files/Harbor%20Sans.woff2`, format: "woff2" }] });
    // Faces are declared under the package alias; the family is the picker's label.
    expect(view.fonts[0]).toMatchObject({ family: "Harbor Sans" });
    expect(view.fonts[0]!.stack.startsWith('"ave-font-harbor-sans", ')).toBe(true);
    expect(view.broken).toEqual([{ kind: "theme", name: "tampered", problem: "the installed files changed after install" }]);
    expect(svc.languageMessages("fr")).toEqual({ "app.title": "Ave" });
    expect(() => svc.languageMessages("de")).toThrow("no installed language provides de");
    expect(svc.servedFile("font", "harbor-sans", "files/Harbor Sans.woff2")).toEqual({ path: join("/pkgs/font/harbor-sans/1.0.0", "files/Harbor Sans.woff2"), contentType: "font/woff2" });
    expect(svc.servedFile("theme", "harbor", "preview.webp")).toEqual({ path: join("/pkgs/theme/harbor/1.0.0", "preview.webp"), contentType: "image/webp" });
    expect(svc.servedFile("theme", "harbor", "theme.json")).toBeNull();
    expect(svc.servedFile("font", "harbor-sans", "LICENSE")).toBeNull();
  });

  it("applies the first package that claims a locale or a font family and lists the second as broken", async () => {
    const french = (name: string): LoadedContent => loaded("language", name, { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: {}, missingKeys: [] });
    const font = (name: string): LoadedContent => loaded("font", name, { kind: "font", family: "Harbor Sans", faces: [] });
    const view = await service([french("french"), french("french-alt"), font("harbor-sans"), font("harbor-sans-2")]).reload();
    expect(view.languages.map((language) => language.name)).toEqual(["french"]);
    expect(view.fonts.map((f) => f.name)).toEqual(["harbor-sans"]);
    expect(view.broken).toEqual([
      { kind: "language", name: "french-alt", problem: "french already provides fr" },
      { kind: "font", name: "harbor-sans-2", problem: "harbor-sans already provides the Harbor Sans family" },
    ]);
  });

  it("lists a version its source revoked as broken and applies nothing from it (§10.4)", async () => {
    const skill = loaded("skill", "pdf-tools", { kind: "skill", name: "pdf-tools", description: "PDF tools" });
    const french = loaded("language", "french", { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: { "app.title": "Ave" }, missingKeys: [] });
    const asked: string[] = [];
    const svc = service([skill, french], [], (kind, name, version) => {
      asked.push(`${kind}:${name}@${version}`);
      return name === "french" ? "revoked by acme: leaks prompts" : null;
    });
    const view = await svc.reload();
    expect(asked).toEqual(["skill:pdf-tools@1.0.0", "language:french@1.0.0"]);
    expect(view.languages).toEqual([]);
    expect(view.broken).toEqual([{ kind: "language", name: "french", problem: "revoked by acme: leaks prompts" }]);
    expect(() => svc.languageMessages("fr")).toThrow("no installed language provides fr");
    expect(svc.installedInstructions()).toEqual([{ kind: "skill", name: "pdf-tools", dir: "/pkgs/skill/pdf-tools/1.0.0" }]);
  });
});
