import { describe, expect, it } from "vitest";
import type { PayloadFile } from "../../../plugins/contribution-approval-digest.js";
import type { AgentPluginComponents, IndexVersion } from "../../catalog/types.js";
import { payloadFile as file } from "../../__tests__/fixtures/package-files.js";
import {
  agentPluginConsent,
  catalogDelta,
  contentConsent,
  mcpConsent,
  parseConsentFingerprint,
  pluginConsent,
  stagedDelta,
  unknownConsent,
  type ConsentFingerprint,
} from "../consent.js";


interface PluginShape {
  authority?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  process?: boolean;
  skill?: boolean;
  server?: string;
  hookScript?: string;
}

function pluginPayload(shape: PluginShape = {}): { document: unknown; files: PayloadFile[] } {
  const ave: Record<string, unknown> = {
    capabilities: ["notes.read"],
    requires: { minAppVersion: "0.13.0", hostProtocol: "2", capabilities: ["calendar"], ...shape.requires },
    mcpServers: [{ id: "notes", path: "mcp/notes.json" }],
    hooks: [{ id: "audit", path: "hooks/audit.json" }],
    ...(shape.skill ? { skills: [{ id: "helper", path: "skills/helper" }] } : {}),
    ...(shape.process ? { process: { command: ["${PLUGIN_ROOT}/bin/run"] } } : {}),
    ...shape.authority,
  };
  const document = { name: "notes", version: "1.0.0", extensions: { "ai.agent-connector.ave": ave } };
  const files = [
    file("plugin.json", JSON.stringify(document)),
    file("mcp/notes.json", JSON.stringify({ transport: "stdio", command: "node", args: ["../dist/server.js"] })),
    file("dist/server.js", shape.server ?? "console.log('server')"),
    file("hooks/audit.json", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["node", "${PLUGIN_ROOT}/hooks/audit.js"] }] }] } })),
    file("hooks/audit.js", shape.hookScript ?? "process.exit(0)"),
    file("bin/run", "#!/bin/sh\n"),
    ...(shape.skill ? [file("skills/helper/SKILL.md", "---\nname: helper\n---\nhelp")] : []),
  ];
  return { document, files };
}

function plugin(shape: PluginShape = {}): ConsentFingerprint {
  const { document, files } = pluginPayload(shape);
  return pluginConsent(document, files);
}

function components(overrides: Partial<AgentPluginComponents> = {}): AgentPluginComponents {
  return {
    skills: [],
    mcpServers: { notes: { transport: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"], cwd: "${PLUGIN_ROOT}", digest: "a".repeat(64) } },
    prompts: [],
    agents: [],
    routineTemplates: [],
    hooks: [{ event: "PreToolUse", command: ["node", "${PLUGIN_ROOT}/hook.js"], timeoutMs: 5000, digest: "b".repeat(64) }],
    ...overrides,
  };
}

const AGENT_FILES = [file("plugin.json", "{\"name\":\"notes\",\"version\":\"1.0.0\"}"), file("server.js", "server"), file("hook.js", "hook")];

function agent(overrides: { minAppVersion?: string | null; hostProtocol?: string | null; components?: AgentPluginComponents; files?: PayloadFile[] } = {}): ConsentFingerprint {
  return agentPluginConsent({
    minAppVersion: overrides.minAppVersion === undefined ? "0.13.0" : overrides.minAppVersion,
    hostProtocol: overrides.hostProtocol === undefined ? null : overrides.hostProtocol,
    components: overrides.components ?? components(),
    files: overrides.files ?? AGENT_FILES,
  });
}

function changedFields(before: ConsentFingerprint, after: ConsentFingerprint): string[] {
  return stagedDelta(before, after).map((entry) => entry.field);
}

describe("consentFingerprint: one row per field, each change alone needs review", () => {
  const base = plugin();
  const pluginRows: Array<[string, ConsentFingerprint]> = [
    ["authority.capabilities", plugin({ authority: { capabilities: ["notes.read", "notes.write"] } })],
    ["authority.networkAccess", plugin({ authority: { networkAccess: { hosts: ["api.example.com"] } } })],
    ["authority.hostSecrets", plugin({ authority: { hostSecrets: { read: ["llm.apiKey"] } } })],
    ["authority.pluginAccess", plugin({ authority: { pluginAccess: { call: ["calendar"] } } })],
    ["authority.auth", plugin({ authority: { auth: { kind: "oauth" } } })],
    ["authority.requires.capabilities", plugin({ requires: { capabilities: ["calendar", "mail"] } })],
    ["authority.dependencies", plugin({ authority: { dependencies: ["calendar"] } })],
    ["authority.sandbox", plugin({ authority: { sandbox: { filesystem: "none" } } })],
    ["minAppVersion", plugin({ requires: { minAppVersion: "0.14.0" } })],
    ["hostProtocol", plugin({ requires: { hostProtocol: "4" } })],
    ["entryForm", plugin({ process: true })],
    ["contributionKinds", plugin({ skill: true })],
    ["mcpServer:notes", plugin({ server: "console.log('changed')" })],
    ["hook:audit", plugin({ hookScript: "process.exit(1)" })],
  ];
  it.each(pluginRows)("plugin %s", (field, changed) => {
    expect(changedFields(base, changed)).toContain(field);
  });

  it("plugin processTree: any file of a process extension", () => {
    const before = plugin({ process: true });
    const { document, files } = pluginPayload({ process: true });
    const after = pluginConsent(document, [...files, file("assets/readme.txt", "new")]);
    expect(changedFields(before, after)).toContain("processTree");
  });

  const agentBase = agent();
  const agentRows: Array<[string, ConsentFingerprint]> = [
    ["minAppVersion", agent({ minAppVersion: "0.14.0" })],
    ["hostProtocol", agent({ hostProtocol: "4" })],
    ["componentKinds", agent({ components: components({ prompts: [{ name: "draft", kind: "template", digest: "c".repeat(64) }] }) })],
    ["mcpServer:notes", agent({ files: [AGENT_FILES[0]!, file("server.js", "server v2"), AGENT_FILES[2]!] })],
    ["hook:0", agent({ files: [AGENT_FILES[0]!, AGENT_FILES[1]!, file("hook.js", "hook v2")] })],
    ["mcpAuth", agent({ components: components({ mcpAuth: { kind: "api-key", name: "NOTES_KEY" } as unknown as AgentPluginComponents["mcpAuth"] }) })],
  ];
  it.each(agentRows)("agent-plugin %s", (field, changed) => {
    expect(changedFields(agentBase, changed)).toContain(field);
  });

  it("mcp mcpRuntime", () => {
    const before = mcpConsent({ transport: "stdio", command: "npx", args: ["-y", "notes-mcp@1.0.0"] });
    const after = mcpConsent({ transport: "stdio", command: "npx", args: ["-y", "notes-mcp@1.1.0"] });
    expect(changedFields(before, after)).toEqual(["mcpRuntime"]);
  });

  const provider = (json: Record<string, unknown>, minAppVersion = "0.13.0") => contentConsent("provider", minAppVersion, [file("provider.json", JSON.stringify(json))]);
  const providerBase = provider({ providerId: "acme", baseUrl: "https://api.acme.example" });
  it.each([
    ["minAppVersion", provider({ providerId: "acme", baseUrl: "https://api.acme.example" }, "0.14.0")],
    ["providerId", provider({ providerId: "acme-2", baseUrl: "https://api.acme.example" })],
    ["baseUrl", provider({ providerId: "acme", baseUrl: "https://evil.example" })],
  ] as Array<[string, ConsentFingerprint]>)("provider %s", (field, changed) => {
    expect(changedFields(providerBase, changed)).toEqual([field]);
  });

  it.each([
    ["minAppVersion", contentConsent("messaging-connection", "0.14.0", [file("connection.json", "{\"connectionId\":\"chat\"}")])],
    ["connection", contentConsent("messaging-connection", "0.13.0", [file("connection.json", "{\"connectionId\":\"chat\",\"endpoint\":\"x\"}")])],
  ] as Array<[string, ConsentFingerprint]>)("messaging-connection %s", (field, changed) => {
    const before = contentConsent("messaging-connection", "0.13.0", [file("connection.json", "{\"connectionId\":\"chat\"}")]);
    expect(changedFields(before, changed)).toEqual([field]);
  });

  it.each(["skill", "agent", "theme", "font", "language"] as const)("%s minAppVersion", (kind) => {
    expect(changedFields(contentConsent(kind, "0.13.0", []), contentConsent(kind, "0.14.0", []))).toEqual(["minAppVersion"]);
    expect(changedFields(contentConsent(kind, "0.13.0", [file("SKILL.md", "a")]), contentConsent(kind, "0.13.0", [file("SKILL.md", "b")]))).toEqual([]);
  });

  it("a narrowing is a difference too", () => {
    const wide = plugin({ authority: { capabilities: ["notes.read", "notes.write"] } });
    expect(changedFields(wide, base)).toContain("authority.capabilities");
  });

  it("the same bytes are equal, and only plugin.json's version is normalized", () => {
    expect(changedFields(base, plugin())).toEqual([]);
    const { document, files } = pluginPayload();
    const bumped = { ...(document as Record<string, unknown>), version: "1.0.1" };
    const bumpedFiles = files.map((item) => item.path === "plugin.json" ? file("plugin.json", JSON.stringify(bumped)) : item);
    expect(changedFields(base, pluginConsent(bumped, bumpedFiles))).toEqual([]);
  });
});

describe("unknown fields", () => {
  it("an unknown baseline field is a difference, whatever the update says", () => {
    const before = agent({ minAppVersion: null });
    expect(before.unknown).toContain("minAppVersion");
    expect(stagedDelta(before, agent({ minAppVersion: null }))).toEqual([
      expect.objectContaining({ field: "minAppVersion", before: "unknown" }),
    ]);
    expect(stagedDelta(before, agent())).toEqual([expect.objectContaining({ field: "minAppVersion", before: "unknown", after: "0.13.0" })]);
  });

  it("a baseline that could not be computed at all differs at the catalog", () => {
    expect(catalogDelta(unknownConsent("skill"), { version: "1.1.0", commit: "c".repeat(40), minAppVersion: "0.13.0", publishedAt: "2026-10-01T00:00:00Z" })).toEqual([
      expect.objectContaining({ field: "*", before: "unknown" }),
    ]);
  });

  it("a component whose closure cannot be determined is unknown on both sides, every time", () => {
    const unpinned = (version: string) => {
      const { document, files } = pluginPayload();
      return pluginConsent(document, files.map((item) => item.path === "mcp/notes.json"
        ? file("mcp/notes.json", JSON.stringify({ transport: "stdio", command: "npx", args: ["-y", "notes-mcp"], version }))
        : item));
    };
    const before = unpinned("same");
    expect(before.unknown).toEqual(["mcpServer:notes"]);
    expect(changedFields(before, unpinned("same"))).toEqual(["mcpServer:notes"]);
  });
});

describe("checkpoint one: the catalog", () => {
  const version = (overrides: Partial<IndexVersion> = {}): IndexVersion => ({
    version: "1.1.0",
    commit: "c".repeat(40),
    minAppVersion: "0.13.0",
    publishedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  });

  it("an authority field the index row carries differs without a download", () => {
    const authority = { capabilities: ["notes.read", "notes.write"], requires: { minAppVersion: "0.13.0", hostProtocol: "2", capabilities: ["calendar"] } };
    expect(catalogDelta(plugin(), version({ authority })).map((entry) => entry.field)).toEqual(["authority.capabilities"]);
  });

  it("a field the index does not carry is pending, not equal: no difference yet", () => {
    const authority = { capabilities: ["notes.read"], requires: { minAppVersion: "0.13.0", hostProtocol: "2", capabilities: ["calendar"] } };
    // Bundled components require staged bytes; the index cannot establish their consent.
    expect(catalogDelta(plugin(), version({ authority }))).toEqual([]);
  });

  it("an agent plugin component the catalog adds or removes is visible", () => {
    const listed = components({ hooks: [] });
    expect(catalogDelta(agent(), version({ components: listed })).map((entry) => entry.field)).toEqual(["componentKinds", "hook:0"]);
  });

  it("every MCP server update differs at the catalog", () => {
    expect(catalogDelta(mcpConsent({ transport: "stdio", command: "uvx", args: ["notes==1.0.0"] }), version()).map((entry) => entry.field)).toEqual(["mcpRuntime"]);
  });
});

describe("storage", () => {
  it("a stored fingerprint round-trips and anything else is refused", () => {
    const print = plugin();
    expect(parseConsentFingerprint(JSON.parse(JSON.stringify(print)), "consent")).toEqual(print);
    expect(() => parseConsentFingerprint({ ...print, extra: 1 }, "consent")).toThrow(/unknown field/u);
    expect(() => parseConsentFingerprint({ ...print, kind: "widget" }, "consent")).toThrow(/package kind/u);
  });
});
