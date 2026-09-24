import { describe, expect, it } from "vitest";
import { moonstoneBundle } from "../../ui/renderer/theme/bundles/moonstone.js";
import { checkMarketplaceRepository, type RepositoryTree } from "../repository-check.js";

const COMMIT = "a".repeat(40);
const SHA = "b".repeat(64);
const AT = "2026-09-24T00:00:00Z";

const authority = () => ({ capabilities: [], requires: { minAppVersion: "0.12.0" } });
const artifact = () => ({ release: { repo: "acme/market", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip", sha256: SHA } });
const SURFACES = {
  "surface-sunken": "228 30% 97%",
  surface: "0 0% 100%",
  "surface-raised": "0 0% 100%",
  "surface-overlay": "0 0% 100%",
  "border-subtle": "228 24% 94%",
  "border-strong": "228 18% 84%",
};

function descriptor(kind: string, name: string, payload: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  return { schemaVersion: 1, kind, name, version: "1.0.0", minAppVersion: "0.12.0", payload, ...patch };
}

function version(patch: Record<string, unknown> = {}) {
  return { version: "1.0.0", commit: COMMIT, minAppVersion: "0.12.0", publishedAt: AT, ...patch };
}

/** A repository with one package of four kinds, each valid, and its index. */
function validFiles(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "marketplace.json",
      {
        schemaVersion: 1,
        name: "ave",
        displayName: "Ave Official",
        packages: [
          { kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "1.0.0", versions: [version({ authority: authority(), artifact: artifact() })] },
          { kind: "theme", name: "harbor", path: "themes/harbor", latest: "1.0.0", versions: [version()] },
          { kind: "mcp", name: "search", path: "mcp/search", latest: "1.0.0", versions: [version()] },
          { kind: "skill", name: "review", path: "skills/review", latest: "1.0.0", versions: [version()] },
        ],
      },
    ],
    ["plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: authority(), artifact: artifact() })],
    ["plugins/alpha/source/package.json", { name: "@acme/alpha" }],
    ["themes/harbor/ave-package.json", descriptor("theme", "harbor", { entry: "theme.json" })],
    [
      "themes/harbor/theme.json",
      { name: "Harbor", description: "Blue light.", shell: "light", highContrast: false, tokens: moonstoneBundle.tokens, surfaces: SURFACES },
    ],
    ["mcp/search/ave-package.json", descriptor("mcp", "search", { serverJson: "server.json" })],
    [
      "mcp/search/server.json",
      {
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.acme/search",
        description: "Search",
        version: "1.0.0",
        packages: [{ registryType: "npm", identifier: "@acme/search-mcp", version: "1.0.0", transport: { type: "stdio" } }],
      },
    ],
    ["skills/review/ave-package.json", descriptor("skill", "review", { entry: "SKILL.md" })],
    ["skills/review/SKILL.md", "---\nname: review\ndescription: Review a change.\n---\nRead the diff first.\n"],
    ["policy/revocations.json", { schemaVersion: 1, revocations: [] }],
  ]);
}

function tree(files: Map<string, unknown>): RepositoryTree {
  const bytes = new Map([...files].map(([path, value]) => [path, Buffer.from(typeof value === "string" ? value : JSON.stringify(value))]));
  return {
    read: (path) => bytes.get(path) ?? null,
    list: (dir) => [...bytes.keys()].filter((path) => dir === "" || path.startsWith(`${dir}/`)).sort(),
  };
}

const OFFICIAL = { sourceId: "ave", official: true };

function check(files: Map<string, unknown>) {
  return checkMarketplaceRepository(tree(files), OFFICIAL);
}

function index(files: Map<string, unknown>) {
  return files.get("marketplace.json") as { packages: Array<Record<string, unknown>>; name: string };
}

describe("checkMarketplaceRepository", () => {
  it("accepts a repository the app would accept", () => {
    expect(check(validFiles())).toEqual([]);
  });

  it("refuses a missing or invalid index outright", () => {
    const files = validFiles();
    files.delete("marketplace.json");
    expect(check(files)).toEqual([{ subject: "marketplace.json", message: "is missing" }]);
    const renamed = validFiles();
    index(renamed).name = "other";
    expect(check(renamed)).toEqual([{ subject: "marketplace.json", message: expect.stringContaining('must be named "ave"') }]);
  });

  it("reports a descriptor the index copy disagrees with", () => {
    const files = validFiles();
    files.set("themes/harbor/ave-package.json", descriptor("theme", "harbor", { entry: "theme.json" }, { minAppVersion: "0.13.0" }));
    expect(check(files)).toEqual([{ subject: "theme/harbor", message: expect.stringContaining("differs from themes/harbor/ave-package.json in minAppVersion") }]);
  });

  it("reports a plugin whose index authority or pins differ from its descriptor", () => {
    const files = validFiles();
    const plugin = index(files).packages[0]!;
    plugin.versions = [version({ authority: authority(), artifact: { release: { ...artifact().release, sha256: "c".repeat(64) } } })];
    expect(check(files)).toEqual([{ subject: "plugin/alpha", message: expect.stringContaining("in artifact") }]);
  });

  it("holds a plugin tree to the tree rung's layout and the git-install manifest rules", () => {
    const files = validFiles();
    files.set("plugins/alpha/plugin.json", { name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": { installPolicy: "admin", capabilities: [], requires: { minAppVersion: "0.12.0" } } } });
    const messages = check(files).map((problem) => problem.message);
    expect(messages).toContainEqual(expect.stringContaining("plugins/alpha/source/package.json: the tree rung installs plugin.json, dist/ and assets/ only"));
    expect(messages).toContainEqual(expect.stringContaining("installPolicy is no longer supported"));
  });

  it("holds each released plugin.json to its index version when the caller supplies it", () => {
    const manifest = (patch: Record<string, unknown>, at = "1.0.0") => ({ name: "alpha", version: at, extensions: { "ai.agent-connector.ave": { ...authority(), ...patch } } });
    const released = (entries: Array<[string, unknown]>) => ({ ...OFFICIAL, releasedManifests: new Map(entries) });
    expect(checkMarketplaceRepository(tree(validFiles()), released([["alpha@1.0.0", manifest({})]]))).toEqual([]);
    expect(checkMarketplaceRepository(tree(validFiles()), released([["alpha@1.0.0", manifest({ capabilities: ["host:tasks"] })]]))).toEqual([
      { subject: "plugin/alpha", message: "the released plugin.json of 1.0.0: capabilities differs from the descriptor's authority" },
    ]);
    expect(checkMarketplaceRepository(tree(validFiles()), released([["alpha@0.9.0", manifest({}, "0.9.0")]]))).toEqual([
      { subject: "plugin/alpha", message: "a released plugin.json was supplied for alpha@0.9.0, which the index does not list" },
    ]);
    // A key naming no listed plugin (a typo, or a package the index dropped) is not skipped.
    expect(checkMarketplaceRepository(tree(validFiles()), released([["alhpa@1.0.0", manifest({})]]))).toEqual([
      { subject: "alhpa@1.0.0", message: "a released plugin.json was supplied for a plugin the index does not list" },
    ]);
  });

  it("lets only a yanked field pin carry the installPolicy and publisher of its era", () => {
    const files = validFiles();
    const fieldPin = version({ version: "0.9.0", authority: authority(), artifact: { release: { ...artifact().release, tag: "alpha-v0.9.0", asset: "alpha-0.9.0.zip" } } });
    index(files).packages[0]!.versions = [version({ authority: authority(), artifact: artifact() }), fieldPin];
    const legacy = { name: "alpha", version: "0.9.0", extensions: { "ai.agent-connector.ave": { ...authority(), installPolicy: "admin", publisher: "Ave Official" } } };
    const run = () => checkMarketplaceRepository(tree(files), { ...OFFICIAL, releasedManifests: new Map([["alpha@0.9.0", legacy]]) });
    expect(run()).toEqual([
      { subject: "plugin/alpha", message: expect.stringContaining("the released plugin.json of 0.9.0: installPolicy is no longer supported") },
      { subject: "plugin/alpha", message: expect.stringContaining("the released plugin.json of 0.9.0: publisher is no longer supported") },
    ]);
    Object.assign(fieldPin, { yanked: { reason: "Kept so installs of this zip keep their grant.", at: AT } });
    expect(run()).toEqual([]);
    // Everything else still has to match.
    legacy.extensions["ai.agent-connector.ave"].capabilities = ["host:tasks"] as never[];
    expect(run()).toEqual([{ subject: "plugin/alpha", message: "the released plugin.json of 0.9.0: capabilities differs from the descriptor's authority" }]);
  });

  it("holds content packages to the install rules", () => {
    const svg = validFiles();
    svg.set("themes/harbor/preview.svg", "<svg/>");
    expect(check(svg)).toEqual([{ subject: "theme/harbor", message: expect.stringContaining("SVG is not allowed") }]);
    const bad = validFiles();
    bad.set("themes/harbor/theme.json", { name: "Harbor", description: "Blue light.", shell: "light", css: "body{}" });
    expect(check(bad)).toEqual([{ subject: "theme/harbor", message: expect.stringContaining("theme.json") }]);
  });

  it("reports a listed content file it cannot read instead of checking it as empty", () => {
    const files = validFiles();
    files.set("themes/harbor/preview.png", "png");
    const listed = tree(files);
    const unreadable: RepositoryTree = { list: listed.list, read: (path) => (path === "themes/harbor/preview.png" ? null : listed.read(path)) };
    expect(checkMarketplaceRepository(unreadable, OFFICIAL)).toEqual([{ subject: "theme/harbor", message: "preview.png is listed but cannot be read" }]);
  });

  it("holds MCP packages to the launcher grammar and their files", () => {
    const unpinned = validFiles();
    unpinned.set("mcp/search/ave-package.json", descriptor("mcp", "search", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/search-mcp"] } }));
    unpinned.delete("mcp/search/server.json");
    expect(check(unpinned)).toEqual([{ subject: "mcp/search", message: expect.stringContaining("search") }]);
    const local = validFiles();
    local.set("mcp/search/ave-package.json", descriptor("mcp", "search", { server: { transport: "stdio", command: "server/run.js" } }));
    local.delete("mcp/search/server.json");
    expect(check(local)).toEqual([{ subject: "mcp/search", message: "server/run.js is not a file in the package" }]);
    const stray = validFiles();
    stray.set("mcp/search/README.md", "notes");
    expect(check(stray)).toEqual([{ subject: "mcp/search", message: expect.stringContaining("server.json and server/ only") }]);
  });

  it("reports a descriptor no index entry points at, and an invalid revocations file", () => {
    const files = validFiles();
    files.set("agents/orphan/ave-package.json", descriptor("agent", "orphan", { entry: "AGENTS.md" }));
    files.set("policy/revocations.json", { schemaVersion: 1, revocations: [{ kind: "plugin" }] });
    expect(check(files)).toEqual([
      { subject: "agents/orphan/ave-package.json", message: "no index entry points at this package" },
      { subject: "policy/revocations.json", message: expect.stringContaining("revocations.json") },
    ]);
  });
});
