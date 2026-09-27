import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDocumentationChanges,
  isDocumentationPath,
} from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { checkPushedDocumentation } from "../../scripts/hooks/pre-push-document-safety.mjs";

const root = resolve(import.meta.dirname, "../..");
const inventory = JSON.parse(readFileSync(resolve(root, "scripts/hooks/documentation-references.json"), "utf8")) as {
  consumed: string[];
  referencedOnly: string[];
};
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const modified = (path: string) => ({ status: "M", path, oldMode: "100644", newMode: "100644" });

describe("documentation impact policy", () => {
  it.each([
    "docs/design/new-feature.md",
    "docs/blueprints/new-feature.md",
    "docs/security/new-review.html",
    "docs/architecture/new-design.md",
    "docs/guides/new-guide.md",
    "docs/blueprints/plugin-process-isolation.md",
    "docs/design/plugin-hostapi-protocol.md",
  ])("skips the heavy checks for unconsumed prose at %s", (path) => {
    expect(classifyDocumentationChanges([modified(path)]).docsOnly).toBe(true);
  });

  it.each([
    "resources/AGENTS.md",
    "docs/design/permission-review-scenario-board-v2.html",
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/ci.yml",
    "web/app/page.html",
  ])("runs the full checks when %s is consumed", (path) => {
    expect(classifyDocumentationChanges([modified(path)]).docsOnly).toBe(false);
  });

  it("runs full checks for a mixed change", () => {
    expect(classifyDocumentationChanges([
      modified("docs/design/new-feature.md"),
      modified("src/main.ts"),
    ]).docsOnly).toBe(false);
  });

  it.each(["D", "R100"])('runs full checks for status %s', (status) => {
    expect(classifyDocumentationChanges([{ ...modified("docs/design/new-feature.md"), status }]).docsOnly).toBe(false);
  });

  it.each([
    ["000000", "120000"],
    ["120000", "120000"],
    ["100644", "100755"],
  ])("requires ordinary document mode (%s to %s)", (oldMode, newMode) => {
    expect(classifyDocumentationChanges([{ ...modified("docs/design/new-feature.md"), oldMode, newMode }]).docsOnly).toBe(false);
  });

  it("runs full checks for empty or noncanonical changes", () => {
    expect(classifyDocumentationChanges([]).docsOnly).toBe(false);
    expect(classifyDocumentationChanges([modified("docs/../design/new-feature.md")]).docsOnly).toBe(false);
  });

  it("keeps every referenced tracked document in the consumed inventory", () => {
    const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
    const sourceFiles = git("ls-files", "-z", "--", "src", "test", "scripts")
      .split("\0").filter((file) => /\.(?:[cm]?js|tsx?|css|sh|ps1)$/.test(file));
    const referenced = new Set<string>();
    for (const file of sourceFiles) {
      for (const line of readFileSync(resolve(root, file), "utf8").split("\n")) {
        for (const match of line.matchAll(/docs\/[A-Za-z0-9_./-]+\.(?:md|html)\b/g)) {
          if (tracked.has(match[0])) referenced.add(match[0]);
        }
      }
    }
    const sourceLock = readFileSync(resolve(root, "src/__tests__/packaging-discipline-source.test.ts"), "utf8");
    for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]) {
      expect(sourceLock).toContain(`readRepoFile("${name}")`);
      referenced.add(name);
    }
    const registryTest = readFileSync(resolve(root, "src/plugins/__tests__/registry-atomicity.test.ts"), "utf8");
    expect(registryTest).toContain('"README.md"');
    expect(registryTest).toContain("readFile(resolve(repoRoot, relativePath)");
    referenced.add("README.md");
    const all = [...inventory.consumed, ...inventory.referencedOnly];
    expect(all).toEqual([...new Set(all)]);
    expect(inventory.consumed).toEqual([...inventory.consumed].sort());
    expect(inventory.referencedOnly).toEqual([...inventory.referencedOnly].sort());
    expect(all.sort()).toEqual([...referenced].sort());
    for (const path of all) {
      expect(tracked.has(path)).toBe(true);
      expect(existsSync(join(root, path))).toBe(true);
      expect(isDocumentationPath(path)).toBe(inventory.referencedOnly.includes(path));
    }
  });

  it("uses the same policy for the Git diff command", () => {
    const repo = mkdtempSync(join(tmpdir(), "docs-impact-"));
    const cli = resolve(root, "scripts/hooks/classify-docs-diff.mjs");
    const runGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    try {
      runGit("init", "-q");
      runGit("config", "user.name", "Test Author");
      runGit("config", "user.email", "test@example.invalid");
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs", "example.md"), "base\n");
      runGit("add", "docs/example.md");
      runGit("commit", "-qm", "base");
      const base = runGit("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "docs", "example.md"), "documentation\n");
      runGit("commit", "-qam", "docs");
      expect(execFileSync("node", [cli, base], { cwd: repo, encoding: "utf8" })).toBe("docs_only=true\n");
      rmSync(join(repo, "docs", "example.md"));
      runGit("commit", "-qam", "remove docs");
      expect(execFileSync("node", [cli, base], { cwd: repo, encoding: "utf8" })).toBe("docs_only=false\n");
      expect(spawnSync("node", [cli, "0".repeat(40)], { cwd: repo }).status).not.toBe(0);
      if (process.platform !== "win32") {
        writeFileSync(join(repo, "source.txt"), "source\n");
        writeFileSync(join(repo, "other.txt"), "other\n");
        writeFileSync(join(repo, "docs", "example.md"), "document\n");
        runGit("add", ".");
        runGit("commit", "-qm", "fixture base");
        const ordinaryBase = runGit("rev-parse", "HEAD").trim();
        symlinkSync("../source.txt", join(repo, "docs", "link.md"));
        runGit("add", "docs/link.md");
        runGit("commit", "-qm", "link added");
        expect(execFileSync("node", [cli, ordinaryBase], { cwd: repo, encoding: "utf8" })).toBe("docs_only=false\n");
        const linkBase = runGit("rev-parse", "HEAD").trim();
        rmSync(join(repo, "docs", "link.md"));
        symlinkSync("../other.txt", join(repo, "docs", "link.md"));
        runGit("commit", "-qam", "link retargeted");
        expect(execFileSync("node", [cli, linkBase], { cwd: repo, encoding: "utf8" })).toBe("docs_only=false\n");
        const executableBase = runGit("rev-parse", "HEAD").trim();
        chmodSync(join(repo, "docs", "example.md"), 0o755);
        runGit("commit", "-qam", "mode changed");
        expect(execFileSync("node", [cli, executableBase], { cwd: repo, encoding: "utf8" })).toBe("docs_only=false\n");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("checks committed documentation even with an empty index", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushed-doc-safety-"));
    const runGit = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    try {
      runGit("init", "-q");
      runGit("config", "user.name", "Test Author");
      runGit("config", "user.email", "test@example.invalid");
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs", "guide.md"), "clean\n");
      runGit("add", ".");
      runGit("commit", "-qm", "base");
      const baseSha = runGit("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "docs", "guide.md"), "trailing whitespace  \n");
      runGit("commit", "-qam", "whitespace");
      const whitespaceSha = runGit("rev-parse", "HEAD").trim();
      expect(runGit("diff", "--cached", "--check")).toBe("");
      expect(() => checkPushedDocumentation(repo, [{ baseSha, localSha: whitespaceSha, path: "docs/guide.md" }]))
        .toThrow(/pushed diff failed/);
      writeFileSync(join(repo, "docs", "guide.md"), "<<<<<<< branch\nvalue\n=======\nother\n>>>>>>> branch\n");
      runGit("commit", "-qam", "conflict markers");
      const markerSha = runGit("rev-parse", "HEAD").trim();
      expect(() => checkPushedDocumentation(repo, [{ baseSha: whitespaceSha, localSha: markerSha, path: "docs/guide.md" }]))
        .toThrow(/merge marker|pushed diff failed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps required CI checks green only after successful documentation classification", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    for (const jobName of ["build-and-test", "windows-permission-tests", "macos-permission-tests"]) {
      const job = workflow.split(`  ${jobName}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]+:\n/)[0];
      expect(job).toBeDefined();
      const steps = job!.split(/^      - /m).slice(1);
      expect(steps[0]).toContain("fetch-depth: 0");
      expect(steps[1]).toContain("id: docs-impact");
      expect(steps[1]).toContain('node scripts/hooks/classify-docs-diff.mjs "$BASE_SHA"');
      expect(steps[1]).toContain("echo 'docs_only=false' >> \"$GITHUB_OUTPUT\"");
      for (const step of steps.slice(2)) {
        if (step.startsWith("name: Check documentation diff")) {
          expect(step).toContain("if: steps.docs-impact.outputs.docs_only == 'true'");
          expect(step).toContain("git diff --check");
        } else if (step.startsWith("name: Check documentation policy")) {
          expect(step).toContain("if: steps.docs-impact.outputs.docs_only == 'true'");
          expect(step).toContain("check-asrt-version-claims.mjs");
        } else {
          expect(step).toContain("if: steps.docs-impact.outputs.docs_only != 'true'");
        }
      }
    }
  });

  it("keeps push safety checks ahead of the shared documentation policy", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    expect(hook).toContain("classifyDocumentationChanges(changedEntries)");
    expect(hook).toContain("checkPushedDocumentation(repoRoot, classification.pushedEntries)");
    expect(hook).toContain('run(commands.node, ["scripts/check-asrt-version-claims.mjs"], repoRoot)');
    const dispatch = hook.slice(hook.indexOf('if (stage === "pre-commit")'));
    expect(dispatch.indexOf("runStagedSafetyChecks(repoRoot)")).toBeLessThan(
      dispatch.indexOf("classifyPrePushChanges(repoRoot, prePushUpdates, remote, remoteLocation)"),
    );
    expect(hook).toContain('run(commands.git, ["diff", "--cached", "--check"], repoRoot)');
    expect(hook).toContain("mergeMarkers.test(stagedContent)");
  });

  it("keeps the documentation-wide policy gate on the fast path", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["check:gate-core"]).toContain("check:asrt-claims");
    expect(manifest.scripts["check:asrt-claims"]).toContain("check-asrt-version-claims.mjs");
    expect(manifest.scripts["check:a2a-p4-5-contract"]).toContain("check-a2a-p4-5-contract.mjs");
    expect(inventory.consumed).toContain("docs/blueprints/a2a-subagent-messaging.md");
    expect(inventory.consumed).toContain("docs/protocols/ave-a2a-exact-send-replay.md");
    const policySource = readFileSync(resolve(root, "scripts/check-asrt-version-claims.mjs"), "utf8");
    expect(policySource).toContain('const SCAN_DIRS = ["src", "scripts", "docs"]');
  });

  it("describes the surviving targeted test push path", () => {
    for (const file of ["AGENTS.md", "CONTRIBUTING.md", ".github/pull_request_template.md"]) {
      expect(readFileSync(resolve(root, file), "utf8").includes("test-only")).toBe(true);
    }
  });
});
