import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorBundledCommand } from "../plugin-bundled-command.js";
import { resolveBundledArgv } from "../resolve-bundled-argv.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ave-bundled-argv-"));
  roots.push(root);
  const generationRoot = join(root, "generation");
  const dataDir = join(root, "data");
  mkdirSync(join(generationRoot, "server"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(generationRoot, "plugin.json"), "{}");
  writeFileSync(join(generationRoot, "root.js"), "root script");
  writeFileSync(join(generationRoot, "server", "run.js"), "server one");
  return { root, generationRoot, dataDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled argv resolution", () => {
  it("anchors only package paths and expands a data argument", () => {
    const { generationRoot, dataDir } = fixture();
    const input = { generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "server", policy: "hook" as const };
    const resolved = resolveBundledArgv({
      ...input,
      argv: ["node", "${PLUGIN_ROOT}/server/run.js", "${PLUGIN_DATA}/state.json", "literal with spaces"],
    });
    expect(resolved.argv).toEqual(["node", join(realpathSync(generationRoot), "server", "run.js"), join(realpathSync(dataDir), "state.json"), "literal with spaces"]);
    const again = resolveBundledArgv({ ...input, argv: ["node", "./server/run.js", "${PLUGIN_DATA}/state.json", "literal with spaces"] });
    expect(resolved.fingerprint).toBe(again.fingerprint);
    writeFileSync(join(generationRoot, "server", "run.js"), "server two");
    expect(resolveBundledArgv({ ...input, argv: ["node", "./server/run.js"] }).fingerprint).not.toBe(resolved.fingerprint);
  });

  it("preserves a launcher literal containing a slash", () => {
    const { generationRoot, dataDir } = fixture();
    const resolved = resolveBundledArgv({
      generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "server", policy: "mcp",
      argv: ["npx", "@example/server@1.2.3", "--data", "${PLUGIN_DATA}/state.json"],
      launcherLiteralIndexes: [1],
    });
    expect(resolved.argv).toEqual(["npx", "@example/server@1.2.3", "--data", join(realpathSync(dataDir), "state.json")]);
    expect(() => anchorBundledCommand(generationRoot, "plugin.json", ["npx", "@example/server@1.2.3"], "a".repeat(64), "server", [1])).toThrow();
    expect(() => resolveBundledArgv({
      generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "server", policy: "mcp",
      argv: ["npx", "../outside"], launcherLiteralIndexes: [1],
    })).toThrow(/launcher literal/u);
  });

  it("anchors a package file at the generation root", () => {
    const { generationRoot, dataDir } = fixture();
    const resolved = resolveBundledArgv({
      generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "root hook", policy: "hook",
      argv: ["${PLUGIN_ROOT}/root.js"],
    });
    expect(resolved.argv).toEqual([join(realpathSync(generationRoot), "root.js")]);
  });

  it.each([
    ["escaping package reference", ["node", "${PLUGIN_ROOT}/../outside.js"]],
    ["escaping data reference", ["node", "./server/run.js", "${PLUGIN_DATA}/../outside"]],
    ["literal path", ["node", "./server/run.js", "../outside"]],
    ["unexpanded placeholder", ["node", "./server/run.js", "${OTHER}/path"]],
    ["unapproved launcher", ["npx", "package@1.2.3"]],
  ])("refuses %s", (_name, argv) => {
    const { generationRoot, dataDir } = fixture();
    expect(() => resolveBundledArgv({ generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "server", policy: "hook", argv })).toThrow();
  });

  it.runIf(process.platform !== "win32")("refuses a data symlink leaving the data directory", () => {
    const { root, generationRoot, dataDir } = fixture();
    symlinkSync(root, join(dataDir, "outside"));
    expect(() => resolveBundledArgv({
      generationRoot, dataDir, baseFingerprint: "a".repeat(64), label: "server", policy: "hook",
      argv: ["node", "./server/run.js", "${PLUGIN_DATA}/outside/secret"],
    })).toThrow(/symlink/u);
  });
});
