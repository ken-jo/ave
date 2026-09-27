import { copyFileSync, globSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertAllowedDocumentRead,
  assertBundledDocumentInputs,
  assertPackagedDocumentInputs,
  packagedDocumentInputs,
  DocumentDependencyPlugin,
} from "../../scripts/lib/document-consumer-guard.mjs";

const root = resolve(import.meta.dirname, "../..");
const guide = resolve(root, "docs", "guides", "getting-started.md");

describe("documentation consumer guard", () => {
  it("rejects reads assembled from path segments", async () => {
    expect(() => readFileSync(guide, "utf8")).toThrow(/document-consumer/);
    await expect(readFile(guide, "utf8")).rejects.toThrow(/document-consumer/);
    expect(() => copyFileSync(guide, join(tmpdir(), "unused-document-copy.md"))).toThrow(/document-consumer/);
  });

  it("rejects reads after directory and glob discovery", () => {
    const directory = resolve(root, "docs", "guides");
    const discovered = readdirSync(directory).find((name) => name === "getting-started.md");
    expect(discovered).toBeDefined();
    expect(() => readFileSync(join(directory, discovered!), "utf8")).toThrow(/document-consumer/);
    const globbed = globSync("*.md", { cwd: directory });
    expect(globbed).toContain("getting-started.md");
    expect(() => readFileSync(join(directory, globbed.find((name) => name === "getting-started.md")!), "utf8"))
      .toThrow(/document-consumer/);
  });

  it("propagates the guard to spawned Node readers", () => {
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    const child = spawnSync(node, ["-e", "require('node:fs').readFileSync(process.argv[1])", guide], {
      env: process.env, encoding: "utf8",
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("[document-consumer]");
  });

  it.skipIf(process.platform === "win32")("rejects an alias to an unlisted document", () => {
    const directory = mkdtempSync(join(tmpdir(), "document-alias-"));
    try {
      const alias = join(directory, "guide.md");
      symlinkSync(guide, alias);
      expect(() => readFileSync(alias, "utf8")).toThrow(/document-consumer/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects raw and glob imports of unconsumed documents", async () => {
    await expect(import("./fixtures/document-raw-consumer.mjs")).rejects.toThrow(/document-consumer/);
    await expect(import("./fixtures/document-glob-consumer.mjs")).rejects.toThrow(/document-consumer/);
  });

  it("rejects a new byte consumer of a previously referenced document", () => {
    const referenced = resolve(root, "docs", "design", "plugin-hostapi-protocol.md");
    expect(() => assertAllowedDocumentRead(referenced)).toThrow(/document-consumer/);
  });

  it("rejects packaging and bundle inputs outside the consumed inventory", () => {
    expect(() => assertPackagedDocumentInputs({ build: {
      files: ["dist/**/*"],
      extraResources: [{ from: "docs/guides/getting-started.md", to: "guide.md" }],
    } }, root)).toThrow(/document-consumer/);
    expect(() => assertBundledDocumentInputs([guide], root)).toThrow(/document-consumer/);
    expect(() => assertPackagedDocumentInputs({ build: {
      files: ["dist/**/*"],
      extraResources: [{ from: "docs/guides", to: "guides" }],
    } }, root)).toThrow(/document-consumer/);
    expect(() => assertPackagedDocumentInputs({ build: {
      files: ["dist/**/*"],
      extraResources: [{ from: "docs/blueprints/a2a-subagent-messaging.md", to: "contract.md" }],
    } }, root)).not.toThrow();
  });

  it("checks effective platform entries, string globs, and filtered file sets", () => {
    const files = ["dist/**/*"];
    expect(() => assertPackagedDocumentInputs({ build: {
      files, mac: { extraResources: [{ from: "docs/guides/getting-started.md", to: "guide.md" }] },
    } }, root)).toThrow(/docs\/guides\/getting-started\.md/);
    expect(() => assertPackagedDocumentInputs({ build: {
      files, extraResources: ["*/**/*.md"],
    } }, root)).toThrow(/document-consumer/);
    expect(packagedDocumentInputs({ build: {
      files, extraResources: ["*/**/*.md"],
    } }, root)).toContain("docs/guides/getting-started.md");
    for (const platform of ["mac", "win", "linux"]) {
      expect(() => assertPackagedDocumentInputs({ build: {
        files, [platform]: { extraFiles: [{ from: "docs/guides", filter: ["getting-started.md"] }] },
      } }, root)).toThrow(/docs\/guides\/getting-started\.md/);
    }
    for (const field of ["files", "extraResources", "extraFiles"]) {
      for (const placement of ["root", "mac", "win", "linux"]) {
        const pattern = { from: "docs/guides", filter: ["getting-started.md"] };
        const build = placement === "root"
          ? { files: field === "files" ? [...files, pattern] : files, ...(field === "files" ? {} : { [field]: [pattern] }) }
          : { files, [placement]: { [field]: [pattern] } };
        expect(() => assertPackagedDocumentInputs({ build }, root), `${placement}.${field}`)
          .toThrow(/docs\/guides\/getting-started\.md/);
      }
    }
    expect(() => assertPackagedDocumentInputs({ build: {
      files: [...files, "docs/guides/*.md", "!docs/guides/*.md"],
    } }, root)).not.toThrow();
    expect(() => assertPackagedDocumentInputs({ build: {
      files, extraResources: [{ from: "../outside-documents", filter: ["*.md"] }],
    } }, root)).toThrow(/source leaves the repository/);
  });

  it("rejects a document dependency from a site or renderer compilation", () => {
    let inspect: ((compilation: { fileDependencies: Set<string> }) => void) | undefined;
    new DocumentDependencyPlugin().apply({
      hooks: { afterCompile: { tap(_name: string, callback: typeof inspect) { inspect = callback; } } },
    });
    expect(inspect).toBeDefined();
    expect(() => inspect!({ fileDependencies: new Set([guide]) })).toThrow(/document-consumer/);
  });

  it("installs the document dependency check in the site build configuration", async () => {
    const { default: site } = await import(resolve(root, "web/next.config.mjs")) as {
      default: { webpack: (config: { plugins: unknown[] }) => { plugins: unknown[] } };
    };
    const config = site.webpack({ plugins: [] });
    expect(config.plugins.some((plugin) => plugin instanceof DocumentDependencyPlugin)).toBe(true);
  });

  it("wires the guard into test, app build, packaging, and site build entrypoints", () => {
    const source = (path: string) => readFileSync(resolve(root, path), "utf8");
    expect(source("vitest.config.ts")).toContain('import "./scripts/lib/document-consumer-guard.mjs"');
    expect(source("vitest.analysis.config.ts")).toContain('name: "document-input-guard"');
    expect(source("vitest.analysis.config.ts")).toContain('`--import=${rootPath("scripts/lib/document-consumer-guard.mjs")}`');
    expect(source("scripts/build-main-esbuild.mjs")).toContain("assertBundledDocumentInputs(Object.keys(result.metafile.inputs)");
    expect(source("scripts/build-main-esbuild.mjs")).toContain("assertPackagedDocumentInputs(JSON.parse(");
    expect(source("package.json")).toContain("node --import ./scripts/lib/document-consumer-guard.mjs ./node_modules/webpack/bin/webpack.js");
    expect(source("scripts/build-installers.mjs")).toContain("assertPackagedDocumentInputs(JSON.parse(readFileSync(");
    expect(source("webpack.config.cjs")).toContain("assertBundledDocumentInputs(compilation.fileDependencies)");
    expect(source("scripts/copy-build-assets.mjs")).toContain('import "./lib/document-consumer-guard.mjs"');
    expect(source("web/next.config.mjs")).toContain("config.plugins.push(new DocumentDependencyPlugin())");
    expect(source("web/package.json")).toContain("node ../scripts/run-web-build.mjs");
    expect(source("scripts/run-web-build.mjs")).toContain("NODE_OPTIONS:");
    const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(Object.values(scripts).some((command) => command.includes("node --test "))).toBe(false);
    for (const name of ["check:source-text-safe", "check:import-cycles", "check:asrt-claims", "test:ci-tooling"]) {
      expect(scripts[name]).toContain("node --import ./scripts/lib/document-consumer-guard.mjs --test ");
    }
  });

  it("records the readers that require manual inventory registration", () => {
    for (const path of ["AGENTS.md", "CONTRIBUTING.md", ".github/pull_request_template.md"]) {
      const guidance = readFileSync(resolve(root, path), "utf8");
      expect(guidance).toContain("openAsBlob");
      expect(guidance).toContain("documentation-references.json");
    }
  });
});
