import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFixtureAncestorPermissions } from "../../__tests__/support/native-executable.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { copySubscriptionPackageArtifact, type SubscriptionPackageArtifact } from "../subscription-package-artifact.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("../../__tests__/support/native-executable.js")).maskFixtureAncestorAcl(await importOriginal()));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writePackage(root: string, name: string, files: Record<string, string>, metadata: Record<string, unknown> = {}): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, main: "index.cjs", ...metadata }), { mode: 0o600 });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }
  return root;
}

function createFixture(source = "console.log('snapshot');\n", metadata: Record<string, unknown> = {}, filename = "cli.cjs") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-package-artifact-")));
  roots.push(root);
  normalizeFixtureAncestorPermissions(root);
  const modules = join(root, "installed", "node_modules");
  const packageRoot = writePackage(join(modules, "fixture-entry"), "fixture-entry", { [filename]: source }, metadata);
  const script = join(packageRoot, filename);
  const artifactDirectory = join(root, "private");
  mkdirSync(artifactDirectory, { mode: 0o700 });
  return { root, modules, packageRoot, script, artifactDirectory };
}

function runArtifact(artifact: SubscriptionPackageArtifact, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const node = process.env.AVE_TEST_NODE_EXEC_PATH;
  if (!node) throw new Error("Standalone test runtime is unavailable");
  return spawnSync(node, [...artifact.args], {
    cwd, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", ...env },
  });
}

function replaceSealedFile(path: string, content: string): void {
  chmodSync(path, 0o700);
  writeFileSync(path, content);
  chmodSync(path, 0o500);
}

describe("sealed subscription package artifacts", () => {
  it("executes the private entry snapshot after the installed script is replaced following host verification", async () => {
    const fixture = fixtureForSnapshot();
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    expect(artifact.args.slice(0, 2)).toEqual(["--no-global-search-paths", "--import"]);
    expect(artifact.args[3]).not.toBe(fixture.script);
    expect(readFileSync(artifact.args[3]!)).toEqual(readFileSync(fixture.script));
    await artifact.verify();
    writeFileSync(fixture.script, "console.log('source-replaced');\n");
    const result = runArtifact(artifact, fixture.root);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("snapshot\n");
    await expect(artifact.verify()).rejects.toThrow("Subscription executable changed");
  });

  it("rejects private entry bytes changed after host verification at module load", async () => {
    const fixture = fixtureForSnapshot();
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    await artifact.verify();
    replaceSealedFile(artifact.args[3]!, "console.log('private-replaced');\n");
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("subscription-module-changed");
    expect(result.stdout).toBe("");
  });

  it("rejects private dependency bytes changed after host verification at module load", async () => {
    const fixture = fixtureWithDependency();
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    await artifact.verify();
    const dependency = join(dirname(dirname(artifact.args[3]!)), "fixture-dep", "index.cjs");
    replaceSealedFile(dependency, "module.exports = 'private-replaced';\n");
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("subscription-module-changed");
    expect(result.stdout).toBe("");
  });

  it("rejects dependency resolution metadata changed after host verification even when the redirect target was copied", async () => {
    const fixture = fixtureWithDependency();
    writeFileSync(join(fixture.modules, "fixture-dep", "redirected.cjs"), "module.exports = 'redirected-marker';\n", { mode: 0o600 });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    const privateDependency = join(dirname(dirname(artifact.args[3]!)), "fixture-dep");
    expect(readFileSync(join(privateDependency, "redirected.cjs"), "utf8")).toContain("redirected-marker");
    await artifact.verify();
    replaceSealedFile(join(privateDependency, "package.json"), JSON.stringify({
      name: "fixture-dep", main: "redirected.cjs", exports: "./redirected.cjs",
    }));
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("subscription-module-changed");
    expect(result.stdout).toBe("");
  });

  it("retains hoisted and nested dependency layouts while closing cyclic declarations", async () => {
    const fixture = createFixture("console.log(require('fixture-dep'));\n", { dependencies: { "fixture-dep": "1" } });
    const dependency = writePackage(join(fixture.modules, "fixture-dep"), "fixture-dep", {
      "index.cjs": "module.exports = 'hoisted:' + require('fixture-nested');\n",
    }, { dependencies: { "fixture-nested": "1", "fixture-entry": "1" } });
    writePackage(join(dependency, "node_modules", "fixture-nested"), "fixture-nested", {
      "index.cjs": "module.exports = 'nested';\n",
    });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    await artifact.verify();
    const result = runArtifact(artifact, fixture.root);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hoisted:nested\n");
  });

  it("changes its identity and rejects the old proof when a declared external dependency changes", async () => {
    const fixture = fixtureWithDependency();
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    writeFileSync(join(fixture.modules, "fixture-dep", "index.cjs"), "module.exports = 'updated';\n");
    await expect(artifact.verify()).rejects.toThrow("Subscription executable changed");
    const nextDirectory = join(fixture.root, "next-private");
    mkdirSync(nextDirectory, { mode: 0o700 });
    const next = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, nextDirectory);
    expect(next.identity).not.toBe(artifact.identity);
    expect(runArtifact(next, fixture.root).stdout).toBe("updated\n");
  });

  it.each(["require", "esm"] as const)("rejects an absolute %s import outside the snapshot", async (kind) => {
    const fixture = fixtureForSnapshot();
    const outside = join(fixture.root, kind === "esm" ? "outside.mjs" : "outside.cjs");
    writeFileSync(outside, "console.log('outside-executed');\n", { mode: 0o600 });
    const source = kind === "esm" ? `import ${JSON.stringify(outside)};\n` : `require(${JSON.stringify(outside)});\n`;
    const script = join(fixture.packageRoot, kind === "esm" ? "entry.mjs" : "entry.cjs");
    writeFileSync(script, source, { mode: 0o600 });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, script, fixture.artifactDirectory);
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("subscription-module-outside-artifact");
    expect(result.stdout).toBe("");
  });

  it.each(["NODE_PATH", "ancestor"] as const)("refuses undeclared code available through %s", async (source) => {
    const fixture = createFixture("console.log(require('fixture-undeclared'));\n");
    const modules = source === "NODE_PATH" ? join(fixture.root, "search-modules") : join(fixture.root, "node_modules");
    writePackage(join(modules, "fixture-undeclared"), "fixture-undeclared", { "index.cjs": "module.exports = 'outside-executed';\n" });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    const result = runArtifact(artifact, fixture.root, source === "NODE_PATH" ? { NODE_PATH: modules } : {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/subscription-module-outside-artifact|MODULE_NOT_FOUND/);
    expect(result.stdout).toBe("");
  });

  it("excludes undeclared nested dependencies from the snapshot and refuses to require them", async () => {
    const fixture = createFixture("console.log(require('fixture-undeclared'));\n");
    writePackage(join(fixture.packageRoot, "node_modules", "fixture-undeclared"), "fixture-undeclared", {
      "index.cjs": "module.exports = 'undeclared-marker';\n",
    });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    const privateDependency = join(dirname(artifact.args[3]!), "node_modules", "fixture-undeclared");
    expect(existsSync(privateDependency)).toBe(false);
    await artifact.verify();
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/subscription-module-outside-artifact|MODULE_NOT_FOUND/);
    expect(result.stdout).toBe("");
  });

  it("fails closed when a required dependency is missing", async () => {
    const fixture = createFixture("console.log('unreachable');\n", { dependencies: { "fixture-missing": "1" } });
    await expect(copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory))
      .rejects.toThrow("Subscription package dependency is unavailable");
  });

  it("allows absent optional and optional peer dependencies", async () => {
    const fixture = createFixture("console.log('optional-absent');\n", {
      optionalDependencies: { "fixture-optional": "1" },
      peerDependencies: { "fixture-peer": "1" },
      peerDependenciesMeta: { "fixture-peer": { optional: true } },
    });
    const artifact = await copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory);
    const result = runArtifact(artifact, fixture.root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("optional-absent\n");
  });

  it.skipIf(process.platform === "win32")("rejects a package link to code outside its declared closure", async () => {
    const fixture = fixtureForSnapshot();
    const outside = join(fixture.root, "outside.cjs");
    writeFileSync(outside, "module.exports = 'outside';\n", { mode: 0o600 });
    symlinkSync(outside, join(fixture.packageRoot, "linked.cjs"));
    await expect(copySubscriptionPackageArtifact(fixture.packageRoot, fixture.script, fixture.artifactDirectory))
      .rejects.toThrow("contains a symbolic link");
  });
});

function fixtureForSnapshot() { return createFixture(); }

function fixtureWithDependency() {
  const result = createFixture("console.log(require('fixture-dep'));\n", { dependencies: { "fixture-dep": "1" } });
  writePackage(join(result.modules, "fixture-dep"), "fixture-dep", { "index.cjs": "module.exports = 'dependency';\n" });
  return result;
}
