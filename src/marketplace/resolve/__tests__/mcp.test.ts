import AdmZip from "adm-zip";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import {
  copyFixtureRepo,
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { policySource } from "../../__tests__/fixtures/policy.js";
import { aggregateCatalog } from "../../catalog/aggregate.js";
import { NetworkGate } from "../../net/network-gate.js";
import { createPinnedFetch } from "../../net/pinned-fetch.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { assertMcpRuntimePinned, mcpServerConfigFor, planMcpInstall, resolveMcpPackage, runtimeFromServerJson } from "../mcp.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { nodeFolders } from "../../__tests__/fixtures/folder-fs.js";
import { gitAccess } from "../../sources/source-tree.js";
import { UNREACHABLE_OFFICIAL } from "../../__tests__/fixtures/official.js";

const AT = "2026-09-23T00:00:00.000Z";

const npmPackage = (patch: Record<string, unknown> = {}) => ({
  registryType: "npm",
  identifier: "@acme/mcp-notes",
  version: "1.4.2",
  transport: { type: "stdio" },
  ...patch,
});

describe("server.json mapping (design §5.2)", () => {
  it("maps an npm package to a pinned npx command with arguments and one secret", () => {
    expect(
      runtimeFromServerJson(
        {
          packages: [
            npmPackage({
              packageArguments: [
                { type: "positional", value: "serve" },
                { type: "named", name: "--port", default: "8080" },
                { type: "named", name: "--verbose" },
              ],
              environmentVariables: [
                { name: "NOTES_MODE", value: "ro" },
                { name: "NOTES_TOKEN", isSecret: true, isRequired: true },
                { name: "NOTES_OPTIONAL" },
              ],
            }),
          ],
        },
        undefined,
      ),
    ).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/mcp-notes@1.4.2", "serve", "--port", "8080"],
      env: { NOTES_MODE: "ro" },
      auth: "api-key",
      apiKeyEnv: "NOTES_TOKEN",
    });
  });

  it("maps pypi to a pinned uvx command and oci to docker run", () => {
    expect(runtimeFromServerJson({ packages: [{ registryType: "pypi", identifier: "mcp-notes", version: "0.3.1", transport: { type: "stdio" } }] }, undefined)).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-notes==0.3.1"],
    });
    expect(
      runtimeFromServerJson(
        { packages: [{ registryType: "oci", identifier: "docker.io/acme/notes", version: "2.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "named", name: "--network", value: "none" }] }] },
        undefined,
      ),
    ).toEqual({ transport: "stdio", command: "docker", args: ["run", "-i", "--rm", "--network", "none", "docker.io/acme/notes:2.0.0"] });
    expect(runtimeFromServerJson({ packages: [{ registryType: "oci", identifier: `acme/notes@sha256:${"a".repeat(64)}`, transport: { type: "stdio" } }] }, undefined)).toMatchObject({
      args: ["run", "-i", "--rm", `acme/notes@sha256:${"a".repeat(64)}`],
    });
  });

  it("maps a streamable-http remote with a secret header, and honours select", () => {
    const document = {
      packages: [npmPackage()],
      remotes: [
        { type: "sse", url: "https://mcp.acme.example/sse" },
        { type: "streamable-http", url: "https://mcp.acme.example/mcp", headers: [{ name: "X-Api-Key", isSecret: true }] },
      ],
    };
    expect(runtimeFromServerJson(document, { remote: 1 })).toEqual({ transport: "http", url: "https://mcp.acme.example/mcp", auth: "api-key", apiKeyHeader: "X-Api-Key" });
    expect(runtimeFromServerJson(document, { package: 0 })).toMatchObject({ command: "npx" });
    expect(runtimeFromServerJson(document, undefined)).toMatchObject({ command: "npx" });
    expect(runtimeFromServerJson({ remotes: document.remotes.slice(1) }, undefined)).toMatchObject({ transport: "http" });
  });

  it.each([
    ["an sse remote", { remotes: [{ type: "sse", url: "https://x.example/sse" }] }, undefined, "streamable-http only"],
    ["a plain http remote", { remotes: [{ type: "streamable-http", url: "http://x.example/mcp" }] }, undefined, "must be https"],
    ["a fixed header", { remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "X-Tenant", value: "a" }] }] }, undefined, "fixed values"],
    ["a nuget package", { packages: [npmPackage({ registryType: "nuget" })] }, undefined, "not supported"],
    ["a prototype key as registry", { packages: [npmPackage({ registryType: "toString" })] }, undefined, "not supported"],
    ["another npm registry", { packages: [npmPackage({ registryBaseUrl: "https://npm.evil.example" })] }, undefined, "not the default npm registry"],
    ["a package over http", { packages: [npmPackage({ transport: { type: "streamable-http", url: "http://localhost:1" } })] }, undefined, "stdio transport"],
    ["an npm range", { packages: [npmPackage({ version: "^1.4.0" })] }, undefined, "exact version"],
    ["an untagged image", { packages: [{ registryType: "oci", identifier: "acme/notes", transport: { type: "stdio" } }] }, undefined, "fixed tag"],
    ["the latest tag", { packages: [{ registryType: "oci", identifier: "acme/notes:latest", transport: { type: "stdio" } }] }, undefined, "fixed tag"],
    ["a template", { packages: [npmPackage({ packageArguments: [{ type: "positional", value: "--dir={home}" }] })] }, undefined, "template"],
    ["variables", { packages: [npmPackage({ packageArguments: [{ type: "positional", value: "x", variables: { home: {} } }] })] }, undefined, "variables"],
    ["a required argument without value", { packages: [npmPackage({ packageArguments: [{ type: "named", name: "--db", isRequired: true }] })] }, undefined, "required"],
    ["a required variable without value", { packages: [npmPackage({ environmentVariables: [{ name: "DB_URL", isRequired: true }] })] }, undefined, "required"],
    ["two secrets", { packages: [npmPackage({ environmentVariables: [{ name: "A_KEY", isSecret: true }, { name: "B_KEY", isSecret: true }] })] }, undefined, "more than one secret"],
    ["a reserved variable", { packages: [npmPackage({ environmentVariables: [{ name: "PATH", value: "/tmp" }] })] }, undefined, "not allowed"],
    // Security review P2: every way the spec could run code the commit does not fix.
    ["npx runtime arguments", { packages: [npmPackage({ runtimeArguments: [{ type: "named", name: "--registry", value: "https://evil.example" }] })] }, undefined, "runtimeArguments"],
    ["uvx runtime arguments", { packages: [{ registryType: "pypi", identifier: "good", version: "1.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "positional", value: "evilpkg" }] }] }, undefined, "runtimeArguments"],
    ["an npm registry variable", { packages: [npmPackage({ environmentVariables: [{ name: "npm_config_registry", value: "https://evil.example" }] })] }, undefined, "not allowed"],
    ["a uv index variable", { packages: [{ registryType: "pypi", identifier: "good", version: "1.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "UV_INDEX_URL", value: "https://evil.example" }] }] }, undefined, "not allowed"],
    ["a docker daemon variable", { packages: [{ registryType: "oci", identifier: "acme/notes:1.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "DOCKER_HOST", value: "tcp://evil:2375" }] }] }, undefined, "not allowed"],
    ["a proxy variable", { packages: [npmPackage({ environmentVariables: [{ name: "HTTPS_PROXY", value: "http://evil:8080" }] })] }, undefined, "not allowed"],
    ["an npm tarball URL", { packages: [npmPackage({ identifier: "https://evil.example/x.tgz#" })] }, undefined, "exact version"],
    ["a mounted host", { packages: [{ registryType: "oci", identifier: "acme/notes:1.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "named", name: "-v", value: "/:/host" }] }] }, undefined, "option -v is not allowed"],
    ["an image before the pinned one", { packages: [{ registryType: "oci", identifier: "acme/notes:1.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "positional", value: "evil/img:main" }] }] }, undefined, "must be docker options, not an image"],
    ["an image hidden as an option value", { packages: [{ registryType: "oci", identifier: "acme/notes:1.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "named", name: "--rm", value: "evil/img:main" }] }] }, undefined, "must be docker options, not an image"],
    ["another oci registry host", { packages: [{ registryType: "oci", identifier: "evil.example/img:main", transport: { type: "stdio" } }] }, undefined, "not on the default oci registry"],
    ["both selectors", { packages: [npmPackage()], remotes: [] }, { package: 0, remote: 0 }, "both"],
    ["a missing selection", { packages: [npmPackage()] }, { package: 3 }, "no package 3"],
    ["nothing to run", {}, undefined, "no package and no remote"],
  ])("refuses %s", (_label, document, select, message) => {
    expect(() => runtimeFromServerJson(document, select as { package?: number; remote?: number } | undefined)).toThrow(message);
  });
});

describe("assertMcpRuntimePinned", () => {
  it.each([
    [{ command: "npx", args: ["-y", "@acme/notes@1.2.3"] }, true],
    [{ command: "npx", args: ["-y", "@acme/notes"] }, false],
    [{ command: "npx", args: ["-y", "@acme/notes@latest"] }, false],
    [{ command: "uvx", args: ["notes==1.0.0"] }, true],
    [{ command: "uvx", args: ["--from", "notes==1.0.0", "notes-server"] }, true],
    [{ command: "uvx", args: ["notes"] }, false],
    [{ command: "docker", args: ["run", "-i", "--rm", "--network=none", "ghcr.io/acme/notes:2.0.0"] }, true],
    [{ command: "docker", args: ["run", "-i", "ghcr.io/acme/notes"] }, false],
    [{ command: "docker", args: ["run", "-i", "ghcr.io/acme/notes:latest"] }, false],
    [{ command: "server/run.sh", args: [] }, true],
    [{ command: "npx", args: ["--registry=https://evil.example", "-y", "good@1.0.0"] }, false],
    [{ command: "npx", args: ["--package=evil", "-y", "good@1.0.0"] }, false],
    [{ command: "npx", args: ["-y", "good@1.0.0", "--registry", "x"] }, true],
    [{ command: "uvx", args: ["--index-url=https://evil/simple", "good==1.0.0"] }, false],
    [{ command: "uvx", args: ["--with=evil", "good==1.0.0"] }, false],
    [{ command: "uvx", args: ["pkg==1.*"] }, false],
    [{ command: "uvx", args: ["--from=notes==1.0.0", "notes-server"] }, true],
    [{ command: "uvx", args: ["--from", "notes==1.0.0"] }, false],
    [{ command: "docker", args: ["run", "-i", "--rm", "-v", "/:/host", "evil/img:main", "good/img:1.0.0"] }, false],
    [{ command: "docker", args: ["run", "-i", "--privileged", "good/img:1.0.0"] }, false],
    [{ command: "docker", args: ["run", "-i", "--network", "host", "good/img:1.0.0"] }, false],
    [{ command: "docker", args: ["run", "-i", "-e", "API_KEY", "--env=MODE=ro", "good/img:1.0.0"] }, true],
    [{ command: "docker", args: ["-H", "tcp://evil", "run", "good/img:1.0.0"] }, false],
  ])("%j pinned: %s", (spec, pinned) => {
    const check = () => assertMcpRuntimePinned("notes", { transport: "stdio", ...spec });
    if (pinned) expect(check).not.toThrow();
    else expect(check).toThrow(/must run/u);
  });

  it("refuses environment that steers a launcher or the loader, and allows python's output switches", () => {
    const run = (env: Record<string, string>, apiKeyEnv?: string) => () =>
      assertMcpRuntimePinned("notes", { transport: "stdio", command: "npx", args: ["-y", "good@1.0.0"], env, ...(apiKeyEnv ? { apiKeyEnv } : {}) });
    expect(run({ npm_config_registry: "https://evil.example" })).toThrow("environment variable npm_config_registry is not allowed");
    expect(run({ PIP_INDEX_URL: "x" })).toThrow(/not allowed/u);
    expect(run({ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" })).toThrow(/not allowed/u);
    expect(run({}, "UV_INDEX_URL")).toThrow(/UV_INDEX_URL is not allowed/u);
    expect(run({ NODE_OPTIONS: "--require /tmp/x.js" })).toThrow(/not allowed/u);
    expect(run({ DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" })).toThrow(/not allowed/u);
    expect(run({ LD_PRELOAD: "/tmp/x.so" })).toThrow(/not allowed/u);
    expect(run({ XDG_CONFIG_HOME: "/tmp/cfg" })).toThrow(/not allowed/u);
    expect(run({ PYTHONUNBUFFERED: "1", NOTES_MODE: "ro" })).not.toThrow();
  });
});

describe("resolveMcpPackage", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let emptyRepo: FixtureRepo;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-mcp-served-"));
    emptyRepo = createFixtureRepo(serverRoot, "empty-seed");
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    await removeFixtureRepo(emptyRepo);
    await cleanupTmpDir(serverRoot);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-mcp-root-"));
  });

  afterEach(async () => {
    for (const repo of repos) await removeFixtureRepo(repo);
    repos = [];
    await cleanupTmpDir(root);
  });

  async function resolveFrom(files: Record<string, string>, executable: string[] = []) {
    counter += 1;
    const name = `mcp-${counter}`;
    const repo = copyFixtureRepo(serverRoot, name, emptyRepo);
    repos.push(repo);
    repo.commit(
      {
        "marketplace.json": `${JSON.stringify({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: [{ kind: "mcp", name: "notes", path: "mcp/notes" }] })}\n`,
        ...files,
      },
      "publish",
    );
    if (executable.length > 0) {
      repo.commitEntries(
        Object.entries(files).map(([path, content]) => ({ path, mode: executable.includes(path) ? "100755" : "100644", content })).concat([
          { path: "marketplace.json", mode: "100644", content: `${JSON.stringify({ schemaVersion: 2, name: "acme", displayName: "Acme", packages: [{ kind: "mcp", name: "notes", path: "mcp/notes" }] })}\n` },
        ]),
        "modes",
      );
    }
    const policy = policySource({});
    const gate = new NetworkGate({ policy, allowLoopback: true, transport: createPinnedFetch() });
    const marketplaces = mkdtempSync(join(root, "m-"));
    const registry = await SourceRegistry.open({ root: marketplaces, policy, official: UNREACHABLE_OFFICIAL });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => new Date(AT), retainedCommits: async () => new Set(), folders: nodeFolders() });
    expect(await syncer.sync("acme")).toMatchObject({ status: "ok" });
    const snapshot = (await syncer.readSnapshot("acme"))!;
    expect(snapshot.diagnostics).toEqual([]);
    const [row] = aggregateCatalog([{ sourceId: "acme", sourceOrigin: "custom", snapshot }], {
      appVersion: "0.14.0",
      platform: process.platform,
      canaryOptIn: false,
      installationId: "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b",
    });
    const plan = planMcpInstall(row!);
    const workRoot = mkdtempSync(join(root, "work-"));
    return syncer.withRepository("acme", ({ repo: bare, remote }) =>
      resolveMcpPackage(plan, { ...gitAccess(bare, remote, false), limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, workRoot }),
    );
  }

  const descriptor = (payload: Record<string, unknown>) =>
    `${JSON.stringify({ schemaVersion: 2, kind: "mcp", name: "notes", version: "1.0.0", minAppVersion: "0.12.0", payload })}\n`;

  it("uses the descriptor's own pinned spec and fills tokens into the MCP config", async () => {
    const resolved = await resolveFrom({
      "mcp/notes/ave-package.json": descriptor({ server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.2.3"], env: { NOTES_MODE: "ro" }, auth: "api-key", apiKeyEnv: "NOTES_TOKEN" } }),
    });
    expect(resolved).toMatchObject({ from: "descriptor", packageFiles: null, runtime: { command: "npx", args: ["-y", "@acme/notes@1.2.3"] } });
    expect(mcpServerConfigFor(resolved, { installDir: "/ave/mcp/notes", dataDir: "/ave/mcp-data/notes", nodePath: "/app/node" })).toEqual({
      id: "notes",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes@1.2.3"],
      env: { NOTES_MODE: "ro" },
      auth: "api-key",
      apiKeyEnv: "NOTES_TOKEN",
    });
  });

  it("gives a server its own data directory in its arguments and environment", async () => {
    const resolved = await resolveFrom({
      "mcp/notes/ave-package.json": descriptor({ server: { transport: "stdio", command: "uvx", args: ["notes-mcp==1.0.0", "--db", "$DATA_DIR/notes.sqlite"], env: { NOTES_HOME: "$DATA_DIR" } } }),
    });
    expect(resolved).toMatchObject({ packageFiles: null, runtime: { args: ["notes-mcp==1.0.0", "--db", "$DATA_DIR/notes.sqlite"] } });
    expect(mcpServerConfigFor(resolved, { installDir: "/ave/mcp/notes", dataDir: "/ave/mcp-data/notes", nodePath: "/app/node" })).toMatchObject({
      args: ["notes-mcp==1.0.0", "--db", "/ave/mcp-data/notes/notes.sqlite"],
      env: { NOTES_HOME: "/ave/mcp-data/notes" },
    });
  });

  it("fills tokens in one pass, so a filled-in path is never read as a token or a replacement pattern", async () => {
    const resolved = await resolveFrom({
      "mcp/notes/ave-package.json": descriptor({ server: { transport: "stdio", command: "uvx", args: ["notes-mcp==1.0.0", "--db", "$DATA_DIR/notes.sqlite"], env: { NOTES_HOME: "$DATA_DIR", NOTES_FLAGS: "$NODE_OPTIONS" } } }),
    });
    expect(mcpServerConfigFor(resolved, { installDir: "/ave/mcp/notes", dataDir: "/home/$&$$/$PLUGIN_DIR", nodePath: "/app/node" })).toMatchObject({
      args: ["notes-mcp==1.0.0", "--db", "/home/$&$$/$PLUGIN_DIR/notes.sqlite"],
      env: { NOTES_HOME: "/home/$&$$/$PLUGIN_DIR", NOTES_FLAGS: "$NODE_OPTIONS" },
    });
  });

  it("reads server.json at the version's commit", async () => {
    const resolved = await resolveFrom({
      "mcp/notes/ave-package.json": descriptor({ serverJson: "server.json", select: { remote: 0 } }),
      "mcp/notes/server.json": JSON.stringify({ name: "io.acme/notes", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp" }] }),
    });
    expect(resolved).toMatchObject({ from: "server.json", runtime: { transport: "http", url: "https://mcp.acme.example/mcp" } });
  });

  it("runs a package-local command from the exported server/ files", async () => {
    const resolved = await resolveFrom(
      {
        "mcp/notes/ave-package.json": descriptor({ server: { transport: "stdio", command: "server/run.sh", args: ["$PLUGIN_DIR/server/config.json"] } }),
        "mcp/notes/server/run.sh": "#!/bin/sh\nexec node \"$(dirname \"$0\")/index.js\"\n",
        "mcp/notes/server/index.js": "console.log('notes');\n",
        "mcp/notes/server/config.json": "{}\n",
      },
      ["mcp/notes/server/run.sh"],
    );
    expect(resolved.runtime).toEqual({ transport: "stdio", command: "$PLUGIN_DIR/server/run.sh", args: ["$PLUGIN_DIR/server/config.json"] });
    const zip = new AdmZip(resolved.packageFiles!.zipBuffer);
    expect(zip.getEntries().map((entry) => entry.entryName).sort()).toEqual(["server/config.json", "server/index.js", "server/run.sh"]);
    // The zip carries each file's mode: the installer restores the execute bit from it.
    const modes = Object.fromEntries(zip.getEntries().map((entry) => [entry.entryName, (entry.attr >>> 16) & 0o777]));
    expect(modes).toEqual({ "server/config.json": 0o644, "server/index.js": 0o644, "server/run.sh": 0o755 });
    expect(resolved.packageFiles!.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(mcpServerConfigFor(resolved, { installDir: "/ave/mcp/notes", dataDir: "/ave/mcp-data/notes", nodePath: "/app/node" })).toMatchObject({
      command: "/ave/mcp/notes/server/run.sh",
      args: ["/ave/mcp/notes/server/config.json"],
    });
  });

  it.each([
    ["a package-local command that is not in the package", { server: { transport: "stdio", command: "server/missing.sh" } }, { "mcp/notes/server/run.sh": "#!/bin/sh\n" }, "is not a file in the package"],
    ["an unpinned npx package", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes"] } }, {}, "exact version"],
    ["$PLUGIN_DIR without package files", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.0.0", "$PLUGIN_DIR/x"] } }, {}, "ships no package files"],
    ["$PYTHON", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.0.0"], env: { PY: "$PYTHON" } } }, {}, "$PYTHON"],
    ["$DATA_DIR in a remote server's URL", { server: { transport: "http", url: "https://mcp.acme.example/$DATA_DIR" } }, {}, "only in a stdio server's arguments and environment"],
  ])("refuses %s", async (_label, payload, extra, message) => {
    await expect(resolveFrom({ "mcp/notes/ave-package.json": descriptor(payload), ...extra })).rejects.toThrow(message);
  });
});
