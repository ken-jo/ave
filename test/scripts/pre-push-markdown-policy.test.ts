import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDocumentationChanges,
  isDocumentationPath,
} from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { checkPushedDocumentation } from "../../scripts/hooks/pre-push-document-safety.mjs";
import { packagedDocumentInputs } from "../../scripts/lib/document-consumer-guard.mjs";
import { gitFixtureEnv } from "../../src/__tests__/support/git-fixture-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const inventory = JSON.parse(readFileSync(resolve(root, "scripts/hooks/documentation-references.json"), "utf8")) as {
  consumed: string[];
  referencedOnly: string[];
  readers: Record<string, string[]>;
};
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", env: gitFixtureEnv(root),
});
const fixtureGit = (repo: string, args: string[], source = process.env) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", env: gitFixtureEnv(repo, source),
  });
const fixtureCli = (repo: string, cli: string, base: string, source = process.env) =>
  execFileSync("node", [cli, base, "HEAD", "pull_request"], {
    cwd: repo, encoding: "utf8", env: gitFixtureEnv(repo, source),
  });
const modified = (path: string) => ({ status: "M", path, oldMode: "100644", newMode: "100644" });

describe("documentation impact policy", () => {
  it.each([
    "docs/design/new-feature.md",
    "docs/blueprints/new-feature.md",
    "docs/security/new-review.html",
    "docs/architecture/new-design.md",
    "docs/guides/new-guide.md",
    "docs/blueprints/plugin-process-isolation.md",
  ])("skips the heavy checks for unconsumed prose at %s", (path) => {
    expect(classifyDocumentationChanges([modified(path)]).docsOnly).toBe(true);
  });

  it.each([
    "resources/AGENTS.md",
    "docs/design/permission-review-scenario-board-v2.html",
    "docs/design/plugin-hostapi-protocol.md",
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
    for (const name of ["AGENTS.md", "CLAUDE.md", ".github/CONTRIBUTING.md"]) {
      expect(sourceLock).toContain(`readRepoFile("${name}")`);
      referenced.add(name);
    }
    const registryTest = readFileSync(resolve(root, "src/plugins/__tests__/registry-atomicity.test.ts"), "utf8");
    expect(registryTest).toContain('"README.md"');
    expect(registryTest).toContain("readFile(resolve(repoRoot, relativePath)");
    referenced.add("README.md");
    const packaged = packagedDocumentInputs(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")), root);
    for (const path of packaged) referenced.add(path);
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

  it("records every reader of each test-read document with a reader set", () => {
    // A change to a document in `readers` runs only those files on the fast
    // tier, so the set has to be complete: every test file or source module
    // naming the document, plus the whole-tree scan of repository-identity
    // unless that suite excludes the path. Packaged documents and documents a
    // script reads are build or gate inputs and stay on the full checks.
    const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
    const trackedSet = new Set(tracked);
    const packaged = new Set(packagedDocumentInputs(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")), root));
    // The hook's own policy suites name documents as fixtures, not reads.
    const codeFiles = tracked.filter((file) => /^(?:src|test|scripts|config)\//.test(file) && /\.(?:[cm]?[jt]sx?|json)$/.test(file) &&
      file !== "scripts/hooks/documentation-references.json" &&
      !/^test\/scripts\/pre-push-[^/]+\.test\.ts$/.test(file));
    const identitySuite = "test/scripts/repository-identity.test.ts";
    const identitySource = readFileSync(resolve(root, identitySuite), "utf8");
    const notCheckedBlock = identitySource.slice(identitySource.indexOf("const NOT_CHECKED"), identitySource.indexOf("function matchesEntry"));
    const notChecked = [...notCheckedBlock.matchAll(/\["([^"]+)", "/g)].map((match) => match[1]!);
    expect(notChecked.length).toBeGreaterThan(3);
    const keys = Object.keys(inventory.readers);
    expect(keys).toEqual([...keys].sort());
    for (const [document, readers] of Object.entries(inventory.readers)) {
      expect(trackedSet.has(document), document).toBe(true);
      expect(isDocumentationPath(document), `${document} is test-read`).toBe(false);
      expect(packaged.has(document), `${document} is packaged`).toBe(false);
      expect(readers).toEqual([...new Set(readers)].sort());
      const naming = codeFiles.filter((file) => readFileSync(resolve(root, file), "utf8").includes(document));
      expect(naming.filter((file) => !/^(?:src|test)\//.test(file)), `${document} has a script or config reader`).toEqual([]);
      const expected = new Set(naming);
      if (!notChecked.some((entry) => entry.endsWith("/") ? document.startsWith(entry) : document === entry)) {
        expected.add(identitySuite);
      }
      expect(readers, document).toEqual([...expected].sort());
    }
  });

  it("uses the same policy for the Git diff command", () => {
    const repo = mkdtempSync(join(tmpdir(), "docs-impact-"));
    const cli = resolve(root, "scripts/hooks/classify-docs-diff.mjs");
    const runGit = (...args: string[]) => fixtureGit(repo, args);
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
      expect(fixtureCli(repo, cli, base)).toBe("docs_only=true\n");
      rmSync(join(repo, "docs", "example.md"));
      runGit("commit", "-qam", "remove docs");
      expect(fixtureCli(repo, cli, base)).toBe("docs_only=false\n");
      expect(spawnSync("node", [cli, "0".repeat(40), "HEAD", "pull_request"], {
        cwd: repo, env: gitFixtureEnv(repo),
      }).status).not.toBe(0);
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
        expect(fixtureCli(repo, cli, ordinaryBase)).toBe("docs_only=false\n");
        const linkBase = runGit("rev-parse", "HEAD").trim();
        rmSync(join(repo, "docs", "link.md"));
        symlinkSync("../other.txt", join(repo, "docs", "link.md"));
        runGit("commit", "-qam", "link retargeted");
        expect(fixtureCli(repo, cli, linkBase)).toBe("docs_only=false\n");
        const executableBase = runGit("rev-parse", "HEAD").trim();
        chmodSync(join(repo, "docs", "example.md"), 0o755);
        runGit("commit", "-qam", "mode changed");
        expect(fixtureCli(repo, cli, executableBase)).toBe("docs_only=false\n");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("checks committed documentation even with an empty index", () => {
    const repo = mkdtempSync(join(tmpdir(), "pushed-doc-safety-"));
    const runGit = (...args: string[]) => fixtureGit(repo, args);
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

  it("keeps hook Git overrides away from fixture refs, index, and config", () => {
    const directory = mkdtempSync(join(tmpdir(), "git-fixture-isolation-"));
    const sentinel = join(directory, "sentinel");
    const fixture = join(directory, "fixture");
    mkdirSync(sentinel);
    mkdirSync(fixture);
    try {
      fixtureGit(sentinel, ["init", "-q"]);
      fixtureGit(sentinel, ["config", "user.name", "Sentinel"]);
      fixtureGit(sentinel, ["config", "user.email", "sentinel@example.invalid"]);
      writeFileSync(join(sentinel, "sentinel.txt"), "keep\n");
      fixtureGit(sentinel, ["add", "."]);
      fixtureGit(sentinel, ["commit", "-qm", "sentinel"]);
      fixtureGit(sentinel, ["branch", "secondary"]);
      fixtureGit(sentinel, ["tag", "pinned"]);
      const refsRoot = join(sentinel, ".git", "refs");
      const refs = (directory: string): Array<[string, Buffer]> =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? refs(path) : [[relative(refsRoot, path), readFileSync(path)]];
        });
      const metadata = () => ({
        refs: refs(refsRoot),
        index: readFileSync(join(sentinel, ".git", "index")),
        config: readFileSync(join(sentinel, ".git", "config")),
      });
      const before = metadata();
      const poisoned = {
        ...process.env,
        GIT_DIR: join(sentinel, ".git"),
        GIT_COMMON_DIR: join(sentinel, ".git"),
        GIT_WORK_TREE: sentinel,
        GIT_INDEX_FILE: join(sentinel, ".git", "index"),
        GIT_OBJECT_DIRECTORY: join(sentinel, ".git", "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sentinel, ".git", "objects"),
        GIT_CONFIG_GLOBAL: join(sentinel, ".git", "config"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        GIT_PREFIX: "poison/",
      };
      try {
        fixtureGit(fixture, ["init", "-q"], poisoned);
        fixtureGit(fixture, ["config", "user.name", "Fixture"], poisoned);
        fixtureGit(fixture, ["config", "user.email", "fixture@example.invalid"], poisoned);
        mkdirSync(join(fixture, "docs"));
        writeFileSync(join(fixture, "docs", "guide.md"), "base\n");
        fixtureGit(fixture, ["add", "."], poisoned);
        fixtureGit(fixture, ["commit", "-qm", "base"], poisoned);
        const base = fixtureGit(fixture, ["rev-parse", "HEAD"], poisoned).trim();
        writeFileSync(join(fixture, "docs", "guide.md"), "updated\n");
        fixtureGit(fixture, ["commit", "-qam", "docs"], poisoned);
        expect(fixtureCli(fixture, resolve(root, "scripts/hooks/classify-docs-diff.mjs"), base, poisoned))
          .toBe("docs_only=true\n");
      } finally {
        expect(metadata()).toEqual(before);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps required CI checks green only after successful documentation classification", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    for (const jobName of ["build-and-test", "windows-permission-tests", "macos-permission-tests", "linux-confinement-tests"]) {
      const job = workflow.split(`  ${jobName}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]+:\n/)[0];
      expect(job).toBeDefined();
      const steps = job!.split(/^      - /m).slice(1);
      expect(steps[0]).toContain("fetch-depth: 0");
      const classify = steps.findIndex((step) => step.includes("id: docs-impact"));
      expect(classify).toBeGreaterThan(0);
      // Before the classifier only runner preflight may run: the Node it runs
      // on (self-hosted runners have no toolcache) and the runner-variable
      // check. Neither can turn a required check green on its own.
      for (const step of steps.slice(1, classify)) {
        expect(
          step.startsWith("uses: actions/setup-node@") || step.startsWith("name: Require the runner variable"),
          step.split("\n")[0],
        ).toBe(true);
      }
      expect(steps[classify]).toContain('node scripts/hooks/classify-docs-diff.mjs "$BASE_SHA"');
      expect(steps[classify]).toContain("echo 'docs_only=false' >> \"$GITHUB_OUTPUT\"");
      for (const step of steps.slice(classify + 1)) {
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

  it("runs the full CI suite for pushes and fails closed on missing PR bases", () => {
    const repo = mkdtempSync(join(tmpdir(), "docs-ci-event-"));
    const cli = resolve(root, "scripts/hooks/classify-docs-diff.mjs");
    try {
      fixtureGit(repo, ["init", "-q"]);
      fixtureGit(repo, ["config", "user.name", "Fixture"]);
      fixtureGit(repo, ["config", "user.email", "fixture@example.invalid"]);
      mkdirSync(join(repo, "docs"));
      writeFileSync(join(repo, "docs", "guide.md"), "base\n");
      fixtureGit(repo, ["add", "."]);
      fixtureGit(repo, ["commit", "-qm", "base"]);
      const base = fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(repo, "docs", "guide.md"), "updated\n");
      fixtureGit(repo, ["commit", "-qam", "docs"]);
      const classify = (event: string, baseSha: string) => execFileSync("node", [cli, baseSha, "HEAD", event], {
        cwd: repo, encoding: "utf8", env: gitFixtureEnv(repo),
      });
      expect(classify("pull_request", base)).toBe("docs_only=true\n");
      expect(classify("push", base)).toBe("docs_only=false\n");
      expect(classify("push", "0".repeat(40))).toBe("docs_only=false\n");
      expect(execFileSync("node", [cli, base], {
        cwd: repo, encoding: "utf8", env: gitFixtureEnv(repo),
      })).toBe("docs_only=false\n");
      expect(spawnSync("node", [cli, "0".repeat(40), "HEAD", "pull_request"], {
        cwd: repo, env: gitFixtureEnv(repo),
      }).status).not.toBe(0);
      fixtureGit(repo, ["checkout", "-q", "--orphan", "rewritten"]);
      writeFileSync(join(repo, "docs", "guide.md"), "force-pushed docs\n");
      fixtureGit(repo, ["add", "docs/guide.md"]);
      fixtureGit(repo, ["commit", "-qm", "rewritten docs"]);
      expect(spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", base, "HEAD"], {
        env: gitFixtureEnv(repo),
      }).status).not.toBe(0);
      expect(classify("push", base)).toBe("docs_only=false\n");
      expect(classify("pull_request", base)).toBe("docs_only=true\n");
      const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
      // Every job classifies the same way.
      const jobs = workflow.match(/^ {4}runs-on: /gm)?.length ?? 0;
      expect(jobs).toBe(4);
      expect(workflow.match(/EVENT_NAME: \$\{\{ github\.event_name \}\}/g)).toHaveLength(jobs);
      expect(workflow.match(/classify-docs-diff\.mjs "\$BASE_SHA" HEAD "\$EVENT_NAME"/g)).toHaveLength(jobs);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs the retired-name gate in every pre-push tier and in gate-core", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    const dispatch = hook.slice(hook.indexOf("if (classification.alreadyOnRemote)"));
    for (const tier of ["classification.docsOnly", "classification.commentOnly", "classification.testOnly", "classification.fastSource"]) {
      const start = dispatch.indexOf(`} else if (${tier}) {`);
      expect(start, tier).toBeGreaterThan(0);
      const branch = dispatch.slice(start + 1, dispatch.indexOf("} else", start + 1));
      expect(branch, tier).toContain("runRetiredNameGate(repoRoot);");
    }
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["check:gate-core"]).toContain("check:retired-name");
  });

  it("keeps push safety checks ahead of the shared documentation policy", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    expect(hook).toContain("classifyDocumentationChanges(changedEntries)");
    expect(hook).toContain("checkPushedDocumentation(repoRoot, classification.pushedEntries)");
    expect(hook).toContain('run(commands.node, ["scripts/check-asrt-version-claims.mjs"], repoRoot)');
    const dispatch = hook.slice(hook.indexOf('if (stage === "pre-commit")'));
    expect(dispatch.indexOf("runStagedSafetyChecks(repoRoot)")).toBeLessThan(
      dispatch.indexOf("classifyPrePushChanges(repoRoot, withPushedCommits(prePushUpdates, pushCheckout.commitByLocalSha), remoteLocation)"),
    );
    expect(hook).toContain('run(commands.git, ["diff", "--cached", "--check"], repoRoot)');
    expect(hook).toContain("mergeMarkers.test(stagedContent)");
  });

  it("removes hook Git context before full and targeted test runners", () => {
    const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
    expect(hook).toContain('scriptName === "test" ? withoutGitContext() : process.env');
    expect(hook).toContain('"run", ...vitestArgs], dir, withoutGitContext()');
    const source = {
      PATH: process.env.PATH,
      GIT_DIR: "/sentinel/.git",
      GIT_WORK_TREE: "/sentinel",
      GIT_INDEX_FILE: "/sentinel/index",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    };
    const env = gitFixtureEnv(resolve(tmpdir(), "git-fixture-home"), source);
    expect(Object.keys(env).filter((name) => name.startsWith("GIT_"))).toEqual([
      "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
    ]);
    expect(env.HOME).toBe(resolve(tmpdir(), "git-fixture-home"));
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
    for (const file of ["AGENTS.md", ".github/CONTRIBUTING.md", ".github/pull_request_template.md"]) {
      expect(readFileSync(resolve(root, file), "utf8").includes("test-only")).toBe(true);
    }
  });
});
