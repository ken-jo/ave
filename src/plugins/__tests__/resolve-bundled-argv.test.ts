import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorBundledCommand } from "../plugin-bundled-command.js";
import { resolveBundledArgv, resolveProcessEntryEnvironmentValue } from "../resolve-bundled-argv.js";

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

// Process executables must be regular package files; rooted args and env values must exist inside the package.
// PLUGIN_DATA leaves may be absent but must obey data-root containment.
describe("bundled argv resolution for a process entry", () => {
  function processFixture() {
    const paths = fixture();
    mkdirSync(join(paths.generationRoot, "bin"));
    mkdirSync(join(paths.generationRoot, "vendor"));
    writeFileSync(join(paths.generationRoot, "bin", "x"), "#!/bin/sh\n");
    chmodSync(join(paths.generationRoot, "bin", "x"), 0o755);
    return paths;
  }
  const resolveProcess = (generationRoot: string, dataDir: string, argv: string[]) =>
    resolveBundledArgv({ generationRoot, dataDir, baseFingerprint: "", label: "process", policy: "process", argv });

  it("expands a file, a directory and a not-yet-existing data path to contained absolute paths", () => {
    const { generationRoot, dataDir } = processFixture();
    const root = realpathSync(generationRoot);
    const resolved = resolveProcess(generationRoot, dataDir, [
      "${PLUGIN_ROOT}/bin/x",
      "${PLUGIN_ROOT}/vendor",
      "${PLUGIN_DATA}/state",
      "--level=1",
    ]);
    expect(resolved.argv).toEqual([
      join(root, "bin", "x"),
      join(root, "vendor"),
      join(realpathSync(dataDir), "state"),
      "--level=1",
    ]);
    expect(resolveProcess(generationRoot, dataDir, ["./bin/x"]).argv).toEqual([join(root, "bin", "x")]);
  });

  it("expands environment values with the same two rules and passes other values through", () => {
    const { generationRoot, dataDir } = processFixture();
    expect(resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${PLUGIN_ROOT}/vendor", "env"))
      .toBe(join(realpathSync(generationRoot), "vendor"));
    expect(resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${PLUGIN_DATA}/cache", "env"))
      .toBe(join(realpathSync(dataDir), "cache"));
    expect(resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "/opaque/value", "env")).toBe("/opaque/value");
    expect(() => resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${HOME}/x", "env")).toThrow(/placeholder/u);
    expect(() => resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${PLUGIN_ROOT}/nope", "env"))
      .toThrow(/does not contain/u);
  });

  it("refuses a root path the package does not contain", () => {
    const { generationRoot, dataDir } = processFixture();
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_ROOT}/nope"]))
      .toThrow(/does not contain/u);
  });

  it("refuses a directory as the executable", () => {
    const { generationRoot, dataDir } = processFixture();
    expect(() => resolveProcess(generationRoot, dataDir, ["${PLUGIN_ROOT}/vendor"])).toThrow(/regular file/u);
  });

  it.each([
    ["a bare executable name", ["node"]],
    ["a data path as the executable", ["${PLUGIN_DATA}/x"]],
    ["a literal argument that looks like a path", ["./bin/x", "./vendor"]],
    ["another placeholder", ["./bin/x", "${HOME}/x"]],
    ["an escaping root argument", ["./bin/x", "${PLUGIN_ROOT}/../outside"]],
  ])("refuses %s", (_name, argv) => {
    const { generationRoot, dataDir } = processFixture();
    expect(() => resolveProcess(generationRoot, dataDir, argv)).toThrow();
  });

  it.runIf(process.platform !== "win32")("refuses a root symlink leaving the plugin root", () => {
    const { root, generationRoot, dataDir } = processFixture();
    symlinkSync(root, join(generationRoot, "vendor", "outside"));
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_ROOT}/vendor/outside"]))
      .toThrow(/escapes PLUGIN_ROOT through a symlink/u);
  });

  it.runIf(process.platform !== "win32")("refuses a data symlink leaving the data directory", () => {
    const { root, generationRoot, dataDir } = processFixture();
    symlinkSync(root, join(dataDir, "outside"));
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_DATA}/outside/secret"]))
      .toThrow(/passes through a symlink inside PLUGIN_DATA/u);
  });

  it.runIf(process.platform !== "win32")("refuses a dangling data symlink, whose target a write would create outside", () => {
    const { root, generationRoot, dataDir } = processFixture();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside", "absent"), join(dataDir, "link"));
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_DATA}/link"]))
      .toThrow(/passes through a symlink inside PLUGIN_DATA \('link'\)/u);
    expect(() => resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${PLUGIN_DATA}/link", "env"))
      .toThrow(/passes through a symlink inside PLUGIN_DATA \('link'\)/u);
    // Below a dangling link too: the leaf is missing, the link is not.
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_DATA}/link/leaf"]))
      .toThrow(/passes through a symlink inside PLUGIN_DATA \('link'\)/u);
    expect(existsSync(join(root, "outside", "absent"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")("refuses a data symlink that stays inside the data directory", () => {
    const { generationRoot, dataDir } = processFixture();
    mkdirSync(join(dataDir, "real"));
    symlinkSync(join(dataDir, "real"), join(dataDir, "alias"));
    expect(() => resolveProcess(generationRoot, dataDir, ["./bin/x", "${PLUGIN_DATA}/alias/state"]))
      .toThrow(/passes through a symlink inside PLUGIN_DATA \('alias'\)/u);
  });

  it("accepts a data path whose leaf, and parents, do not exist yet", () => {
    const { generationRoot, dataDir } = processFixture();
    expect(resolveProcessEntryEnvironmentValue(generationRoot, dataDir, "${PLUGIN_DATA}/state/cache/db", "env"))
      .toBe(join(realpathSync(dataDir), "state", "cache", "db"));
  });

  // Resolve trusted ancestors, reject a replaced root, then walk every component below it.
  it.runIf(process.platform !== "win32")(
    "resolves a data root behind a linked ancestor, refuses a root replaced by a link, and refuses a link below it, for every consumer",
    () => {
      const { root, generationRoot } = processFixture();
      const realParent = join(root, "volume");
      const realData = join(realParent, "data");
      mkdirSync(join(realData, "real"), { recursive: true });
      symlinkSync(join(realData, "real"), join(realData, "alias"));
      symlinkSync(realParent, join(root, "linked-ancestor"));
      // A confined child can replace its data directory with a link after host creation.
      const takenOver = join(root, "taken-over", "data");
      const outside = join(root, "outside");
      mkdirSync(takenOver, { recursive: true });
      mkdirSync(outside);
      rmSync(takenOver, { recursive: true });
      symlinkSync(outside, takenOver);
      const consumers: Array<[string, (dataDir: string, token: string) => string]> = [
        ["hook", (dataDir, token) => resolveBundledArgv({
          generationRoot, dataDir, baseFingerprint: "", label: "hook", policy: "hook", argv: ["node", "./root.js", token],
        }).argv[2]!],
        ["mcp", (dataDir, token) => resolveBundledArgv({
          generationRoot, dataDir, baseFingerprint: "", label: "mcp", policy: "mcp", argv: ["node", "./root.js", token],
        }).argv[2]!],
        ["process argument", (dataDir, token) => resolveProcess(generationRoot, dataDir, ["./bin/x", token]).argv[1]!],
        ["process env", (dataDir, token) => resolveProcessEntryEnvironmentValue(generationRoot, dataDir, token, "env")],
      ];
      const resolvedData = realpathSync(realData);
      const viaAncestor = join(root, "linked-ancestor", "data");
      for (const [name, resolveToken] of consumers) {
        expect(resolveToken(viaAncestor, "${PLUGIN_DATA}"), name).toBe(resolvedData);
        expect(resolveToken(viaAncestor, "${PLUGIN_DATA}/state"), name).toBe(join(resolvedData, "state"));
        expect(() => resolveToken(viaAncestor, "${PLUGIN_DATA}/alias/state"), name)
          .toThrow(/passes through a symlink inside PLUGIN_DATA \('alias'\)/u);
        for (const token of ["${PLUGIN_DATA}", "${PLUGIN_DATA}/state"]) {
          expect(() => resolveToken(takenOver, token), `${name} ${token}`)
            .toThrow(/the plugin data root .* is a symlink, not the directory the host created/u);
        }
      }
      expect(readdirSync(outside)).toEqual([]);
    },
  );
});
