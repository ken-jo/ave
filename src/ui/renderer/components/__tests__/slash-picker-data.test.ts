// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { MessageSquareText, Server, Sparkles } from "lucide-react";
import {
  SLASH_COMMANDS,
  CATEGORY_ICON,
  CATEGORY_ORDER,
  catLabel,
  filterMcpTools,
  filterSkills,
  buildComposerMenuSections,
  type McpPromptEntry,
  type McpToolEntry,
  type SkillEntry,
} from "../slash-picker-data.js";

const mcpTools: McpToolEntry[] = [
  { name: "github__create_issue", serverId: "github" },
  { name: "linear__list_tickets", serverId: "linear" },
];

const mcpPrompts: McpPromptEntry[] = [
  { name: "triage", serverId: "github", description: "Sort inbound issues", arguments: [] },
  { name: "standup", serverId: "linear", title: "Daily standup", arguments: [] },
];
const pluginPrompt = { id: "agent-plugin:writer-plugin:draft", packageName: "writer-plugin", version: "1.0.0", name: "draft", description: "Draft a note", body: "Draft {args}" };

const skills: SkillEntry[] = [
  { name: "deep-research", description: "Fan-out web research" },
  { name: "code-review", description: "Review the current diff" },
];

const personas = [
  { id: "default", name: "기본", systemPromptAdd: "", isDefault: true },
  { id: "coding", name: "코딩", systemPromptAdd: "Code carefully." },
];

/** The builder's inputs with nothing installed and no persona chosen. */
const bare = {
  personas,
  activePersonaId: "default",
  plugins: [],
  mcpTools: [],
  mcpPrompts: [],
  pluginPrompts: [],
  skills: [],
  onSelectPersona: () => {},
  onInsert: () => {},
  onSelectPlugin: () => {},
  onRunMcpPrompt: () => {},
  onRunPluginPrompt: () => {},
};

describe("slash-picker-data — category model (mcp tools, mcp prompts, skills)", () => {
  it("CATEGORY_ORDER lists every category in order", () => {
    expect(CATEGORY_ORDER).toEqual([
      "command",
      "custom-commands",
      "shortcut",
      "plugin",
      "mcp",
      "plugin-prompts",
      "mcp-prompts",
      "skills",
    ]);
  });

  it("maps the mcp + skills categories to their spec icons", () => {
    expect(CATEGORY_ICON.mcp).toBe(Server);
    expect(CATEGORY_ICON["mcp-prompts"]).toBe(MessageSquareText);
    expect(CATEGORY_ICON["plugin-prompts"]).toBe(MessageSquareText);
    expect(CATEGORY_ICON.skills).toBe(Sparkles);
  });

  it("resolves human labels for the new categories", () => {
    expect(catLabel("mcp").length).toBeGreaterThan(0);
    expect(catLabel("skills").length).toBeGreaterThan(0);
    // `catLabel` switches exhaustively, so a category added without its case
    // would return undefined here.
    expect(catLabel("mcp-prompts").length).toBeGreaterThan(0);
    expect(catLabel("plugin-prompts").length).toBeGreaterThan(0);
    expect(catLabel("custom-commands").length).toBeGreaterThan(0);
  });

  it("inserts a custom command with its hint and labels it by description or scope", () => {
    const inserted: string[] = [];
    const sections = buildComposerMenuSections({
      ...bare,
      customCommands: [
        { name: "review", scope: "project", description: "Review a PR", argumentHint: "<pr>" },
        { name: "standup", scope: "user", description: "" },
      ],
      onInsert: (cmd) => inserted.push(cmd),
    });
    const rows = sections[0]!.items.find((item) => item.id === "category:custom-commands")!.submenu!;
    expect(rows.map((row) => row.label)).toEqual(["/review <pr>", "/standup"]);
    expect(rows[0]!.sublabel).toBe("Review a PR");
    expect(rows[1]!.sublabel?.length).toBeGreaterThan(0);
    for (const row of rows) void row.onSelect?.();
    expect(inserted).toEqual(["/review ", "/standup "]);
  });

  it("filters MCP tools by name or server id", () => {
    expect(filterMcpTools(mcpTools, "")).toHaveLength(2);
    expect(filterMcpTools(mcpTools, "issue")).toEqual([mcpTools[0]]);
    expect(filterMcpTools(mcpTools, "linear")).toEqual([mcpTools[1]]);
  });

  it("filters skills by name or description", () => {
    expect(filterSkills(skills, "")).toHaveLength(2);
    expect(filterSkills(skills, "research")).toEqual([skills[0]]);
    expect(filterSkills(skills, "diff")).toEqual([skills[1]]);
  });

  it("carries a prompt's and a skill's description into the row's second line", () => {
    // The deleted panel drew two lines per row. A native menu keeps the second
    // one in `sublabel`, so dropping it here would silently cost the user every
    // description while every other assertion still passed.
    const sections = buildComposerMenuSections({ ...bare, mcpTools, mcpPrompts, pluginPrompts: [pluginPrompt], skills });
    const rows = new Map(sections.flatMap((s) => s.items).map((row) => [row.id, row]));
    expect(rows.get("category:mcp-prompts")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Sort inbound issues", undefined]);
    expect(rows.get("category:skills")!.submenu!.map((r) => r.sublabel))
      .toEqual(["Fan-out web research", "Review the current diff"]);
    expect(rows.get("category:plugin-prompts")!.submenu![0]!.sublabel).toBe("Draft a note");
  });

  it("runs a package prompt from its own menu row", () => {
    const selected: string[] = [];
    const sections = buildComposerMenuSections({ ...bare, pluginPrompts: [pluginPrompt], onRunPluginPrompt: (prompt) => selected.push(prompt.id) });
    const row = sections[0]!.items.find((item) => item.id === "category:plugin-prompts")!.submenu![0]!;
    void row.onSelect?.();
    expect(selected).toEqual([pluginPrompt.id]);
  });

  it("leaves out a category with nothing in it rather than drawing an empty submenu", () => {
    const sections = buildComposerMenuSections(bare);
    // Only the persona and the built-in commands survive: nothing installed, so
    // no plugins, no MCP, no skills.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.items.map((row) => row.id)).toEqual(["category:persona", "category:command"]);
    // …and that applies to the persona list too, should it ever be empty.
    expect(buildComposerMenuSections({ ...bare, personas: [] })[0]!.items.map((row) => row.id))
      .toEqual(["category:command"]);
  });

  it("holds only what goes INTO a message — never a row that navigates the window", () => {
    // This menu hangs off the composer. The view shortcuts it used to open with
    // are navigation and belong to the sidebar; ten of them above the divider
    // also pushed the three things the button is for below the fold. They are
    // still reachable by typing in the "/" menu, which `filterActions` serves.
    const sections = buildComposerMenuSections({
      ...bare,
      plugins: [{ viewKey: "plugin:meeting:panel", label: "미팅 열기" }],
      mcpTools,
      mcpPrompts,
      pluginPrompts: [pluginPrompt],
      skills,
    });
    // One section: no flat block above the divider any more.
    expect(sections).toHaveLength(1);
    const ids = sections[0]!.items.map((row) => row.id);
    expect(ids).toEqual([
      "category:persona",
      "category:command",
      "category:plugin",
      "category:mcp",
      "category:plugin-prompts",
      "category:mcp-prompts",
      "category:skills",
    ]);
    // Every row is a category that opens a submenu — nothing acts on click.
    expect(sections[0]!.items.every((row) => (row.submenu?.length ?? 0) > 0)).toBe(true);
    expect(ids.some((id) => id.startsWith("shortcut:"))).toBe(false);
  });

  it("draws the personas as radio rows, the active one checked, and reports the id on pick", () => {
    const picked: string[] = [];
    const sections = buildComposerMenuSections({
      ...bare,
      activePersonaId: "coding",
      onSelectPersona: (id) => picked.push(id),
    });
    const persona = sections[0]!.items[0]!;
    expect(persona.id).toBe("category:persona");
    expect(persona.label.length).toBeGreaterThan(0);
    // Every row carries a state — that is what makes main draw it as a radio
    // item — and exactly the active one is on. The rows that are NOT personas
    // carry none, so they stay plain commands.
    expect(persona.submenu!.map((row) => [row.id, row.label, row.checked])).toEqual([
      ["persona:default", "기본", false],
      ["persona:coding", "코딩", true],
    ]);
    expect(sections[0]!.items[1]!.submenu!.every((row) => row.checked === undefined)).toBe(true);
    void persona.submenu![0]!.onSelect!();
    expect(picked).toEqual(["default"]);
  });

  it("SLASH_COMMANDS is the one built-in command list: unique commands, each with a catalog label", () => {
    const commands = SLASH_COMMANDS.map((entry) => entry.cmd);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).toContain("/help");
    for (const entry of SLASH_COMMANDS) {
      expect(entry.cmd.startsWith("/")).toBe(true);
      expect(entry.labelKey).toMatch(/^slashPickerPanel\.cmd/);
    }
  });
});
