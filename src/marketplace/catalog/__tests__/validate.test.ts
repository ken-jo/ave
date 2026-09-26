import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../strict-json.js";
import {
  validateDescriptorText,
  validateIndexText,
  validateRevocationsText,
} from "../validate.js";
import { parseVersionRange, rangeIncludes } from "../version-range.js";

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
    schemaVersion: 1,
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
    ["wrong schemaVersion", { schemaVersion: 2 }],
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

    it.each([
      ["no artifact rung", {}],
      ["archive over http", { archive: { url: "http://dl.example.com/a.zip", sha256: SHA } }],
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
  return JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Acme", packages, ...patch });
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

  it.each([
    ["unparseable JSON", "{"],
    ["an unknown root key", index([], { extra: 1 })],
    ["a wrong schemaVersion", index([], { schemaVersion: 2 })],
    ["duplicate root keys", index([]).replace('"name":"acme"', '"name":"acme","name":"other"')],
    ["a packages object", JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Acme", packages: {} })],
  ])("rejects the whole index for %s", (_label, text) => {
    expect(validateIndexText(text, context).ok).toBe(false);
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

  it("counts an invalid entry as a claimant too", () => {
    const result = validateIndexText(
      index([
        { kind: "skill", name: "alpha", path: "skills/alpha" },
        { kind: "skill", name: "alpha", path: "skills/alpha-2", unknown: true },
        { kind: "agent", name: "beta", path: "agents/beta" },
        { kind: "agent", name: "gamma", path: "agents/beta", unknown: true },
      ]),
      context,
    );
    expect(result.ok && result.value.index.packages).toEqual([]);
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
