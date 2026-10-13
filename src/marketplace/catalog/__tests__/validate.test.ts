import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../strict-json.js";
import {
  credentialRefusal,
  validateDescriptorText,
  validateIndexText,
  validateRevocationsText,
} from "../validate.js";
import { parseVersionRange, rangeIncludes } from "../version-range.js";
import { deriveAgentPluginComponents } from "../../content/agent-plugin-components.js";
import { createHash } from "node:crypto";
import { holdsCredential, scrubDiagnosticSecrets } from "../../../shared/dlp.js";
import { isSourceId } from "../../sources/official.js";

const COMMIT = "a".repeat(40);
const SHA = "b".repeat(64);
const AT = "2026-09-23T00:00:00Z";

const authority = () => ({
  capabilities: [],
  networkAccess: { allowedDomains: ["api.example.com"] },
  hostSecrets: { read: ["llm.apiKey.openai"] },
  requires: { minAppVersion: "0.12.0" },
});

const PAYLOADS: Record<string, () => Record<string, unknown>> = {
  plugin: () => ({ authority: authority(), artifact: { release: { repo: "acme/alpha", sha256: SHA }, tree: "plugins/alpha/build" } }),
  "agent-plugin": () => ({ manifest: "plugin.json", components: { skills: [], mcpServers: {}, prompts: [], agents: [], routineTemplates: [], hooks: [] } }),
  mcp: () => ({ server: { transport: "stdio", command: "npx", args: ["-y", "@acme/mcp"], env: { ACME_MODE: "ro" }, auth: "api-key", apiKeyEnv: "ACME_KEY" } }),
  skill: () => ({ entry: "SKILL.md" }),
  agent: () => ({ entry: "AGENTS.md" }),
  theme: () => ({ entry: "theme.json" }),
  font: () => ({ entry: "font.json" }),
  language: () => ({ locale: "ko", entry: "language.json", messages: "messages.json" }),
  provider: () => ({ entry: "provider.json" }),
  "messaging-connection": () => ({ entry: "connection.json" }),
};

function descriptor(kind: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind,
    name: `sample-${kind}`,
    version: "1.2.0",
    minAppVersion: "0.12.0",
    displayName: "Sample",
    payload: PAYLOADS[kind]!(),
    ...patch,
  };
}

function checkDescriptor(value: unknown, direct = false) {
  return validateDescriptorText(JSON.stringify(value), { direct });
}

describe("parseStrictJson", () => {
  it("parses standard JSON", () => {
    expect(parseStrictJson('{"a":[1,-2.5e3,"x\\u0041",true,false,null,{}]}')).toEqual({ a: [1, -2500, "xA", true, false, null, {}] });
  });

  it.each([
    ['{"a":1,"a":2}', "duplicate key"],
    ['{"a":{"b":1,"b":1}}', "duplicate key"],
    ['{"__proto__":{}}', "__proto__"],
    ['{"a":1} x', "trailing content"],
    ["{'a':1}", "expected a key"],
    ['[1,]', "unexpected token"],
    ['{"a":01}', "expected ','"],
    ["[".repeat(80) + "]".repeat(80), "nesting too deep"],
    ['"\u0001"', "control character"],
  ])("rejects %j", (text, message) => {
    expect(() => parseStrictJson(text)).toThrow(message);
  });
});

describe("validateDescriptorText", () => {
  it.each(Object.keys(PAYLOADS))("accepts a valid %s descriptor", (kind) => {
    expect(checkDescriptor(descriptor(kind))).toMatchObject({ ok: true });
  });

  it.each(Object.keys(PAYLOADS))("rejects an unknown key in a %s payload", (kind) => {
    const value = descriptor(kind);
    (value.payload as Record<string, unknown>).extra = true;
    expect(checkDescriptor(value).ok).toBe(false);
  });

  it.each([
    ["unknown root key", { extra: 1 }],
    ["wrong schemaVersion", { schemaVersion: 1 }],
    ["unknown kind", { kind: "widget" }],
    ["name with double hyphen", { name: "a--b" }],
    ["name starting with a digit", { name: "1abc" }],
    ["name too short", { name: "ab" }],
    ["non-semver version", { version: "1.2" }],
    ["ranged minAppVersion", { minAppVersion: ">=0.12.0" }],
    ["http homepage", { homepage: "http://example.com" }],
    ["svg icon", { icon: "icon.svg" }],
    ["icon escaping the repo", { icon: "../icon.png" }],
    ["empty platforms", { platforms: [] }],
    ["unknown platform", { platforms: ["amiga"] }],
    ["missing payload", { payload: undefined }],
  ])("rejects a descriptor with %s", (_label, patch) => {
    expect(checkDescriptor(descriptor("skill", patch)).ok).toBe(false);
  });

  it("rejects duplicate keys even when both values are valid", () => {
    const text = JSON.stringify(descriptor("skill")).replace('"version":"1.2.0"', '"version":"1.2.0","version":"9.9.9"');
    const result = validateDescriptorText(text, { direct: false });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("duplicate key");
  });

  it("checks kind and name against the index entry that pointed here", () => {
    const text = JSON.stringify(descriptor("skill"));
    expect(validateDescriptorText(text, { direct: false, expected: { kind: "skill", name: "sample-skill" } }).ok).toBe(true);
    expect(validateDescriptorText(text, { direct: false, expected: { kind: "agent", name: "sample-skill" } }).ok).toBe(false);
    expect(validateDescriptorText(text, { direct: false, expected: { kind: "skill", name: "other" } }).ok).toBe(false);
  });

  describe("plugin rules", () => {
    const withPayload = (payload: Record<string, unknown>) => descriptor("plugin", { payload });

    it("refuses the plugin name host in a direct source and in a repository", () => {
      for (const direct of [true, false]) {
        const result = checkDescriptor(descriptor("plugin", { name: "host" }), direct);
        expect(result).toEqual({ ok: false, error: "ave-package.json: the plugin name host is reserved for the host" });
      }
      expect(checkDescriptor(descriptor("skill", { name: "host" })).ok).toBe(true);
    });

    it("requires authority.requires.minAppVersion equal to minAppVersion", () => {
      const mismatch = authority();
      mismatch.requires.minAppVersion = "0.11.0";
      expect(checkDescriptor(withPayload({ authority: mismatch, artifact: { tree: "plugins/x" } })).ok).toBe(false);
      const { requires: _drop, ...noRequires } = authority();
      expect(checkDescriptor(withPayload({ authority: noRequires, artifact: { tree: "plugins/x" } })).ok).toBe(false);
    });

    it("uses the manifest's own field definitions for authority", () => {
      const badDomain = { ...authority(), networkAccess: { allowedDomains: ["https://api.example.com/"] } };
      expect(checkDescriptor(withPayload({ authority: badDomain, artifact: { tree: "plugins/x" } })).ok).toBe(false);
      const badSecret = { ...authority(), hostSecrets: { read: ["marketplace.apiKey"] } };
      expect(checkDescriptor(withPayload({ authority: badSecret, artifact: { tree: "plugins/x" } })).ok).toBe(false);
      const unknownField = { ...authority(), installPolicy: "admin" };
      expect(checkDescriptor(withPayload({ authority: unknownField, artifact: { tree: "plugins/x" } })).ok).toBe(false);
    });

    it("requires a release repo in a marketplace repository but not in a direct source", () => {
      const payload = { authority: authority(), artifact: { release: { sha256: SHA } } };
      expect(checkDescriptor(withPayload(payload)).ok).toBe(false);
      expect(checkDescriptor(withPayload(payload), true).ok).toBe(true);
      expect(checkDescriptor(withPayload({ authority: authority(), artifact: { release: { url: "https://dl.example.com/a.zip", sha256: SHA } } })).ok).toBe(true);
    });

    it("accepts a release or archive without a pin, which the ladder skips as ARTIFACT_NOT_PINNED (design §6.2)", () => {
      expect(checkDescriptor(withPayload({ authority: authority(), artifact: { release: { repo: "acme/alpha" } } })).ok).toBe(true);
      expect(checkDescriptor(withPayload({ authority: authority(), artifact: { archive: { url: "https://dl.example.com/a.zip" } } })).ok).toBe(true);
    });

    // Catalog-supplied http downloads are accepted (design §18.2.3, decision 5 of §18):
    // the pin, read over the source's own transport, fixes the bytes, and the
    // Delivery row says "unencrypted download — verified by the pinned sha256".
    it.each([
      ["a release", { release: { url: "http://git.corp.example/root/api/v4/projects/7/packages/generic/alpha/1.2.0/alpha-1.2.0.zip", sha256: SHA } }],
      ["an archive", { archive: { url: "http://dl.example.com/a.zip", sha256: SHA } }],
      ["a release on a port", { release: { url: "http://git.corp.example:8080/alpha-1.2.0.zip", sha256: SHA } }],
    ])("accepts %s pinned over plain http", (_label, artifact) => {
      expect(checkDescriptor(withPayload({ authority: authority(), artifact }))).toMatchObject({ ok: true });
    });

    it.each([
      ["no artifact rung", {}],
      ["a release over ftp", { release: { url: "ftp://dl.example.com/a.zip", sha256: SHA } }],
      ["an archive from a file URL", { archive: { url: "file:///tmp/a.zip", sha256: SHA } }],
      ["a release URL with whitespace", { release: { url: "http://dl.example.com/a b.zip", sha256: SHA } }],
      ["a scheme-relative archive", { archive: { url: "//dl.example.com/a.zip", sha256: SHA } }],
      ["uppercase sha256", { release: { repo: "acme/alpha", sha256: SHA.toUpperCase() } }],
      ["url combined with repo", { release: { repo: "acme/alpha", url: "https://dl.example.com/a.zip", sha256: SHA } }],
      ["tree escaping the repo", { tree: "../elsewhere" }],
    ])("rejects %s", (_label, artifact) => {
      expect(checkDescriptor(withPayload({ authority: authority(), artifact })).ok).toBe(false);
    });
  });

  describe("mcp rules", () => {
    const stdio = (server: Record<string, unknown>) => descriptor("mcp", { payload: { server: { transport: "stdio", ...server } } });

    it.each([
      ["a launcher", { command: "uvx" }],
      ["a package-local command", { command: "server/bin/run" }],
      ["an http server", undefined],
      ["a server.json selection", undefined],
    ])("accepts %s", (label, server) => {
      if (label === "an http server") {
        expect(checkDescriptor(descriptor("mcp", { payload: { server: { transport: "http", url: "https://mcp.example.com/sse", auth: "oauth" } } })).ok).toBe(true);
      } else if (label === "a server.json selection") {
        expect(checkDescriptor(descriptor("mcp", { payload: { serverJson: "server.json", select: { package: 0 } } })).ok).toBe(true);
      } else {
        expect(checkDescriptor(stdio(server!)).ok).toBe(true);
      }
    });

    it.each([
      ["an absolute command", { command: "/bin/sh" }],
      ["a command outside server/", { command: "tools/run" }],
      ["a traversing command", { command: "server/../../bin/sh" }],
      ["a command traversing with backslashes", { command: "server/..\\..\\Windows\\System32\\cmd.exe" }],
      ["a command with a drive", { command: "server/C:\\Windows\\cmd.exe" }],
      ["a reserved env name", { command: "npx", env: { PATH: "/tmp" } }],
      ["a reserved apiKeyEnv", { command: "npx", apiKeyEnv: "NODE_OPTIONS" }],
      ["private-network access", { command: "npx", allowPrivateNetworks: true }],
      ["an invalid env name", { command: "npx", env: { "BAD-NAME": "x" } }],
    ])("rejects %s", (_label, server) => {
      expect(checkDescriptor(stdio(server)).ok).toBe(false);
    });

    it("rejects a reserved header and a plain-http server", () => {
      expect(checkDescriptor(descriptor("mcp", { payload: { server: { transport: "http", url: "https://mcp.example.com", apiKeyHeader: "Host" } } })).ok).toBe(false);
      expect(checkDescriptor(descriptor("mcp", { payload: { server: { transport: "http", url: "http://mcp.example.com" } } })).ok).toBe(false);
    });
  });

  it.each([
    ["language locale", "language", { locale: "Korean", entry: "language.json", messages: "messages.json" }],
    ["skill entry", "skill", { entry: "README.md" }],
    ["theme entry", "theme", { entry: "theme.css" }],
  ])("rejects a wrong %s", (_label, kind, payload) => {
    expect(checkDescriptor(descriptor(kind, { payload })).ok).toBe(false);
  });
});

function index(packages: unknown[], patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 2, name: "acme", displayName: "Acme", packages, ...patch });
}

const version = (v: string, patch: Record<string, unknown> = {}) => ({
  version: v,
  commit: COMMIT,
  minAppVersion: "0.12.0",
  publishedAt: AT,
  ...patch,
});

const pluginVersion = (v: string, patch: Record<string, unknown> = {}) =>
  version(v, { authority: authority(), artifact: { release: { repo: "acme/alpha", sha256: SHA } }, ...patch });

describe("validateIndexText", () => {
  const context = { sourceId: "acme", official: false };

  it("accepts only format-2 agent-plugin components and keeps invalid path claimants isolated", () => {
    expect(checkDescriptor(descriptor("agent-plugin")).ok).toBe(true);
    expect(checkDescriptor(descriptor("agent-plugin", { hostProtocol: "1" })).ok).toBe(false);
    expect(checkDescriptor(descriptor("agent-plugin", { payload: { manifest: "plugin.json", components: { skills: [], mcpServers: {}, prompts: [], agents: [], routineTemplates: [], hooks: [], unexpected: true } } })).ok).toBe(false);
    const components = PAYLOADS["agent-plugin"]!().components;
    const result = validateIndexText(index([
      { kind: "agent-plugin", name: "invalid-plugin", path: "skills/shared", versions: [version("1.0.0")] },
      { kind: "agent-plugin", name: "unknown-plugin", path: "skills/shared", versions: [version("1.0.0", { components, extra: 1 })] },
      { kind: "skill", name: "valid-skill", path: "skills/shared" },
      { kind: "agent-plugin", name: "valid-plugin", path: "agent-plugins/valid", versions: [version("1.0.0", { components })] },
    ]), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages.map((entry) => entry.name)).toEqual(["valid-skill", "valid-plugin"]);
    expect(result.value.diagnostics).toHaveLength(2);
  });

  it("accepts an index with path-only entries and entries with versions", () => {
    const result = validateIndexText(
      index([
        { kind: "skill", name: "sample-skill", path: "skills/sample-skill" },
        { kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "1.1.0", versions: [pluginVersion("1.1.0"), pluginVersion("1.0.0")] },
      ]),
      context,
    );
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    expect(result.ok && result.value.index.packages).toHaveLength(2);
  });

  it("keeps a plugin version whose release is pinned over plain http", () => {
    const http = { release: { url: "http://git.corp.example/root/api/v4/projects/7/packages/generic/alpha/1.1.0/alpha-1.1.0.zip", sha256: SHA } };
    const result = validateIndexText(
      index([{ kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "1.1.0", versions: [pluginVersion("1.1.0", { artifact: http })] }]),
      context,
    );
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    expect(result.ok && result.value.index.packages[0]?.versions?.[0]?.artifact).toEqual(http);
  });

  it("admits a legacy grant pin only as a yanked plugin version pinning its release digest (design §16.3)", () => {
    const NULL_COMMIT = "0".repeat(40);
    const yanked = { reason: "Legacy field pin: receipt grant evidence only. Not installable.", at: AT };
    const pin = (patch: Record<string, unknown> = {}) => pluginVersion("0.9.0", { commit: NULL_COMMIT, yanked, ...patch });
    const listing = (kind: string, versions: unknown[]) =>
      validateIndexText(index([{ kind, name: "fixturepin", path: kind === "plugin" ? "plugins/fixturepin" : "skills/fixturepin", versions }]), context);
    const kept = (result: ReturnType<typeof validateIndexText>) => (result.ok ? result.value.index.packages.length : -1);

    expect(kept(listing("plugin", [pluginVersion("1.0.0"), pin()]))).toBe(1);
    // Each of these would hand git a commit that names no tree, or offer what cannot install.
    expect(kept(listing("plugin", [pin({ yanked: undefined })]))).toBe(0);
    expect(kept(listing("plugin", [pin({ artifact: { release: { repo: "acme/alpha", tag: "v0.9.0", asset: "a.zip", sha256: SHA } } })]))).toBe(0);
    expect(kept(listing("plugin", [pin({ artifact: { release: { repo: "acme/alpha", sha256: SHA }, tree: "plugins/fixturepin/build" } })]))).toBe(0);
    expect(kept(listing("plugin", [pin({ artifact: { release: { repo: "acme/alpha" } } })]))).toBe(0);
    expect(kept(listing("skill", [version("0.9.0", { commit: NULL_COMMIT, yanked })]))).toBe(0);
  });

  it.each([
    ["unparseable JSON", "{"],
    ["an unknown root key", index([], { extra: 1 })],
    ["a wrong schemaVersion", index([], { schemaVersion: 1 })],
    ["duplicate root keys", index([]).replace('"name":"acme"', '"name":"acme","name":"other"')],
    ["a packages object", JSON.stringify({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: {} })],
  ])("rejects the whole index for %s", (_label, text) => {
    expect(validateIndexText(text, context).ok).toBe(false);
  });

  it.each([1, 3, "2", null])("names schemaVersion %j as unsupported in the index and a descriptor", (schemaVersion) => {
    const expected = `schemaVersion ${JSON.stringify(schemaVersion)} is not supported; this app reads schemaVersion 2`;
    expect(validateIndexText(index([], { schemaVersion }), context)).toEqual({ ok: false, error: `marketplace.json: ${expected}` });
    expect(checkDescriptor(descriptor("skill", { schemaVersion }))).toEqual({ ok: false, error: `ave-package.json: ${expected}` });
  });

  it("requires the official index to carry the official id", () => {
    expect(validateIndexText(index([]), { sourceId: "ave", official: true }).ok).toBe(false);
    expect(validateIndexText(index([], { name: "ave" }), { sourceId: "ave", official: true }).ok).toBe(true);
  });

  it.each([
    ["an unknown package key", { kind: "skill", name: "bad-one", path: "skills/bad", extra: 1 }],
    ["a traversing path", { kind: "skill", name: "bad-one", path: "skills/../x" }],
    ["latest without versions", { kind: "skill", name: "bad-one", path: "skills/bad", latest: "1.0.0" }],
    ["latest not listed", { kind: "skill", name: "bad-one", path: "skills/bad", latest: "2.0.0", versions: [version("1.0.0")] }],
    ["a yanked latest", { kind: "skill", name: "bad-one", path: "skills/bad", latest: "1.0.0", versions: [version("1.0.0", { yanked: { reason: "broken", at: AT } })] }],
    ["versions out of order", { kind: "skill", name: "bad-one", path: "skills/bad", versions: [version("1.0.0"), version("1.1.0")] }],
    ["a repeated version", { kind: "skill", name: "bad-one", path: "skills/bad", versions: [version("1.0.0"), version("1.0.0")] }],
    ["a short commit", { kind: "skill", name: "bad-one", path: "skills/bad", versions: [version("1.0.0", { commit: "abc" })] }],
    ["a zero rollout", { kind: "skill", name: "bad-one", path: "skills/bad", versions: [version("1.0.0", { rollout: { percent: 0 } })] }],
    ["authority on a skill", { kind: "skill", name: "bad-one", path: "skills/bad", versions: [version("1.0.0", { authority: authority() })] }],
    ["a plugin version without artifact", { kind: "plugin", name: "bad-one", path: "plugins/bad", versions: [version("1.0.0", { authority: authority() })] }],
    ["a plugin release pin without repo", { kind: "plugin", name: "bad-one", path: "plugins/bad", versions: [pluginVersion("1.0.0", { artifact: { release: { sha256: SHA } } })] }],
    ["a plugin minAppVersion mismatch", { kind: "plugin", name: "bad-one", path: "plugins/bad", versions: [pluginVersion("1.0.0", { minAppVersion: "0.13.0" })] }],
  ])("drops a package with %s and keeps the rest", (_label, bad) => {
    const result = validateIndexText(index([bad, { kind: "agent", name: "good-agent", path: "agents/good" }]), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages.map((entry) => entry.name)).toEqual(["good-agent"]);
    expect(result.value.diagnostics).toHaveLength(1);
  });

  it("drops every claimant of a repeated (kind, name) or path", () => {
    const result = validateIndexText(
      index([
        { kind: "skill", name: "twin", path: "skills/a" },
        { kind: "skill", name: "twin", path: "skills/b" },
        { kind: "agent", name: "twin", path: "agents/twin" },
        { kind: "theme", name: "one", path: "shared" },
        { kind: "font", name: "two", path: "shared" },
      ]),
      context,
    );
    expect(result.ok && result.value.index.packages.map((entry) => `${entry.kind}/${entry.name}`)).toEqual(["agent/twin"]);
    expect(result.ok && result.value.diagnostics).toHaveLength(4);
  });

  it("counts an invalid name claimant but leaves its path available", () => {
    const result = validateIndexText(
      index([
        { kind: "skill", name: "alpha", path: "skills/alpha" },
        { kind: "skill", name: "alpha", path: "skills/alpha-2", unknown: true },
        { kind: "agent", name: "beta", path: "agents/beta" },
        { kind: "agent", name: "gamma", path: "agents/beta", unknown: true },
      ]),
      context,
    );
    expect(result.ok && result.value.index.packages.map((entry) => entry.name)).toEqual(["beta"]);
  });

  it.each([
    ["an unknown field", { kind: "skill", name: "invalid-package", path: "skills/shared", unknown: true }],
    ["a latest version without versions", { kind: "skill", name: "invalid-package", path: "skills/shared", latest: "1.0.0" }],
  ])("does not let a package with %s claim a valid package path", (_label, invalid) => {
    const result = validateIndexText(index([
      invalid,
      { kind: "skill", name: "valid-package", path: "skills/shared" },
    ]), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages.map((entry) => entry.name)).toEqual(["valid-package"]);
    expect(result.value.diagnostics).toHaveLength(1);
  });
});

describe("identifiers with a credential's shape (§18.8)", () => {
  const context = { sourceId: "acme", official: false };
  // Assembled here so no whole token sits in the source: one fits a package name, one an MCP server's key.
  const NAME_TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;
  const KEY_TOKEN = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
  const components = (server: string) => deriveAgentPluginComponents([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer", version: "1.0.0", description: "Writes" })) },
    { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [server]: { type: "stdio", command: "./server/editor", args: [] } } })) },
    { path: "server/editor", data: Buffer.from("#!/bin/sh\n") },
  ]);

  it.each([
    ["a name", { kind: "skill", name: NAME_TOKEN, path: "skills/a" }, "packages[0]", "its name uses the reserved prefix glpat-, which looks like a GitLab token; choose a different one"],
    ["a version", { kind: "skill", name: "notes", path: "skills/a", latest: `1.0.0-${NAME_TOKEN}`, versions: [version(`1.0.0-${NAME_TOKEN}`)] }, "skill/notes", "a version uses the reserved prefix glpat-, which looks like a GitLab token; choose a different one"],
    ["an MCP server's name", { kind: "agent-plugin", name: "writer", path: "agent-plugins/writer", versions: [version("1.0.0", { components: components(KEY_TOKEN) })] }, "agent-plugin/writer", "a component name uses the reserved prefix ghp_, which looks like a GitHub token; choose a different one"],
  ])("drops an index entry whose %s has one, named without it, and keeps the rest", (_label, bad, subject, message) => {
    const result = validateIndexText(index([bad, { kind: "skill", name: "good-skill", path: "skills/good" }]), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index.packages.map((entry) => entry.name)).toEqual(["good-skill"]);
    expect(result.value.diagnostics).toEqual([{ subject, message }]);
  });

  it("names an entry by its position when its name has one, whatever else is wrong with it", () => {
    const result = validateIndexText(index([{ kind: "skill", name: NAME_TOKEN, path: "skills/a", unknown: true }]), context);
    expect(result.ok && result.value.diagnostics.map((item) => item.subject)).toEqual(["packages[0]"]);
  });

  it.each([
    ["a name", descriptor("skill", { name: NAME_TOKEN }), { reason: "name-reserved-prefix", prefix: "glpat-", issuer: "gitlab" }],
    ["a version", descriptor("skill", { version: `1.0.0-${NAME_TOKEN}` }), { reason: "version-reserved-prefix", prefix: "glpat-", issuer: "gitlab" }],
    ["an MCP server's name", descriptor("agent-plugin", { payload: { manifest: "plugin.json", components: components(KEY_TOKEN) } }), { reason: "component-reserved-prefix", prefix: "ghp_", issuer: "github" }],
  ])("refuses a descriptor whose %s has one, naming its reserved prefix", (_label, value, credential) => {
    expect(checkDescriptor(value)).toMatchObject({ ok: false, credential });
  });

  it("refuses a shape with no prefix to name as a credential's shape", () => {
    expect(credentialRefusal("component", "password=hunter2")).toEqual({ detail: { reason: "component-holds-credential" }, message: "a component name looks like a password or token" });
    expect(credentialRefusal("version", `1.0.0+${NAME_TOKEN}`)).toMatchObject({ detail: { reason: "version-reserved-prefix", prefix: "glpat-", issuer: "gitlab" } });
  });

  it("keeps identifiers that only look like a credential's prefix", () => {
    const alike = ["test-marketplace2026", "live-notifications2026", "sk-proj-tools", "npm-audit-helper", "glpat-rotation-docs"];
    const result = validateIndexText(index([
      ...alike.map((name) => ({ kind: "skill", name, path: `skills/${name}` })),
      { kind: "agent-plugin", name: "writer", path: "agent-plugins/writer", versions: [version("1.0.0-test-marketplace2026", { components: components("test_marketplace2026") })] },
    ]), context);
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    for (const name of alike) expect(checkDescriptor(descriptor("skill", { name })).ok, name).toBe(true);
    expect(checkDescriptor(descriptor("agent-plugin", { version: "1.0.0-test-marketplace2026", payload: { manifest: "plugin.json", components: components("test_marketplace2026") } })).ok).toBe(true);
  });
});

describe("one detector for admission and egress (§18.8)", () => {
  const context = { sourceId: "acme", official: false };
  // A task id from a digest of ordinary content, not a token renamed: SHA-224 hex after `task-`.
  const taskDigest = `task-${createHash("sha224").update("ordinary task inputs").digest("hex")}`;
  const base32Digest = "al62ny3xigdbyafl7irut3jbxlrld5chtn2dxghblz6hml2otyqq";
  /** Ordinary names an id or package may have. */
  const ORDINARY_IDS = [
    "test-marketplace2026", "test-integration123", "live-notifications2026", "live-captions", "npm-audit-helper",
    "glpat-rotation-docs", "sk-proj-tools", "sk-learn-utils", "akiak-production", "task-sk-learn-utils",
    "task-prepare-marketplace-folder-source-diagnostics", "task-proj-build-the-user-interface-for-the-marketplace", taskDigest,
  ];
  /** Ordinary values that are not ids: names with other characters, commits, digests, build metadata. */
  const ORDINARY_VALUES = [
    "npm_scripts", "AKIA-example-not-a-token", "laughs_compilation-of-the-best-moments.mp4",
    "0123456789abcdef0123456789abcdef01234567", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    `1.0.0+${base32Digest}`, `1.0.0+${taskDigest}`,
  ];

  it.each([...ORDINARY_IDS, ...ORDINARY_VALUES])("passes %s through egress unchanged", (value) => {
    expect(holdsCredential(value)).toBe(false);
    expect(scrubDiagnosticSecrets(value)).toBe(value);
  });

  it.each(ORDINARY_IDS)("admits %s as a source id, a package name and an index entry, so egress leaves what admission took", (id) => {
    expect(isSourceId(id)).toBe(true);
    expect(checkDescriptor(descriptor("skill", { name: id }))).toMatchObject({ ok: true });
    expect(checkDescriptor(descriptor("skill", { version: `1.0.0+${id}` }))).toMatchObject({ ok: true });
    const result = validateIndexText(index([{ kind: "skill", name: id, path: "skills/x" }]), context);
    expect(result).toMatchObject({ ok: true, value: { diagnostics: [] } });
    expect(result.ok && result.value.index.packages.map((entry) => entry.name)).toEqual([id]);
  });

  // Assembled here so no whole token sits in the source: one fits an id's grammar, one does not.
  const ID_TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;
  const MIXED_TOKEN = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
  const BOUNDARIES = ["", "x_", "x-", "x.", "x/", "x:", "x=", "x ", 'x"', "x'"];

  it.each(BOUNDARIES)("refuses and masks a credential shape after %j", (before) => {
    for (const token of [ID_TOKEN, MIXED_TOKEN]) {
      const text = `${before}${token}`;
      expect(holdsCredential(text), text).toBe(true);
      expect(scrubDiagnosticSecrets(text)).not.toContain(token);
    }
    // Where the result is an id's grammar, admission refuses it.
    const id = `${before}${ID_TOKEN}`;
    if (/^[a-z0-9-]+$/u.test(id)) {
      expect(isSourceId(id)).toBe(false);
      expect(checkDescriptor(descriptor("skill", { name: id }))).toMatchObject({ ok: false, credential: { reason: "name-reserved-prefix", prefix: "glpat-", issuer: "gitlab" } });
    }
  });

  it.each([
    ["glpat-rotation-documentation-for-local-marketplaces", "glpat-", "gitlab"],
    ["docs-glpat-rotation-documentation-for-local-marketplaces", "glpat-", "gitlab"],
    ["sk-proj-build-the-user-interface-for-the-marketplace", "sk-proj-", "openai"],
    [`sk-${createHash("sha224").update("ordinary task inputs").digest("hex")}`, "sk-", "openai"],
  ])("reserves %s: an ordinary name under a reserved prefix is refused, naming the prefix (§18.8)", (id, prefix, issuer) => {
    expect(isSourceId(id)).toBe(false);
    expect(checkDescriptor(descriptor("skill", { name: id }))).toMatchObject({ ok: false, credential: { reason: "name-reserved-prefix", prefix, issuer } });
    expect(checkDescriptor(descriptor("skill", { version: `1.0.0+${id}` }))).toMatchObject({ ok: false, credential: { reason: "version-reserved-prefix", prefix, issuer } });
  });

  it("leaves a prefix glued to a letter or digit to the documented residual", () => {
    // `ta` + `sk-proj-…` is the word `task-proj-…`: refusing such names would refuse ordinary ones (§18.8).
    expect(holdsCredential(`backup${MIXED_TOKEN}`)).toBe(false);
  });
});

describe("revocations", () => {
  const file = (revocations: unknown[]) => JSON.stringify({ schemaVersion: 1, revocations });
  const entry = (versions: string) => ({ kind: "plugin", name: "alpha", versions, reason: "leaks tokens", at: AT, action: "disable" });

  it("accepts valid ranges and rejects invalid ones", () => {
    expect(validateRevocationsText(file([entry(">=1.0.0 <1.2.3"), entry("*"), entry("1.0.0 || 2.0.0-beta.1")])).ok).toBe(true);
    for (const range of ["latest", ">= 1.0.0", "1.0", "||1.0.0", "~1.2.3"]) {
      expect(validateRevocationsText(file([entry(range)])).ok).toBe(false);
    }
    expect(validateRevocationsText(file([{ ...entry("*"), action: "delete" }])).ok).toBe(false);
  });

  it("matches versions against ranges with the host's precedence", () => {
    const range = parseVersionRange(">=1.0.0 <1.2.3 || =2.0.0");
    expect(rangeIncludes(range, "1.0.0")).toBe(true);
    expect(rangeIncludes(range, "1.2.2")).toBe(true);
    expect(rangeIncludes(range, "1.2.3")).toBe(false);
    expect(rangeIncludes(range, "1.2.3-rc.1")).toBe(true);
    expect(rangeIncludes(range, "2.0.0")).toBe(true);
    expect(rangeIncludes(parseVersionRange("*"), "0.0.1")).toBe(true);
  });
});
