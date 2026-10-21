import { copyFileSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const guide = resolve(root, "docs", "guides", "getting-started.md");
const require = createRequire(import.meta.url);

function trackedPackageFixture() {
  const directory = mkdtempSync(join(tmpdir(), "document-package-"));
  const documents = [
    "docs/guide.md", "docs/other.md", "docs/release/guide.md", "docs/coverage/guide.md",
    "docs/dist/guide.md", "docs/node_modules/guide.md", "docs/mac/x64.md",
    "docs/win/x64.md", "docs/linux/x64.md",
  ];
  for (const path of documents) {
    mkdirSync(resolve(directory, path, ".."), { recursive: true });
    writeFileSync(resolve(directory, path), `SOURCE:${path}\n`);
  }
  mkdirSync(resolve(directory, "resources"));
  mkdirSync(resolve(directory, "dist"));
  writeFileSync(resolve(directory, "dist/app.js"), "void 0;\n");
  writeFileSync(resolve(directory, "package.json"), '{"name":"document-package","version":"1.0.0"}\n');
  symlinkSync("../docs/guide.md", resolve(directory, "resources/alias.md"));
  symlinkSync("alias.md", resolve(directory, "resources/alias-chain.md"));
  symlinkSync("../docs", resolve(directory, "resources/doc-link"));
  symlinkSync("doc-link", resolve(directory, "resources/doc-link-chain"));
  symlinkSync("../dist/app.js", resolve(directory, "resources/code-alias.md"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", directory, ...args], {
      env: gitFixtureEnv(directory), encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "--quiet");
  git("add", "--all", "--force");
  return directory;
}

/**
 * app-builder-lib's file matcher as a packaging run loads it. builder-util
 * decides when it loads whether to hard-link instead of copy, and it chooses
 * hard links whenever `VITEST` is set (`_isUseHardLink`, builder-util/out/fs.js).
 * On Linux link(2) on a symbolic link links the link itself, so a relative
 * alias would land in the oracle's output dangling; a packaging run copies the
 * target's bytes. A fresh instance is loaded with `VITEST` unset.
 */
function packagingFileMatcher() {
  const builderModule = /[\\/]node_modules[\\/](?:app-builder-lib|builder-util)[\\/]/;
  for (const id of Object.keys(require.cache)) {
    if (builderModule.test(id)) delete require.cache[id];
  }
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return require("app-builder-lib/out/fileMatcher.js");
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
}

async function copiedBuilderDocuments(directory: string, build: Record<string, unknown>, destination: string) {
  const { getFileMatchers, getMainFileMatchers, copyFiles } = packagingFileMatcher();
  const copied = new Set<string>();
  for (const platform of ["mac", "win", "linux"]) {
    const arch = "x64";
    const macroExpander = (value: string) => value.replace(/\$\{(arch|os|platform)\}/g, (_, name) =>
      name === "arch" ? arch : platform);
    for (const field of ["files", "extraFiles", "extraResources"]) {
      const target = resolve(destination, platform, field);
      const options = {
        defaultSrc: directory, macroExpander, customBuildOptions: build[platform] ?? {},
        globalOutDir: resolve(directory, "release"),
      };
      const matchers = field === "files"
        ? getMainFileMatchers(directory, target, macroExpander, options.customBuildOptions, {
          info: { config: build, projectDir: directory, buildResourcesDir: "build",
            isPrepackedAppAsar: false, debugLogger: { isEnabled: false } },
        }, options.globalOutDir, false)
        : getFileMatchers(build, field, target, options);
      await copyFiles(matchers, undefined, false);
      const visit = (path: string) => {
        for (const name of readdirSync(path)) {
          const entry = resolve(path, name);
          if (statSync(entry).isDirectory()) visit(entry);
          else {
            const value = readFileSync(entry, "utf8");
            if (value.startsWith("SOURCE:")) copied.add(value.slice("SOURCE:".length).trim());
          }
        }
      };
      if (existsSync(target)) visit(target);
    }
  }
  return [...copied].sort();
}

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
    const referenced = resolve(root, "docs", "blueprints", "plugin-process-isolation.md");
    expect(() => assertAllowedDocumentRead(referenced)).toThrow(/document-consumer/);
  });

  it("permits a document registered for the hook guidance check", () => {
    const consumed = resolve(root, "docs", "design", "plugin-hostapi-protocol.md");
    expect(() => assertAllowedDocumentRead(consumed)).not.toThrow();
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

  it.skipIf(process.platform === "win32")("includes tracked documents under nested output names and through symlinks", () => {
    const directory = trackedPackageFixture();
    try {
      for (const name of ["release", "coverage", "dist", "node_modules"]) {
        const path = `docs/${name}/guide.md`;
        const build = { files: ["dist/**/*"], extraResources: [{ from: path, to: "guide.md" }] };
        expect(packagedDocumentInputs({ build }, directory)).toContain(path);
        expect(() => assertPackagedDocumentInputs({ build }, directory)).toThrow(/document-consumer/);
      }
      for (const from of ["resources/alias.md", "resources/alias-chain.md", "resources/doc-link", "resources/doc-link-chain"]) {
        const build = { files: ["dist/**/*"], extraResources: [{ from, to: "linked" }] };
        expect(packagedDocumentInputs({ build }, directory)).toContain("docs/guide.md");
        expect(() => assertPackagedDocumentInputs({ build }, directory)).toThrow(/document-consumer/);
      }
      expect(packagedDocumentInputs({ build: {
        files: ["dist/**/*"], extraResources: [{ from: "resources/code-alias.md", to: "code.md" }],
      } }, directory)).not.toContain("docs/guide.md");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses external and unresolved tracked package symlinks", () => {
    for (const target of [guide, "../docs/missing.md"]) {
      const directory = trackedPackageFixture();
      try {
        symlinkSync(target, resolve(directory, "resources/unsafe.md"));
        const staged = spawnSync("git", ["-C", directory, "add", "resources/unsafe.md"], {
          env: gitFixtureEnv(directory), encoding: "utf8",
        });
        expect(staged.status).toBe(0);
        expect(() => packagedDocumentInputs({ build: { files: ["dist/**/*"] } }, directory))
          .toThrow(/document-consumer/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform === "win32")("covers copied builder documents across package fields and platform overrides", async () => {
    const directory = trackedPackageFixture();
    const destination = mkdtempSync(join(tmpdir(), "document-builder-oracle-"));
    try {
      const cases: Array<{ name: string; build: Record<string, unknown> }> = [];
      for (const field of ["files", "extraFiles", "extraResources"]) {
        for (const placement of ["root", "mac", "win", "linux"]) {
          const pattern = { from: "docs", filter: ["*.md"] };
          const build = placement === "root"
            ? { files: field === "files" ? ["dist/**/*", pattern] : ["dist/**/*"],
              ...(field === "files" ? {} : { [field]: [pattern] }) }
            : { files: ["dist/**/*"], [placement]: { [field]: [pattern] } };
          cases.push({ name: `${placement}.${field}`, build });
        }
      }
      for (const name of ["release", "coverage", "dist", "node_modules"]) {
        cases.push({ name: `nested.${name}`, build: {
          files: ["dist/**/*"], extraResources: [{ from: `docs/${name}/guide.md`, to: "guide.md" }],
        } });
      }
      cases.push(
        { name: "alias.file", build: { files: ["dist/**/*"], extraResources: [{ from: "resources/alias.md", to: "alias.md" }] } },
        { name: "alias.chain", build: { files: ["dist/**/*"], extraResources: [{ from: "resources/alias-chain.md", to: "alias.md" }] } },
        { name: "alias.directory", build: { files: ["dist/**/*"], extraResources: [{ from: "resources/doc-link", to: "linked" }] } },
        { name: "alias.directory-chain", build: { files: ["dist/**/*"], extraResources: [{ from: "resources/doc-link-chain", to: "linked" }] } },
        { name: "platform.macro", build: { files: ["dist/**/*"], extraResources: ["docs/${os}/${arch}.md"] } },
        { name: "glob", build: { files: ["dist/**/*"], extraResources: ["docs/**/*.md"] } },
        { name: "default.files", build: {} },
        { name: "excluded.files", build: { files: ["docs/**/*.md", "!docs/**/*.md"] } },
      );
      for (const { name, build } of cases) {
        const expected = await copiedBuilderDocuments(directory, build, resolve(destination, name));
        const selected = packagedDocumentInputs({ build }, directory);
        expect(selected, name).toEqual(expect.arrayContaining(expected));
        if (name.startsWith("nested.")) expect(expected, name).toContain(`docs/${name.slice("nested.".length)}/guide.md`);
        if (name.startsWith("alias.")) expect(expected, name).toContain("docs/guide.md");
        if (name === "excluded.files") expect(expected).toEqual([]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
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
      default: { webpack: (config: { plugins: unknown[]; resolve: object }) => { plugins: unknown[] } };
    };
    const config = site.webpack({ plugins: [], resolve: {} });
    expect(config.plugins.some((plugin) => plugin instanceof DocumentDependencyPlugin)).toBe(true);
  });

  it("wires the guard into test, app build, packaging, and site build entrypoints", () => {
    const source = (path: string) => readFileSync(resolve(root, path), "utf8");
    expect(source("vitest.config.ts")).toContain('import "./scripts/lib/document-consumer-guard.mjs"');
    expect(source("config/vitest.analysis.config.ts")).toContain('name: "document-input-guard"');
    expect(source("config/vitest.analysis.config.ts")).toContain("documentGuardImportArgument(),");
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
    for (const name of ["check:source-text-safe", "check:import-cycles", "check:asrt-claims", "test:knip-gate"]) {
      expect(scripts[name]).toContain("node --import ./scripts/lib/document-consumer-guard.mjs --test ");
    }
  });

  it("records the readers that require manual inventory registration", () => {
    for (const path of ["AGENTS.md", ".github/CONTRIBUTING.md", ".github/pull_request_template.md"]) {
      const guidance = readFileSync(resolve(root, path), "utf8");
      expect(guidance).toContain("openAsBlob");
      expect(guidance).toContain("documentation-references.json");
    }
  });
});
