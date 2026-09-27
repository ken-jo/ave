import { copyFileSync, globSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertAllowedDocumentRead,
  assertBundledDocumentInputs,
  assertPackagedDocumentInputs,
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
      extraResources: [{ from: "docs/guides/getting-started.md", to: "guide.md" }],
    } }, root)).toThrow(/document-consumer/);
    expect(() => assertBundledDocumentInputs([guide], root)).toThrow(/document-consumer/);
    expect(() => assertPackagedDocumentInputs({ build: {
      extraResources: [{ from: "docs/guides", to: "guides" }],
    } }, root)).toThrow(/document-consumer/);
    expect(() => assertPackagedDocumentInputs({ build: {
      extraResources: [{ from: "docs/blueprints/a2a-subagent-messaging.md", to: "contract.md" }],
    } }, root)).not.toThrow();
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
  });
});
