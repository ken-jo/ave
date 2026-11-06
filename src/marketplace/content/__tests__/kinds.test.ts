import { describe, expect, it } from "vitest";
import { contentFileProblem } from "../rules.js";
import type { SourceOrigin } from "../../sources/registry.js";
import { isDataContentKind, parseContent, type ContentFile, type DataContentKind } from "../kinds.js";

const json = (path: string, value: unknown): ContentFile => ({ path, data: Buffer.from(JSON.stringify(value)) });
const ENGLISH = {
  "app.title": "Ave",
  "app.quit": "Quit",
  "chat.send": "Send",
  "approval.write": "Allow writing {path}?",
  be_system_intro: "You are Ave.",
  "shellExecution.defaultRoute": "Commands run through the host shell.",
  "routinePanel.naturalRoutinePrompt": "Schedule this routine: {input}",
};

function parse(
  kind: DataContentKind,
  files: ContentFile[],
  name = "sample",
  payload: Record<string, unknown> | null = {},
  sourceOrigin: SourceOrigin = "custom",
  unknownMessageKeys: "refuse" | "ignore" = "refuse",
) {
  return parseContent(kind, files, { name, payload, english: ENGLISH, sourceOrigin, unknownMessageKeys });
}

const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)]);
const fontFile = (patch: Record<string, unknown> = {}) =>
  json("font.json", { family: "Harbor Sans", license: "LICENSE", faces: [{ file: "files/HarborSans.woff2", weight: "100 900" }], ...patch });
const LICENSE: ContentFile = { path: "LICENSE", data: Buffer.from("SIL Open Font License 1.1\n") };

describe("content file rules (design §5.4)", () => {
  it("holds agent-plugin files to the portable and host component directories", () => {
    for (const path of ["plugin.json", "mcp.json", "README.md", "LICENSE", "skills/draft/SKILL.md", "skills/draft/scripts/run.sh", "skills/draft/assets/form.pdf", "server/worker", "ai.agent-connector.ave/prompts/draft.md", "ai.agent-connector.ave/agents/reviewer/AGENTS.md", "ai.agent-connector.ave/routines.json"]) {
      expect(contentFileProblem("agent-plugin", path), path).toBeNull();
    }
    for (const path of ["skills/draft/assets/run.py", "skills/draft/scripts/run.exe", "other/run.sh", "ai.agent-connector.ave/program.js", "server/icon.svg"]) {
      expect(contentFileProblem("agent-plugin", path), path).not.toBeNull();
    }
  });

  it("refuses an agent-plugin folder named for an extension namespace Ave does not own", () => {
    expect(contentFileProblem("agent-plugin", "ai.agent-connector.ave/prompts/draft.md")).toBeNull();
    expect(contentFileProblem("agent-plugin", "xyz.example/prompts/draft.md"))
      .toBe("a agent-plugin package holds plugin.json, mcp.json, skills/, server/, ai.agent-connector.ave/, and package notes only: xyz.example/prompts/draft.md");
  });

  it("allows each kind's layout and nothing else", () => {
    expect(contentFileProblem("font", "files/a.woff2")).toBeNull();
    expect(contentFileProblem("font", "LICENSE")).toBeNull();
    expect(contentFileProblem("font", "files/nested/a.woff2")).toMatch(/only/u);
    expect(contentFileProblem("language", "messages.json")).toBeNull();
    expect(contentFileProblem("language", "extra.json")).toMatch(/only/u);
    expect(contentFileProblem("provider", "provider.json")).toBeNull();
    expect(contentFileProblem("skill", "references/guide.md")).toBeNull();
    expect(contentFileProblem("skill", "references/run.sh")).toMatch(/allows .* files there/u);
    expect(contentFileProblem("skill", "scripts/run.sh")).toBeNull();
    expect(contentFileProblem("skill", "scripts/search.py")).toBeNull();
    expect(contentFileProblem("skill", "scripts/upstream.pin")).toBeNull();
    expect(contentFileProblem("skill", "scripts/tool.exe")).toMatch(/allows .* files there/u);
    expect(contentFileProblem("skill", "assets/templates/form.hwp")).toBeNull();
    expect(contentFileProblem("skill", "assets/run.py")).toMatch(/allows .* files there/u);
    expect(contentFileProblem("skill", "LICENSE")).toBeNull();
    expect(contentFileProblem("skill", "NOTICE")).toBeNull();
    expect(contentFileProblem("skill", "templates/form.hwp")).toMatch(/only/u);
    expect(contentFileProblem("agent", "NOTICE")).toMatch(/AGENTS\.md only/u);
    expect(contentFileProblem("agent", "AGENTS.md")).toBeNull();
  });

  it("refuses SVG in every kind, whatever the layout says", () => {
    expect(contentFileProblem("skill", "assets/logo.SVG")).toBe("SVG is not allowed: assets/logo.SVG");
  });
});

describe("retired language packages", () => {
  it("does not classify language payloads as active data content", () => {
    expect(isDataContentKind("language")).toBe(false);
  });
});

describe("font packages", () => {
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
    expect(() => parse("font", [fontFile({ faces: [{ file: "files/HarborSans.woff2", weight: "900 100" }] }), face, LICENSE])).toThrow(/weight must be/u);
  });
});

describe("provider and messaging-connection packages", () => {
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

  it("unlocks a built-in vendor with an optional default model", () => {
    expect(parse("provider", [json("provider.json", { providerId: "azure-foundry", defaultModel: "gpt-5" })], "azure-foundry")).toEqual({
      kind: "provider",
      vendor: { providerId: "azure-foundry", defaultModel: "gpt-5" },
    });
    expect(() => parse("provider", [json("provider.json", { providerId: "azure-foundry", label: "Gemini" })], "azure-foundry")).toThrow("provider.json: unknown field label");
    expect(() => parse("provider", [json("provider.json", { providerId: "azure-foundry", defaultModel: "a b" })], "azure-foundry")).toThrow(/defaultModel must be a model id/u);
  });

  it("lets only an official or managed source move a built-in vendor's base URL, and only to https", () => {
    const moved = json("provider.json", { providerId: "azure-foundry", baseUrl: "https://gateway.corp.example/foundry" });
    expect(parse("provider", [moved], "azure-foundry", {}, "managed")).toMatchObject({ vendor: { baseUrl: "https://gateway.corp.example/foundry" } });
    expect(() => parse("provider", [moved], "azure-foundry", {}, "custom")).toThrow(/only an official or managed source may set azure-foundry's baseUrl/u);
    expect(() => parse("provider", [json("provider.json", { providerId: "azure-foundry", baseUrl: "http://gateway.corp.example" })], "azure-foundry", {}, "official"))
      .toThrow(/baseUrl must be an https URL/u);
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
