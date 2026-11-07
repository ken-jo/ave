import { describe, expect, it } from "vitest";
import { checkMarketplaceRepository, type RepositoryTree } from "../repository-check.js";
import mixedHostProtocols from "./fixtures/mixed-host-protocols.json" with { type: "json" };

const COMMIT = "a".repeat(40);
const SHA = "b".repeat(64);
const AT = "2026-09-24T00:00:00Z";

const authority = () => ({ capabilities: [], requires: { minAppVersion: "0.12.0" } });
const artifact = () => ({ release: { repo: "acme/market", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip", sha256: SHA } });

function descriptor(kind: string, name: string, payload: Record<string, unknown>, patch: Record<string, unknown> = {}) {
  return { schemaVersion: 2, kind, name, version: "1.0.0", minAppVersion: "0.12.0", payload, ...patch };
}

function version(patch: Record<string, unknown> = {}) {
  return { version: "1.0.0", commit: COMMIT, minAppVersion: "0.12.0", publishedAt: AT, ...patch };
}

function validFiles(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "marketplace.json",
      {
        schemaVersion: 2,
        name: "ave",
        displayName: "Ave Official",
        packages: [
          { kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "1.0.0", versions: [version({ authority: authority(), artifact: artifact() })] },
          { kind: "skill", name: "harbor", path: "skills/harbor", latest: "1.0.0", versions: [version()] },
          { kind: "mcp", name: "search", path: "mcp/search", latest: "1.0.0", versions: [version()] },
          { kind: "skill", name: "review", path: "skills/review", latest: "1.0.0", versions: [version()] },
        ],
      },
    ],
    ["plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: authority(), artifact: artifact() })],
    ["plugins/alpha/source/package.json", { name: "@acme/alpha" }],
    ["skills/harbor/ave-package.json", descriptor("skill", "harbor", { entry: "SKILL.md" })],
    [
      "skills/harbor/SKILL.md",
      "---\nname: harbor\ndescription: Harbor instructions.\n---\nRead the change.\n",
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

const OFFICIAL = { sourceId: "ave", official: true, alertsReleaseVersion: "0.13.0" };

function check(files: Map<string, unknown>) {
  return checkMarketplaceRepository(tree(files), OFFICIAL);
}

function index(files: Map<string, unknown>) {
  return files.get("marketplace.json") as { packages: Array<Record<string, unknown>>; name: string };
}

describe("checkMarketplaceRepository", () => {
  it("reports a language package as retired even when its files are valid", () => {
    const files = validFiles();
    index(files).packages.push({ kind: "language", name: "french", path: "languages/french", latest: "1.0.0", versions: [version()] });
    files.set("languages/french/ave-package.json", descriptor("language", "french", { locale: "fr", entry: "language.json", messages: "messages.json" }));
    files.set("languages/french/language.json", { locale: "fr", nativeName: "Français", englishName: "French" });
    files.set("languages/french/messages.json", {});
    expect(check(files)).toContainEqual({ subject: "language/french", message: "Language packages are retired" });
  });

  it.each([false, true])("validates mixed descriptors while keeping foreign-only descriptors listed (foreign-only %j)", (foreignOnly) => {
    const files = validFiles();
    const input = structuredClone(mixedHostProtocols);
    const entry = input.packages[0]!;
    entry.name = "alpha";
    entry.path = "plugins/alpha";
    entry.latest = "0.10.2";
    if (foreignOnly) entry.versions.shift();
    const old = entry.versions.find((version) => version.hostProtocol === "3")!;
    index(files).packages[0] = entry;
    const descriptorAuthority = foreignOnly ? old.authority : { capabilities: [], requires: old.authority.requires };
    files.set("plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: descriptorAuthority, artifact: old.artifact }, {
      version: old.version, minAppVersion: old.minAppVersion, hostProtocol: old.hostProtocol,
    }));
    expect(checkMarketplaceRepository(tree(files), {
      ...OFFICIAL, releasedManifests: new Map([[`alpha@${old.version}`, { historical: true }]]),
    })).toEqual(foreignOnly ? [] : [{ subject: "plugin/alpha", message: expect.stringContaining("the index's newest version differs from plugins/alpha/ave-package.json") }]);
  });

  it("checks stale mixed-package descriptors and their tree layout and process entry", () => {
    const files = validFiles();
    const entry = structuredClone(mixedHostProtocols.packages[0]!);
    entry.name = "alpha";
    entry.path = "plugins/alpha";
    const current = entry.versions[0]!;
    const old = entry.versions[1]!;
    const treeArtifact = { tree: "plugins/alpha" };
    Object.assign(current, { artifact: treeArtifact });
    index(files).packages[0] = entry;
    const oldAuthority = { capabilities: [], requires: old.authority.requires };
    files.set("plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: oldAuthority, artifact: treeArtifact }, {
      version: old.version, minAppVersion: old.minAppVersion, hostProtocol: old.hostProtocol,
    }));
    files.delete("plugins/alpha/source/package.json");
    files.set("plugins/alpha/unexpected.txt", "Outside the install layout.");
    files.set("plugins/alpha/plugin.json", { name: "alpha", version: old.version, extensions: {
      "ai.agent-connector.ave": { process: { command: "./dist/plugin" }, tools: [], ...oldAuthority },
    } });
    expect(check(files)).toEqual(expect.arrayContaining([
      { subject: "plugin/alpha", message: expect.stringContaining("the index's newest version differs from plugins/alpha/ave-package.json") },
      { subject: "plugin/alpha", message: "plugins/alpha/unexpected.txt: the tree rung installs plugin.json, dist/ and assets/ only" },
      { subject: "plugin/alpha", message: expect.stringContaining("a process entry is never installed from the tree rung, which this file declares") },
    ]));
  });

  it("keeps current authority failures fatal even when the package also lists foreign versions", () => {
    const files = validFiles();
    const entry = structuredClone(mixedHostProtocols.packages[0]!);
    entry.name = "alpha";
    entry.path = "plugins/alpha";
    Object.assign(entry.versions[0]!.authority, { pluginAccess: entry.versions[1]!.authority.pluginAccess });
    index(files).packages[0] = entry;
    expect(check(files)).toEqual(expect.arrayContaining([
      { subject: "plugin/alpha", message: expect.stringContaining("additional properties") },
    ]));
  });

  it("validates a current descriptor strictly even if its version matches a foreign exclusion", () => {
    const files = validFiles();
    const entry = structuredClone(mixedHostProtocols.packages[0]!);
    entry.name = "alpha";
    entry.path = "plugins/alpha";
    entry.versions.shift();
    entry.latest = "0.10.2";
    index(files).packages[0] = entry;
    const old = entry.versions[0]!;
    files.set("plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: old.authority, artifact: old.artifact }, {
      version: old.version, minAppVersion: old.minAppVersion, hostProtocol: "5",
    }));
    expect(check(files)).toEqual([{ subject: "plugin/alpha", message: expect.stringContaining("additional properties") }]);
  });

  it("validates a current released manifest even when a foreign version shares its version label", () => {
    const files = validFiles();
    const entry = structuredClone(mixedHostProtocols.packages[0]!);
    entry.name = "alpha";
    entry.path = "plugins/alpha";
    entry.versions[1]!.version = entry.versions[0]!.version;
    index(files).packages[0] = entry;
    const current = entry.versions[0]!;
    files.set("plugins/alpha/ave-package.json", descriptor("plugin", "alpha", { authority: current.authority, artifact: current.artifact }, {
      version: current.version, minAppVersion: current.minAppVersion, hostProtocol: current.hostProtocol,
    }));
    const problems = checkMarketplaceRepository(tree(files), { ...OFFICIAL, releasedManifests: new Map([[`alpha@${current.version}`, {}]]) });
    expect(problems).toEqual(expect.arrayContaining([{ subject: "plugin/alpha", message: expect.stringContaining("the released plugin.json of 0.10.3") }]));
  });

  it("checks the optional conditional policy and rejects an invalid successor mapping", () => {
    const files = validFiles();
    const entry = { kind: "plugin", name: "alpha", versions: "*", appVersions: "0.12.0", reason: "Replaced", at: AT,
      action: "uninstall", successors: { plugins: [], hostKinds: [] } };
    files.set("policy/revocations-by-app.json", { schemaVersion: 1, revocations: [entry] });
    expect(check(files)).toEqual([]);
    files.set("policy/revocations-by-app.json", { schemaVersion: 1, revocations: [{ ...entry, successors: { plugins: [{ pluginId: "alpha", anySource: false }], hostKinds: [] } }] });
    expect(check(files)).toEqual([expect.objectContaining({ subject: "policy/revocations-by-app.json" })]);
    for (const pluginId of ["constructor", "prototype", "__proto__"]) {
      files.set("policy/revocations-by-app.json", { schemaVersion: 1, revocations: [{ ...entry, successors: { plugins: [{ pluginId }], hostKinds: [] } }] });
      expect(check(files)).toEqual([expect.objectContaining({ subject: "policy/revocations-by-app.json" })]);
    }
  });

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

  it("refuses a plugin named host, the id the host's own alert sources use", () => {
    const files = validFiles();
    const plugin = index(files).packages[0]!;
    plugin.name = "host";
    plugin.path = "plugins/host";
    files.delete("plugins/alpha/ave-package.json");
    files.delete("plugins/alpha/source/package.json");
    files.set("plugins/host/ave-package.json", descriptor("plugin", "host", { authority: authority(), artifact: artifact() }));
    expect(check(files)).toEqual([
      { subject: "plugin/host", message: "the plugin name host is reserved for the host" },
      { subject: "plugins/host/ave-package.json", message: "no index entry points at this package" },
    ]);
  });

  it("allows host as the name of a package that is not a plugin", () => {
    const files = validFiles();
    const skill = index(files).packages[3]!;
    skill.name = "host";
    skill.path = "skills/host";
    files.delete("skills/review/ave-package.json");
    files.delete("skills/review/SKILL.md");
    files.set("skills/host/ave-package.json", descriptor("skill", "host", { entry: "SKILL.md" }));
    files.set("skills/host/SKILL.md", "---\nname: host\ndescription: Review a change.\n---\nRead the diff first.\n");
    expect(check(files)).toEqual([]);
  });

  it("reports a descriptor the index copy disagrees with", () => {
    const files = validFiles();
    files.set("skills/harbor/ave-package.json", descriptor("skill", "harbor", { entry: "SKILL.md" }, { minAppVersion: "0.13.0" }));
    expect(check(files)).toEqual([{ subject: "skill/harbor", message: expect.stringContaining("differs from skills/harbor/ave-package.json in minAppVersion") }]);
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

  it("accepts a custom source whose plugin is pinned over its own plain-http host (§18.2.3)", () => {
    const files = validFiles();
    const http = { release: { url: "http://git.corp.example/root/api/v4/projects/7/packages/generic/alpha/1.0.0/alpha-1.0.0.zip", sha256: SHA } };
    const alpha = files.get("plugins/alpha/ave-package.json") as { payload: { artifact: unknown } };
    alpha.payload.artifact = http;
    const entry = index(files).packages.find((candidate) => candidate.name === "alpha")!;
    (entry.versions as Array<Record<string, unknown>>)[0]!.artifact = http;
    const released = new Map([["alpha@1.0.0", { name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": authority() } }]]);
    expect(checkMarketplaceRepository(tree(files), { sourceId: "corp", official: false, alertsReleaseVersion: "0.13.0", releasedManifests: released })).toEqual([]);
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
    legacy.extensions["ai.agent-connector.ave"].capabilities = ["host:tasks"] as never[];
    expect(run()).toEqual([{ subject: "plugin/alpha", message: "the released plugin.json of 0.9.0: capabilities differs from the descriptor's authority" }]);
  });

  it("holds content packages to the install rules", () => {
    const svg = validFiles();
    svg.set("skills/harbor/preview.svg", "<svg/>");
    expect(check(svg)).toEqual([{ subject: "skill/harbor", message: expect.stringContaining("SVG is not allowed") }]);
    const bad = validFiles();
    bad.set("skills/harbor/SKILL.md", "---\nname: harbor\ndescription: \n---\n");
    expect(check(bad)).toEqual([{ subject: "skill/harbor", message: expect.stringContaining("SKILL.md") }]);
  });

  it("reports a listed content file it cannot read instead of checking it as empty", () => {
    const files = validFiles();
    files.set("skills/harbor/preview.png", "png");
    const listed = tree(files);
    const unreadable: RepositoryTree = { list: listed.list, read: (path) => (path === "skills/harbor/preview.png" ? null : listed.read(path)) };
    expect(checkMarketplaceRepository(unreadable, OFFICIAL)).toEqual([{ subject: "skill/harbor", message: "preview.png is listed but cannot be read" }]);
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

describe("retired notification declaration", () => {
  function pluginDocument(notificationEvents: unknown = []) {
    return { name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": { ...authority(), notificationEvents } } };
  }
  function treeFiles(document: unknown) {
    const files = validFiles();
    files.delete("plugins/alpha/source/package.json");
    files.set("plugins/alpha/plugin.json", document);
    return files;
  }

  it.each([undefined, "", "unknown", "0.12", "0.012.0", "0.12.0-beta.1", "0.12.0+build"])("refuses an unset or non-stable alerts release version: %s", (alertsReleaseVersion) => {
    const options = { ...OFFICIAL, alertsReleaseVersion } as Parameters<typeof checkMarketplaceRepository>[1];
    expect(checkMarketplaceRepository(tree(validFiles()), options)).toEqual([
      { subject: "alertsReleaseVersion", message: expect.stringContaining("Set alertsReleaseVersion") },
    ]);
  });

  it.each(["0.12.0", "0.11.9"])("refuses a tree declaration at or above release %s", (alertsReleaseVersion) => {
    expect(checkMarketplaceRepository(tree(treeFiles(pluginDocument())), { ...OFFICIAL, alertsReleaseVersion })).toEqual([
      { subject: "plugin/alpha", message: expect.stringContaining("notificationEvents is retired for minAppVersion 0.12.0") },
    ]);
  });

  it("keeps older legacy plugins valid during the transition", () => {
    expect(check(treeFiles(pluginDocument([{ event: "alpha.ready" }])))).toEqual([]);
  });

  it("uses the descriptor minimum even if the manifest tries to claim an older minimum", () => {
    const document = pluginDocument(null);
    document.extensions["ai.agent-connector.ave"].requires.minAppVersion = "0.1.0";
    const problems = checkMarketplaceRepository(tree(treeFiles(document)), { ...OFFICIAL, alertsReleaseVersion: "0.12.0" });
    expect(problems).toContainEqual({ subject: "plugin/alpha", message: expect.stringContaining("notificationEvents is retired") });
  });

  it("checks release-only manifests, including retained yanked versions", () => {
    const files = validFiles();
    const versions = index(files).packages[0]!.versions as Array<Record<string, unknown>>;
    versions.push(version({ version: "0.9.0", authority: authority(), artifact: artifact(), yanked: { reason: "Retained pin", at: AT } }));
    const old = { ...pluginDocument(), version: "0.9.0" };
    const problems = checkMarketplaceRepository(tree(files), { ...OFFICIAL, alertsReleaseVersion: "0.12.0", releasedManifests: new Map([["alpha@1.0.0", pluginDocument()], ["alpha@0.9.0", old]]) });
    expect(problems).toContainEqual({ subject: "plugin/alpha", message: expect.stringContaining("the released plugin.json of 1.0.0: notificationEvents is retired") });
    expect(problems).toContainEqual({ subject: "plugin/alpha", message: expect.stringContaining("the released plugin.json of 0.9.0: notificationEvents is retired") });
  });

  it("requires a manifest for an eligible release-only descriptor instead of silently skipping the check", () => {
    expect(checkMarketplaceRepository(tree(validFiles()), { ...OFFICIAL, alertsReleaseVersion: "0.12.0" })).toEqual([
      { subject: "plugin/alpha", message: expect.stringContaining("Supply releasedManifests for alpha@1.0.0") },
    ]);
  });

  it("accepts an eligible manifest without the retired field", () => {
    const document = { name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": authority() } };
    expect(checkMarketplaceRepository(tree(treeFiles(document)), { ...OFFICIAL, alertsReleaseVersion: "0.12.0" })).toEqual([]);
    expect(checkMarketplaceRepository(tree(validFiles()), { ...OFFICIAL, alertsReleaseVersion: "0.12.0", releasedManifests: new Map([["alpha@1.0.0", document]]) })).toEqual([]);
  });
});

describe("process-entry rules, per released version (§9.7 P4)", () => {
  const DESCRIPTOR = "plugins/alpha/ave-package.json";
  type Patch = { platforms?: string[]; artifact?: Record<string, unknown>; minAppVersion?: string };

  const processAuthority = (minAppVersion: string) => ({ capabilities: [], requires: { minAppVersion, hostProtocol: "5" } });
  const pinned = () => ({ release: { repo: "acme/market", tag: "alpha-v2.0.0", asset: "alpha-2.0.0.zip", sha256: SHA } });

  function alpha(newer: Patch = {}, older: Patch = {}) {
    const newMin = newer.minAppVersion ?? "0.14.0";
    const oldMin = older.minAppVersion ?? "0.12.0";
    const v2 = {
      version: "2.0.0", minAppVersion: newMin, hostProtocol: "5",
      platforms: newer.platforms ?? ["darwin", "linux"], artifact: newer.artifact ?? pinned(), authority: processAuthority(newMin),
    };
    const v1 = {
      version: "1.0.0", minAppVersion: oldMin,
      platforms: older.platforms ?? ["darwin", "win32", "linux"], artifact: older.artifact ?? { tree: "plugins/alpha" }, authority: { capabilities: [], requires: { minAppVersion: oldMin } },
    };
    const files = validFiles();
    index(files).packages[0] = { kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "2.0.0", versions: [version(v2), version(v1)] };
    files.set(DESCRIPTOR, descriptor("plugin", "alpha", { authority: v2.authority, artifact: v2.artifact }, {
      version: "2.0.0", minAppVersion: newMin, hostProtocol: "5", platforms: v2.platforms,
    }));
    const released = new Map<string, unknown>([
      ["alpha@2.0.0", { name: "alpha", version: "2.0.0", extensions: { "ai.agent-connector.ave": { process: { command: "./bin/plugin" }, tools: [], ...v2.authority } } }],
      ["alpha@1.0.0", { name: "alpha", version: "1.0.0", extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", ...v1.authority } } }],
    ]);
    return checkMarketplaceRepository(tree(files), { ...OFFICIAL, releasedManifests: released });
  }

  const problem = (message: string) => [{ subject: "plugin/alpha", message: `the released plugin.json of 2.0.0: ${message}` }];

  it("accepts a process 2.0.0 beside an entry 1.0.0 that runs on win32 from the tree", () => {
    expect(alpha()).toEqual([]);
  });

  it.each<[string, Patch, string]>([
    ["adds win32", { platforms: ["darwin", "win32", "linux"] }, `platforms in ${DESCRIPTOR} includes "win32", where a process entry cannot run`],
    ["drops its pin", { artifact: { release: { repo: "acme/market", tag: "alpha-v2.0.0", asset: "alpha-2.0.0.zip" } } },
      `artifact in ${DESCRIPTOR} pins no release or archive by sha256, which a process entry is installed from`],
    ["adds a tree", { artifact: { ...pinned(), tree: "plugins/alpha" } }, `artifact.tree is declared in ${DESCRIPTOR}; a process entry is never installed from the tree rung`],
  ])("reports 2.0.0 when it %s, naming the descriptor and the version", (_label, patch, message) => {
    const treeAlone = patch.artifact?.tree ? [{ subject: "plugin/alpha", message: "artifact.tree is declared but plugins/alpha/plugin.json is missing" }] : [];
    expect(alpha(patch)).toEqual([...problem(message), ...treeAlone]);
  });

  it("does not infer a numeric app floor from an unreleased protocol", () => {
    expect(alpha({ minAppVersion: "0.13.0" })).toEqual([]);
  });

  it("still reports a version below the process-entry floor", () => {
    expect(alpha({ minAppVersion: "0.12.0" })).toEqual(problem(
      `minAppVersion in ${DESCRIPTOR} is "0.12.0"; a process entry needs 0.13.0 or newer, the first release that runs one`,
    ));
  });

  it.each<[string, Patch]>([
    ["adds win32", { platforms: ["win32"] }],
    ["has an unpinned release", { artifact: { release: { repo: "acme/market", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip" } } }],
    ["adds a tree beside a release", { artifact: { release: { repo: "acme/market", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip" }, tree: "plugins/alpha" } }],
    ["keeps a minAppVersion below 0.13.0", { minAppVersion: "0.11.0" }],
  ])("leaves the entry 1.0.0 clean when it %s", (_label, patch) => {
    expect(alpha({}, patch)).toEqual([]);
  });

  it("reports a process plugin.json in the package directory, which declares the tree rung", () => {
    const files = validFiles();
    const authority = processAuthority("0.14.0");
    const artifact = pinned();
    index(files).packages[0] = {
      kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "2.0.0",
      versions: [version({ version: "2.0.0", minAppVersion: "0.14.0", hostProtocol: "5", platforms: ["darwin", "linux"], authority, artifact })],
    };
    files.delete("plugins/alpha/source/package.json");
    files.set(DESCRIPTOR, descriptor("plugin", "alpha", { authority, artifact }, { version: "2.0.0", minAppVersion: "0.14.0", hostProtocol: "5", platforms: ["darwin", "linux"] }));
    files.set("plugins/alpha/plugin.json", { name: "alpha", version: "2.0.0", extensions: { "ai.agent-connector.ave": { process: { command: "./dist/plugin" }, tools: [], ...authority } } });
    expect(check(files)).toEqual([{
      subject: "plugin/alpha",
      message: "plugins/alpha/plugin.json: a process entry is never installed from the tree rung, which this file declares; publish it as a pinned release or archive only",
    }]);
  });
});
