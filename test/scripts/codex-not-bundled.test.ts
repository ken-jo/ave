import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The user supplies this CLI; installers must not bundle a copy.
const repoRoot = resolve(__dirname, "../..");
const CODEX_PACKAGE = /@openai\/codex/;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  build?: { asarUnpack?: string[]; files?: string[]; extraResources?: unknown; extraFiles?: unknown };
}

describe("no Codex CLI ships with Ave", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageJson;

  it("declares no Codex CLI package in any dependency list", () => {
    for (const list of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      expect(Object.keys(list ?? {}).filter((name) => CODEX_PACKAGE.test(name))).toEqual([]);
    }
  });

  it("unpacks, copies or bundles no Codex CLI files", () => {
    const build = JSON.stringify({
      asarUnpack: manifest.build?.asarUnpack,
      files: manifest.build?.files,
      extraResources: manifest.build?.extraResources,
      extraFiles: manifest.build?.extraFiles,
    });
    expect(build).not.toMatch(CODEX_PACKAGE);
  });

  it("locks no Codex CLI package, so a frozen install cannot fetch one", () => {
    const lock = readFileSync(join(repoRoot, "bun.lock"), "utf8");
    expect(lock.match(/"@openai\/codex[^"]*"/g) ?? []).toEqual([]);
  });

  it("selects no Codex CLI package when retargeting a Linux build", () => {
    const installers = readFileSync(join(repoRoot, "scripts/build-installers.mjs"), "utf8");
    const table = /const ARCH_SELECTED_RUNTIME_PACKAGES = \[([\s\S]*?)\];/.exec(installers)?.[1];
    expect(table).toBeDefined();
    expect(table).not.toMatch(CODEX_PACKAGE);
  });

  it("never resolves a Codex CLI from Ave's own node_modules", () => {
    const sources = ["src/main/codex-user-runtime.ts", "src/main/codex-app-server-client.ts", "src/main/codex-conversation-runtime.ts"];
    for (const source of sources) {
      const text = readFileSync(join(repoRoot, source), "utf8");
      expect(text).not.toMatch(/require\.resolve\(\s*[`'"]@openai\/codex/);
      expect(text).not.toMatch(/from\s+["']@openai\/codex/);
      expect(text).not.toMatch(/createRequire/);
    }
  });
});
