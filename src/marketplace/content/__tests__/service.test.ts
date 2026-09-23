import { describe, expect, it } from "vitest";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
import type { ParsedContent } from "../kinds.js";
import type { LedgerEntry } from "../ledger.js";
import { InstalledContentService } from "../service.js";
import type { BrokenContent, ContentStore, LoadedContent } from "../store.js";

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

function service(items: LoadedContent[], broken: BrokenContent[] = []) {
  return new InstalledContentService({ load: async () => ({ loaded: items, broken }) } as unknown as ContentStore);
}

describe("InstalledContentService", () => {
  it("builds the picker view, the catalogs and the files the asset scheme may serve", async () => {
    const svc = service([
      loaded("theme", "harbor", { kind: "theme", name: "Harbor", description: "d", shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES, preview: "preview.webp" }),
      loaded("language", "french", { kind: "language", locale: "fr", nativeName: "Français", englishName: "French", messages: { "app.title": "Ave" }, missingKeys: ["app.quit"] }),
      loaded("font", "harbor-sans", { kind: "font", family: "Harbor Sans", faces: [{ file: "files/Harbor Sans.woff2", format: "woff2", weight: "400", style: "normal" }] }),
      loaded("provider", "harbor-llm", { kind: "provider", preset: { providerId: "harbor-llm", label: "H", baseUrl: "https://h.example/v1", defaultModel: "m", modelOptions: ["m"], requiresApiKey: true } }),
    ], [{ entry: entry("theme", "tampered"), problem: "the installed files changed after install" }]);
    const view = await svc.reload();
    expect(view.themes).toEqual([expect.objectContaining({ id: "harbor", previewUrl: "ave-content://theme/harbor/preview.webp", sourceId: "acme", version: "1.0.0" })]);
    expect(view.languages).toEqual([{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: ["app.quit"], sourceId: "acme", version: "1.0.0" }]);
    expect(view.fonts[0]).toMatchObject({ family: "Harbor Sans", faces: [{ url: "ave-content://font/harbor-sans/files/Harbor%20Sans.woff2", format: "woff2" }] });
    // Faces are declared under the package alias; the family is the picker's label.
    expect(view.fonts[0]).toMatchObject({ family: "Harbor Sans" });
    expect(view.fonts[0]!.stack.startsWith('"ave-font-harbor-sans", ')).toBe(true);
    expect(view.broken).toEqual([{ kind: "theme", name: "tampered", problem: "the installed files changed after install" }]);
    expect(svc.languageMessages("fr")).toEqual({ "app.title": "Ave" });
    expect(() => svc.languageMessages("de")).toThrow("no installed language provides de");
    expect(svc.servedFile("font", "harbor-sans", "files/Harbor Sans.woff2")).toEqual({ path: "/pkgs/font/harbor-sans/1.0.0/files/Harbor Sans.woff2", contentType: "font/woff2" });
    expect(svc.servedFile("theme", "harbor", "preview.webp")).toEqual({ path: "/pkgs/theme/harbor/1.0.0/preview.webp", contentType: "image/webp" });
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
});
