import AdmZip from "adm-zip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import {
  createFixtureRepo,
  type FixtureRepo,
  type GitHttpServer,
  removeFixtureRepo,
  startGitHttpServer,
} from "../../__tests__/fixtures/git-http-server.js";
import { createTestGitRunner, type TestGitRunner } from "../../__tests__/fixtures/git-runner.js";
import { policyLoad } from "../../__tests__/fixtures/policy.js";
import { aggregateCatalog } from "../../catalog/aggregate.js";
import { NetworkGate } from "../../net/network-gate.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { assertMcpRuntimePinned, mcpServerConfigFor, planMcpInstall, resolveMcpPackage, runtimeFromServerJson } from "../mcp.js";

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
              runtimeArguments: [{ type: "named", name: "--node-options", value: "--max-old-space-size=512" }],
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
      args: ["--node-options", "--max-old-space-size=512", "-y", "@acme/mcp-notes@1.4.2", "serve", "--port", "8080"],
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
        { packages: [{ registryType: "oci", identifier: "ghcr.io/acme/notes", version: "2.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "named", name: "--network", value: "none" }] }] },
        undefined,
      ),
    ).toEqual({ transport: "stdio", command: "docker", args: ["run", "-i", "--rm", "--network", "none", "ghcr.io/acme/notes:2.0.0"] });
    expect(runtimeFromServerJson({ packages: [{ registryType: "oci", identifier: `ghcr.io/acme/notes@sha256:${"a".repeat(64)}`, transport: { type: "stdio" } }] }, undefined)).toMatchObject({
      args: ["run", "-i", "--rm", `ghcr.io/acme/notes@sha256:${"a".repeat(64)}`],
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
  ])("%j pinned: %s", (spec, pinned) => {
    const check = () => assertMcpRuntimePinned("notes", { transport: "stdio", ...spec });
    if (pinned) expect(check).not.toThrow();
    else expect(check).toThrow(/must run/u);
  });
});

describe.skipIf(process.platform === "win32")("resolveMcpPackage", () => {
  let serverRoot: string;
  let server: GitHttpServer;
  let git: TestGitRunner;
  let root: string;
  let repos: FixtureRepo[] = [];
  let counter = 0;

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "ave-mcp-served-"));
    server = await startGitHttpServer({ root: serverRoot });
    git = await createTestGitRunner();
  });

  afterAll(async () => {
    await server.close();
    await git.cleanup();
    rmSync(serverRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-mcp-root-"));
  });

  afterEach(() => {
    for (const repo of repos) removeFixtureRepo(repo);
    repos = [];
    rmSync(root, { recursive: true, force: true });
  });

  async function resolveFrom(files: Record<string, string>, executable: string[] = []) {
    counter += 1;
    const name = `mcp-${counter}`;
    const repo = createFixtureRepo(serverRoot, name);
    repos.push(repo);
    repo.commit(
      {
        "marketplace.json": `${JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Acme", packages: [{ kind: "mcp", name: "notes", path: "mcp/notes" }] })}\n`,
        ...files,
      },
      "publish",
    );
    if (executable.length > 0) {
      repo.commitEntries(
        Object.entries(files).map(([path, content]) => ({ path, mode: executable.includes(path) ? "100755" : "100644", content })).concat([
          { path: "marketplace.json", mode: "100644", content: `${JSON.stringify({ schemaVersion: 1, name: "acme", displayName: "Acme", packages: [{ kind: "mcp", name: "notes", path: "mcp/notes" }] })}\n` },
        ]),
        "modes",
      );
    }
    const policy = policyLoad({});
    const gate = new NetworkGate({ policy, allowLoopback: true });
    const marketplaces = mkdtempSync(join(root, "m-"));
    const registry = await SourceRegistry.open({ root: marketplaces, policy });
    await registry.add({ id: "acme", origin: "custom", url: server.url(name), auth: { kind: "none" } });
    const syncer = new SourceSyncer({ registry, gate, runner: git.runner, root: marketplaces, now: () => new Date(AT), retainedCommits: async () => new Set() });
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
      resolveMcpPackage(plan, { repo: bare, remote, direct: false, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, workRoot }),
    );
  }

  const descriptor = (payload: Record<string, unknown>) =>
    `${JSON.stringify({ schemaVersion: 1, kind: "mcp", name: "notes", version: "1.0.0", minAppVersion: "0.12.0", payload })}\n`;

  it("uses the descriptor's own pinned spec and fills tokens into the MCP config", async () => {
    const resolved = await resolveFrom({
      "mcp/notes/ave-package.json": descriptor({ server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.2.3"], env: { NOTES_MODE: "ro" }, auth: "api-key", apiKeyEnv: "NOTES_TOKEN" } }),
    });
    expect(resolved).toMatchObject({ from: "descriptor", packageFiles: null, runtime: { command: "npx", args: ["-y", "@acme/notes@1.2.3"] } });
    expect(mcpServerConfigFor(resolved, "/ave/mcp/notes", "/app/node")).toEqual({
      id: "notes",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes@1.2.3"],
      env: { NOTES_MODE: "ro" },
      auth: "api-key",
      apiKeyEnv: "NOTES_TOKEN",
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
    expect(resolved.packageFiles!.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(mcpServerConfigFor(resolved, "/ave/mcp/notes", "/app/node")).toMatchObject({
      command: "/ave/mcp/notes/server/run.sh",
      args: ["/ave/mcp/notes/server/config.json"],
    });
  });

  it.each([
    ["a package-local command that is not in the package", { server: { transport: "stdio", command: "server/missing.sh" } }, { "mcp/notes/server/run.sh": "#!/bin/sh\n" }, "is not a file in the package"],
    ["an unpinned npx package", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes"] } }, {}, "exact version"],
    ["$PLUGIN_DIR without package files", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.0.0", "$PLUGIN_DIR/x"] } }, {}, "ships no package files"],
    ["$PYTHON", { server: { transport: "stdio", command: "npx", args: ["-y", "@acme/notes@1.0.0"], env: { PY: "$PYTHON" } } }, {}, "$PYTHON"],
  ])("refuses %s", async (_label, payload, extra, message) => {
    await expect(resolveFrom({ "mcp/notes/ave-package.json": descriptor(payload), ...extra })).rejects.toThrow(message);
  });
});
