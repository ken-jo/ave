import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isDocumentationPath } from "../../scripts/hooks/pre-push-markdown-policy.mjs";
import { withoutGitContext } from "../../scripts/lib/git-process-environment.mjs";
import {
  readRepositoryIdentity,
  repositoryIdentity,
} from "../../scripts/lib/repository-identity.mjs";
import { workflowJobs } from "../../src/__tests__/support/workflow-source.js";
import { HOST_PROTOCOL_NOTIFICATIONS, isHostApiMethod } from "../../src/plugins/isolation/host-api-wire.js";

// Repository references and shipped-agent hashes derive from package.json repository.
// Read prose only through the consumed-document inventory so edits trigger this suite.

const root = process.cwd();
const identity = readRepositoryIdentity(root);

// Exclusions must match tracked paths; a trailing slash denotes a prefix.
const NOT_CHECKED: ReadonlyArray<readonly [string, string]> = [
  ["CHANGELOG.md", "release history"],
  ["docs/architecture/", "historical design records, including consumed ones"],
  ["docs/blueprints/", "historical design records"],
  ["docs/design/", "historical design records"],
  ["src/permissions/__tests__/permission-review-scenario-board.test.ts", "URL-classification input"],
  ["src/permissions/__tests__/verdict-cache.test.ts", "URL-classification input"],
  ["src/tools/__tests__/executor.test.ts", "URL-classification input"],
  ["test/scripts/check-release-repository.test.ts", "the release gate's mismatch fixtures"],
  ["test/scripts/linux-package-arch.test.ts", "packaged-file paths (linux-unpacked/ave), not repository references"],
  ["test/scripts/repository-identity.test.ts", "this file's own fixtures"],
];

function matchesEntry(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function notChecked(path: string): boolean {
  return isDocumentationPath(path) || NOT_CHECKED.some(([entry]) => matchesEntry(path, entry));
}

function git(args: string[]): { status: number | null; stdout: Buffer } {
  const result = spawnSync("git", args, {
    cwd: root,
    env: withoutGitContext(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout };
}

function gitText(...args: string[]): string {
  const result = git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString("utf8");
}

// Earliest tag that still contains the exact agent guidance bytes it shipped.
const FIRST_TAG_WITH_SHIPPED_AGENTS_MD = "v0.14.0";

function compareReleaseTags(left: string, right: string): number {
  const parts = (tag: string) => tag.slice(1).split(".").map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

const trackedFiles = gitText("ls-files", "-z").split("\0").filter((path) => path.length > 0);

function trackedText(path: string): string | null {
  const absolute = resolve(root, path);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return null; // tracked but removed from the working tree
  }
  if (size > 4 * 1024 * 1024) return null;
  const bytes = readFileSync(absolute);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString("utf8");
}

function checkedTexts(): Array<[string, string]> {
  const texts: Array<[string, string]> = [];
  for (const path of trackedFiles) {
    if (notChecked(path)) continue;
    const source = trackedText(path);
    if (source !== null) texts.push([path, source]);
  }
  return texts;
}

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Include the current name and ave so a rename still detects stale references.
const REPOSITORY_SLUG =
  String.raw`([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(` +
  [...new Set([identity.repo, "ave"])].map(escapeRegExp).join("|") +
  String.raw`)(?:\.git)?`;

// Quoted repository slugs may continue into paths, except protocol names.
const REPOSITORY_REFERENCES = [
  new RegExp(
    String.raw`(?:github\.com[/:]|repos/|-R\s+|--repo[ =]|repository:\s*["']?)` + REPOSITORY_SLUG + String.raw`(?![\w.-])`,
    "gu",
  ),
  new RegExp(String.raw`(["'\x60])` + REPOSITORY_SLUG + String.raw`(?![\w.-])`, "gu"),
];

// Derive notification namespaces from protocol names.
const NOTIFICATION_NAMESPACES = [
  ...new Set(
    Object.values(HOST_PROTOCOL_NOTIFICATIONS)
      .map((name) => name.split("/"))
      .filter((segments) => segments.length > 2)
      .map((segments) => `${segments[0]}/${segments[1]}/`),
  ),
];

const GOLDEN_METHOD_DIRECTORY = "methods/";

// Protocol notification names and method-fixture paths resemble repository slugs.
function isProtocolName(token: string): boolean {
  if (NOTIFICATION_NAMESPACES.some((namespace) => token.startsWith(namespace))) return true;
  return token.startsWith(GOLDEN_METHOD_DIRECTORY) && isHostApiMethod(token.slice(GOLDEN_METHOD_DIRECTORY.length));
}

function repositoryReferences(source: string): Array<{ named: string; index: number }> {
  const found: Array<{ named: string; index: number }> = [];
  for (const [form, reference] of REPOSITORY_REFERENCES.entries()) {
    for (const match of source.matchAll(reference)) {
      const quoted = form === 1;
      const [owner, repo] = quoted ? [match[2], match[3]] : [match[1], match[2]];
      const index = match.index ?? 0;
      if (quoted && isProtocolName(source.slice(index + 1))) continue;
      // Git ref namespaces share the slug shape but do not identify repositories.
      if (quoted && owner === "refs") continue;
      found.push({ named: `${owner}/${repo}`, index });
    }
  }
  return found;
}

const DEPRECATION_OWNER = /(?:organization\s+)?owner[\s*/#]+role\s+of\s+`([^`]+)`/gu;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function gitRepository(url: unknown, type: unknown = "git") {
  return { repository: { type, url } };
}

describe("repository identity source of truth", () => {
  it("reads owner/repo from the package.json repository field", () => {
    expect(repositoryIdentity(gitRepository("git+https://github.com/some-owner/some-repo.git"))).toEqual({
      owner: "some-owner",
      repo: "some-repo",
      slug: "some-owner/some-repo",
    });
  });

  it("does not read the update feed", () => {
    // Repository identity is independent of the release feed provider.
    expect(
      repositoryIdentity({
        ...gitRepository("git+https://github.com/some-owner/some-repo.git"),
        build: { publish: [{ provider: "generic", url: "https://downloads.example.invalid/releases" }] },
      }).slug,
    ).toBe("some-owner/some-repo");
  });

  it.each([
    ["no repository", {}],
    ["only a github publish entry", { build: { publish: [{ provider: "github", owner: "o", repo: "r" }] } }],
    ["the shorthand string form", { repository: "owner/some-repo" }],
    ["the github: shorthand form", { repository: "github:owner/some-repo" }],
    ["an array", { repository: [] }],
    ["a non-git type", gitRepository("git+https://github.com/owner/some-repo.git", "svn")],
    ["a missing url", gitRepository(undefined)],
    ["a url without git+", gitRepository("https://github.com/owner/some-repo.git")],
    ["a url without .git", gitRepository("git+https://github.com/owner/some-repo")],
    ["another host", gitRepository("git+https://gitlab.com/owner/some-repo.git")],
    ["an extra path segment", gitRepository("git+https://github.com/owner/group/some-repo.git")],
    ["an owner with a trailing hyphen", gitRepository("git+https://github.com/owner-/some-repo.git")],
    ["a dot-dot repo", gitRepository("git+https://github.com/owner/...git")],
  ])("fails closed for %s", (_label, packageJson) => {
    expect(() => repositoryIdentity(packageJson)).toThrow("[repository-identity]");
  });

  it("reads a quoted repository path but not a quoted protocol name", () => {
    expect(NOTIFICATION_NAMESPACES).toEqual(["notifications/ave/"]);
    expect(repositoryReferences(`const old = "ave-project/ave/releases/latest";`)).toEqual([
      { named: "ave-project/ave", index: 12 },
    ]);
    expect(repositoryReferences(`const slug = 'some-owner/ave';`)).toEqual([
      { named: "some-owner/ave", index: 13 },
    ]);
    expect(repositoryReferences(`method: "${HOST_PROTOCOL_NOTIFICATIONS.log}"`)).toEqual([]);
    expect(repositoryReferences("const target = `refs/ave/${localRef}`;")).toEqual([]);
    expect(repositoryReferences(`join(ROOT, "methods/ave/host/storage/read.json")`)).toEqual([]);
    // A golden-directory prefix does not exempt paths outside method fixtures.
    expect(repositoryReferences(`"methods/ave/releases"`)).toEqual([{ named: "methods/ave", index: 0 }]);
  });

  it("keeps the package homepage on the same repository", () => {
    const pkg = JSON.parse(read("package.json")) as { homepage?: string };
    expect(pkg.homepage).toBe(`https://github.com/${identity.slug}`);
  });

  it("names this repository in every reference outside the not-checked list", () => {
    const mismatches: string[] = [];
    const covered = new Set<string>();
    for (const [path, source] of checkedTexts()) {
      for (const { named, index } of repositoryReferences(source)) {
        covered.add(path);
        if (named !== identity.slug) {
          mismatches.push(`${path}:${lineOf(source, index)} names ${named}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    const missed = [
      ".github/CONTRIBUTING.md",
      ".github/workflows/ci.yml",
      ".github/workflows/web-deploy.yml",
      "package.json",
      "src/__tests__/packaging-discipline-source.test.ts",
      "web/DEPLOY.md",
    ].filter((path) => !covered.has(path));
    expect(missed).toEqual([]);
  });

  it("keeps every not-checked entry pointing at a tracked path", () => {
    const stale = NOT_CHECKED.filter(([entry]) => !trackedFiles.some((path) => matchesEntry(path, entry)))
      .map(([entry]) => entry);
    expect(stale).toEqual([]);
  });

  it("guards every web deploy job on this repository", () => {
    const jobs = workflowJobs(read(".github/workflows/web-deploy.yml"));
    expect([...jobs.keys()]).toEqual(["build", "deploy"]);
    const unguarded = [...jobs]
      .filter(([, body]) => !body.includes(`    if: github.repository == '${identity.slug}'\n`))
      .map(([id]) => id);
    expect(unguarded).toEqual([]);
  });

  it("names this repository in every workflow repository comparison", () => {
    const subject = String.raw`(github\.(?:repository_owner|repository|event\.repository\.owner\.login|event\.repository\.full_name))`;
    const literal = String.raw`(?:'([^']*)'|"([^"]*)")`;
    const forms: ReadonlyArray<[RegExp, (value: string, expected: string) => boolean]> = [
      [new RegExp(String.raw`${subject}\s*[!=]=\s*${literal}`, "gu"), (value, expected) => value === expected],
      [new RegExp(String.raw`${literal}\s*[!=]=\s*${subject}`, "gu"), (value, expected) => value === expected],
      [new RegExp(String.raw`startsWith\(\s*${subject}\s*,\s*${literal}\s*\)`, "gu"), (value, expected) => expected.startsWith(value)],
      [new RegExp(String.raw`endsWith\(\s*${subject}\s*,\s*${literal}\s*\)`, "gu"), (value, expected) => expected.endsWith(value)],
      [new RegExp(String.raw`contains\(\s*${subject}\s*,\s*${literal}\s*\)`, "gu"), (value, expected) => expected.includes(value)],
      [new RegExp(String.raw`contains\(\s*${literal}\s*,\s*${subject}\s*\)`, "gu"), (value, expected) => value.includes(expected)],
    ];
    const mismatches: string[] = [];
    let comparisons = 0;
    for (const path of trackedFiles.filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry))) {
      const source = read(path);
      for (const [pattern, holds] of forms) {
        for (const match of source.matchAll(pattern)) {
          const groups = match.slice(1).filter((group): group is string => group !== undefined);
          const field = groups.find((group) => group.startsWith("github.")) as string;
          const value = groups.find((group) => group !== field) ?? "";
          const expected = /owner/u.test(field) ? identity.owner : identity.slug;
          comparisons += 1;
          if (!holds(value, expected)) {
            mismatches.push(`${path}:${lineOf(source, match.index ?? 0)} ${match[0]}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(comparisons).toBeGreaterThanOrEqual(2);
  });

  it("names this repository's owner as the deprecation owner", () => {
    const mismatches: string[] = [];
    const sites = new Set<string>();
    for (const [path, source] of checkedTexts()) {
      for (const match of source.matchAll(DEPRECATION_OWNER)) {
        sites.add(path);
        if (match[1] !== identity.owner) {
          mismatches.push(`${path}:${lineOf(source, match.index ?? 0)} names ${match[1]}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect([...sites]).toEqual(
      expect.arrayContaining(["src/plugins/runtime/plugin-loader.ts", "docs/development/knip-baseline.md"]),
    );
  });

  it("points the packaged agent contract's gh commands at this repository's owner", () => {
    const owners = [...read("resources/AGENTS.md").matchAll(/gh -R ([^/\s`]+)\//gu)].map((match) => match[1]);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.filter((owner) => owner !== identity.owner)).toEqual([]);
  });

  it("lists the current and every release tag's resources/AGENTS.md in the replaceable-hash list", () => {
    // Seeder replacement requires exact shipped bytes; retain every shipped guidance hash.
    const listed = new Set(read("resources/AGENTS.md.replaceable-sha256").split(/\s+/u).filter(Boolean));
    const current = createHash("sha256").update(readFileSync(resolve(root, "resources/AGENTS.md"))).digest("hex");
    expect(listed.has(current), "the current resources/AGENTS.md is not in the replaceable-hash list").toBe(true);
    // Tags below the floor no longer reproduce shipped bytes; retain their fixed hash inventory.
    const tags = gitText("tag", "--list", "v*")
      .split("\n")
      .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag));
    expect(tags, "the floor tag is not in this checkout; fetch the tags").toContain(FIRST_TAG_WITH_SHIPPED_AGENTS_MD);
    const shippedTags = tags.filter((tag) => compareReleaseTags(tag, FIRST_TAG_WITH_SHIPPED_AGENTS_MD) >= 0);
    const missing: string[] = [];
    let taggedCopies = 0;
    for (const tag of shippedTags) {
      const copy = git(["cat-file", "-p", `${tag}:resources/AGENTS.md`]);
      if (copy.status !== 0) continue; // the tag predates the packaged contract
      taggedCopies += 1;
      const hash = createHash("sha256").update(copy.stdout).digest("hex");
      if (!listed.has(hash)) missing.push(`${tag} ${hash}`);
    }
    expect(missing).toEqual([]);
    expect(taggedCopies).toBeGreaterThan(0);
  });
});
