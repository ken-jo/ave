import { describe, expect, it } from "vitest";
import { moonstoneBundle } from "../../../ui/renderer/theme/bundles/moonstone.js";
import { contentFileProblem } from "../rules.js";
import { parseContent, type ContentFile, type DataContentKind } from "../kinds.js";

const json = (path: string, value: unknown): ContentFile => ({ path, data: Buffer.from(JSON.stringify(value)) });
const ENGLISH = new Set(["app.title", "app.quit", "chat.send"]);

function parse(kind: DataContentKind, files: ContentFile[], name = "sample", payload: Record<string, unknown> | null = {}) {
  return parseContent(kind, files, { name, payload, englishKeys: ENGLISH });
}

const SURFACES = { "surface-sunken": "228 30% 97%", surface: "0 0% 100%", "surface-raised": "0 0% 100%", "surface-overlay": "0 0% 100%", "border-subtle": "228 24% 94%", "border-strong": "228 18% 84%" };
const themeFile = (patch: Record<string, unknown> = {}) =>
  json("theme.json", { name: "Harbor", description: "Blue light.", shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES, ...patch });

const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)]);
const fontFile = (patch: Record<string, unknown> = {}) =>
  json("font.json", { family: "Harbor Sans", license: "LICENSE", faces: [{ file: "files/HarborSans.woff2", weight: "100 900" }], ...patch });
const LICENSE: ContentFile = { path: "LICENSE", data: Buffer.from("SIL Open Font License 1.1\n") };

describe("content file rules (design §5.4)", () => {
  it("allows each kind's layout and nothing else", () => {
    expect(contentFileProblem("theme", "theme.json")).toBeNull();
    expect(contentFileProblem("theme", "preview.webp")).toBeNull();
    expect(contentFileProblem("theme", "img/preview.png")).toMatch(/theme\.json and a preview image only/u);
    expect(contentFileProblem("font", "files/a.woff2")).toBeNull();
    expect(contentFileProblem("font", "LICENSE")).toBeNull();
    expect(contentFileProblem("font", "files/nested/a.woff2")).toMatch(/only/u);
    expect(contentFileProblem("language", "messages.json")).toBeNull();
    expect(contentFileProblem("language", "extra.json")).toMatch(/only/u);
    expect(contentFileProblem("provider", "provider.json")).toBeNull();
    expect(contentFileProblem("skill", "references/guide.md")).toBeNull();
    expect(contentFileProblem("skill", "references/run.sh")).toMatch(/allows/u);
    expect(contentFileProblem("agent", "AGENTS.md")).toBeNull();
  });

  it("refuses SVG in every kind, whatever the layout says", () => {
    expect(contentFileProblem("theme", "preview.svg")).toBe("SVG is not allowed: preview.svg");
    expect(contentFileProblem("skill", "assets/logo.SVG")).toBe("SVG is not allowed: assets/logo.SVG");
  });
});

describe("theme packages (blueprint 3.2)", () => {
  it("parses a theme that passes the contrast rules", () => {
    const content = parse("theme", [themeFile({ preview: "preview.png" }), { path: "preview.png", data: Buffer.from("png") }], "harbor");
    expect(content).toMatchObject({ kind: "theme", name: "Harbor", shell: "light", preview: "preview.png" });
  });

  it("refuses a theme that fails contrast and names the rule", () => {
    const tokens = { ...moonstoneBundle.tokens, "message-user-fg": moonstoneBundle.tokens["message-user-bg"] };
    expect(() => parse("theme", [themeFile({ tokens })])).toThrow(/message-user-bg ↔ message-user-fg contrast 1\.00 is under 4\.5/u);
  });

  it("refuses unknown fields, token values that are not triples, and the built-in ids", () => {
    expect(() => parse("theme", [themeFile({ css: "body{}" })])).toThrow("theme.json: unknown field css");
    expect(() => parse("theme", [themeFile({ surfaces: { ...SURFACES, surface: "white" } })])).toThrow(/surface surface is not an "H S% L%" triple/u);
    expect(() => parse("theme", [themeFile({ surfaces: undefined })])).toThrow(/surfaces must be an object/u);
    expect(() => parse("theme", [themeFile({ tokens: { ...moonstoneBundle.tokens, primary: "url(x)" } })])).toThrow(/primary is not an "H S% L%" triple/u);
    expect(() => parse("theme", [themeFile()], "moonstone")).toThrow("moonstone is a built-in theme");
    expect(() => parse("theme", [themeFile({ preview: "missing.png" })])).toThrow(/preview must name an image file/u);
  });
});

describe("language packages (blueprint 3.3)", () => {
  const info = json("language.json", { locale: "fr", nativeName: "Français", englishName: "French" });

  it("layers the catalog over English and lists the keys it does not translate", () => {
    const content = parse("language", [info, json("messages.json", { "app.title": "Ave", "chat.send": "Envoyer" })], "french", { locale: "fr" });
    expect(content).toEqual({
      kind: "language",
      locale: "fr",
      nativeName: "Français",
      englishName: "French",
      messages: { "app.title": "Ave", "chat.send": "Envoyer" },
      missingKeys: ["app.quit"],
    });
  });

  it("refuses keys the English catalog does not have", () => {
    expect(() => parse("language", [info, json("messages.json", { "app.title": "Ave", "made.up": "x" })], "french", { locale: "fr" }))
      .toThrow("messages.json: 1 key(s) are not in the English catalog: made.up");
  });

  it("requires language.json to name the descriptor's locale, and refuses English", () => {
    expect(() => parse("language", [info, json("messages.json", {})], "french", { locale: "de" })).toThrow(/locale must be de/u);
    const english = json("language.json", { locale: "en", nativeName: "English", englishName: "English" });
    expect(() => parse("language", [english, json("messages.json", {})], "english", { locale: "en" })).toThrow(/English is built in/u);
    expect(() => parse("language", [info, json("messages.json", { "app.title": 3 })], "french", { locale: "fr" })).toThrow(/app\.title must be a non-empty string/u);
  });

  it("reads the locale from language.json when loading an installed package", () => {
    expect(parse("language", [info, json("messages.json", {})], "french", null)).toMatchObject({ locale: "fr" });
  });
});

describe("font packages (blueprint 3.4)", () => {
  const face: ContentFile = { path: "files/HarborSans.woff2", data: WOFF2 };

  it("parses the faces and their formats", () => {
    expect(parse("font", [fontFile(), face, LICENSE])).toEqual({
      kind: "font",
      family: "Harbor Sans",
      faces: [{ file: "files/HarborSans.woff2", format: "woff2", weight: "100 900", style: "normal" }],
    });
  });

  it("requires a non-empty LICENSE", () => {
    expect(() => parse("font", [fontFile(), face])).toThrow("LICENSE: a font package needs a non-empty LICENSE file");
    expect(() => parse("font", [fontFile(), face, { path: "LICENSE", data: Buffer.from("  \n") }])).toThrow(/non-empty LICENSE/u);
  });

  it("refuses a file whose bytes are not the format its extension names, and unlisted font files", () => {
    expect(() => parse("font", [fontFile(), { path: "files/HarborSans.woff2", data: Buffer.from("<svg></svg>") }, LICENSE]))
      .toThrow("files/HarborSans.woff2: is not a font file of the format its extension names");
    expect(() => parse("font", [fontFile(), face, { path: "files/Extra.woff2", data: WOFF2 }, LICENSE])).toThrow(/faces does not list files\/Extra\.woff2/u);
  });

  it("refuses a family that could leave the CSS string it is written into", () => {
    expect(() => parse("font", [fontFile({ family: 'Harbor", serif' }), face, LICENSE])).toThrow(/family must be/u);
    expect(() => parse("font", [fontFile({ faces: [{ file: "files/HarborSans.woff2", weight: 450 }] }), face, LICENSE])).toThrow(/weight must be/u);
  });
});

describe("provider and messaging-connection packages (blueprint 3.5)", () => {
  const provider = {
    providerId: "harbor-llm",
    label: "Harbor LLM",
    baseUrl: "https://api.harbor.example/v1",
    defaultModel: "harbor-1",
    modelOptions: ["harbor-1", "harbor-1-mini"],
    requiresApiKey: true,
  };

  it("parses provider.json through the preset normalizer today's asset install uses", () => {
    expect(parse("provider", [json("provider.json", provider)], "harbor-llm")).toEqual({ kind: "provider", preset: provider });
  });

  it("refuses a field the normalizer drops or rewrites, and a provider id other than the package name", () => {
    expect(() => parse("provider", [json("provider.json", { ...provider, secretSauce: true })], "harbor-llm")).toThrow("provider.json: invalid or unknown field secretSauce");
    expect(() => parse("provider", [json("provider.json", { ...provider, modelOptions: ["harbor-1-mini"] })], "harbor-llm")).toThrow(/invalid or unknown field modelOptions/u);
    expect(() => parse("provider", [json("provider.json", provider)], "other")).toThrow(/providerId must be other/u);
  });

  const connection = {
    connectionId: "harbor-chat",
    label: "Harbor Chat",
    summary: "Talk to Ave from Harbor Chat.",
    pairing: "one-time-code",
    credentials: [{ key: "botToken", label: "Bot token", secret: true }],
  };

  it("parses connection.json through the messaging normalizer", () => {
    expect(parse("messaging-connection", [json("connection.json", connection)], "harbor-chat")).toEqual({ kind: "messaging-connection", connection });
    expect(() => parse("messaging-connection", [json("connection.json", { ...connection, pairing: "qr" })], "harbor-chat")).toThrow(/is not a valid declaration/u);
  });
});
