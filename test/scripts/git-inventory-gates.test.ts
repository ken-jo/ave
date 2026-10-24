import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveShell } from "../../src/lib/shell-resolver.js";

import { describe, expect, it } from "vitest";

import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const bash = resolveShell("bash").cmd;
// A file URL, since import() refuses a bare Windows absolute path.
const documentGuard = pathToFileURL(resolve(root, "scripts/lib/document-consumer-guard.mjs")).href;
const documentProbe = "const { packagedDocumentInputs } = await import(process.argv[1]);"
  + " packagedDocumentInputs({ build: { files: ['dist/**/*'] } }, process.argv[2]);";

function writeGateInputs(directory: string) {
  mkdirSync(join(directory, "build"), { recursive: true });
  writeFileSync(join(directory, "build/generated-assets.json"), '["build/icon.svg"]\n');
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

describe("Git inventory gates", () => {
  it("rejects an empty Git repository instead of reporting a clean inventory", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-git-inventory-"));
    try {
      const baseEnv = gitFixtureEnv(empty);
      expect(run("git", ["-C", empty, "init", "--quiet"], baseEnv).status).toBe(0);
      writeGateInputs(empty);
      const env = { ...baseEnv, GIT_DIR: join(empty, ".git"), AVE_GENERATED_ASSETS_FORCE: "1" };
      const gates = [
        ["test typecheck", node, [resolve(root, "scripts/check-test-typecheck-baseline.mjs")], /empty tracked TypeScript source inventory/],
        ["home paths", bash, [resolve(root, ".github/scripts/home-path-gate.sh"), root], /empty inventory/],
        ["generated assets", node, [resolve(root, "scripts/check-generated-assets.mjs"), "--root", empty], /no tracked generated assets/],
        ["packaged documents", node, ["--input-type=module", "-e", documentProbe, documentGuard, empty], /source inventory is empty/],
      ] as const;
      for (const [name, command, args, diagnostic] of gates) {
        const result = run(command, [...args], env);
        expect(result.status, name).not.toBe(0);
        expect(result.output, name).toMatch(diagnostic);
      }
      const ordinaryEnv: NodeJS.ProcessEnv = { ...env };
      delete ordinaryEnv.AVE_GENERATED_ASSETS_FORCE;
      expect(run(node, [resolve(root, "scripts/check-generated-assets.mjs"), "--root", empty], ordinaryEnv).status)
        .not.toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("uses an explicit repository root despite inherited hook Git selectors", () => {
    const empty = mkdtempSync(join(tmpdir(), "foreign-git-context-"));
    try {
      const baseEnv = gitFixtureEnv(empty);
      // The checkout can belong to a different account than the confined runner.
      writeFileSync(join(empty, ".gitconfig"), `[safe]\n\tdirectory = ${root.replaceAll("\\", "/")}\n`);
      expect(run("git", ["-C", empty, "init", "--quiet"], baseEnv).status).toBe(0);
      const env = { ...baseEnv, GIT_DIR: join(empty, ".git"), GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" };
      for (const script of ["check-generated-assets.mjs"]) {
        const result = run(node, [resolve(root, "scripts", script), "--root", root], env);
        expect(result.status, `${script}: ${result.output}`).toBe(0);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("rejects Git query errors for every inventory gate", () => {
    const missing = mkdtempSync(join(tmpdir(), "missing-git-inventory-"));
    try {
      writeGateInputs(missing);
      const env = { ...gitFixtureEnv(missing), GIT_DIR: join(missing, "absent.git"),
        AVE_GENERATED_ASSETS_FORCE: "1" };
      const gates = [
        [node, [resolve(root, "scripts/check-test-typecheck-baseline.mjs")]],
        [bash, [resolve(root, ".github/scripts/home-path-gate.sh"), root]],
        [node, [resolve(root, "scripts/check-generated-assets.mjs"), "--root", missing]],
        [node, ["--input-type=module", "-e", documentProbe, documentGuard, missing]],
      ] as const;
      for (const [command, args] of gates) {
        expect(run(command, [...args], env).status, `${command} ${args[0]}`).not.toBe(0);
      }
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });
});
