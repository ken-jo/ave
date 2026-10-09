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

/**
 * `package.json` `build.publish` names this repository once; it is what
 * installed apps update from. What this file holds to that entry, exactly:
 *
 * - every `<owner>/<repo>` reference to this repository, in the URL, API-path,
 *   `gh -R`/`--repo`, `repository:` and quoted-string forms, in every tracked
 *   text file that is not prose documentation, plus the documents in the
 *   consumed inventory (`scripts/hooks/documentation-references.json`),
 *   except the paths in {@link NOT_CHECKED};
 * - every `github.repository`-style comparison in `.github/workflows/`, and the
 *   guard on both `web-deploy.yml` jobs;
 * - the deprecation-owner text ("organization owner role of `<owner>`");
 * - the `gh -R <owner>/` owner in the packaged `resources/AGENTS.md`;
 * - the replaceable-hash list for the seeded `resources/AGENTS.md`, which must
 *   carry every release tag's copy (editing that file for a move needs it).
 *
 * Changing the owner or name therefore fails here, with every disagreeing site
 * listed, until each one agrees.
 *
 * Prose documentation outside the consumed inventory is not read. A
 * documentation-only change skips this suite in CI, so the suite may depend
 * only on documents whose edits run it, and the document-consumer guard
 * enforces that. A document that must agree is added to the inventory, as
 * `docs/ko/guides/windows-setup.md` and `docs/development/knip-baseline.md` are.
 */

const root = process.cwd();
const identity = readRepositoryIdentity(root);

/** Tracked paths this file does not check, each with its reason. A prefix ends
 *  in `/`. Every entry must still match a tracked path, so the list cannot
 *  silently outlive what it names. */
const NOT_CHECKED: ReadonlyArray<readonly [string, string]> = [
  ["CHANGELOG.md", "release history"],
  ["docs/architecture/", "historical design records, including consumed ones"],
  ["docs/blueprints/", "historical design records"],
  ["docs/design/", "historical design records"],
  ["docs/ko/design/", "historical design records"],
  ["src/permissions/__tests__/permission-review-scenario-board.test.ts", "URL-classification input"],
  ["src/permissions/__tests__/verdict-cache.test.ts", "URL-classification input"],
  ["src/tools/__tests__/executor.test.ts", "URL-classification input"],
  ["test/scripts/check-release-repository.test.ts", "the release gate's mismatch fixtures"],
  ["test/scripts/repository-identity.test.ts", "this file's own fixtures"],
];

function matchesEntry(path: string, entry: string): boolean {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function notChecked(path: string): boolean {
  // isDocumentationPath is false for consumed documents, so those are read.
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

/** `<owner>/<repo>` in the forms that name a GitHub repository. The name is
 *  this repository's, or `ave` so that a rename still catches the old. */
const REPOSITORY_REFERENCE = new RegExp(
  String.raw`(?:github\.com[/:]|repos/|-R\s+|--repo[ =]|repository:\s*["']?|["'\x60])` +
    String.raw`([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/(` +
    [...new Set([identity.repo, "ave"])].map(escapeRegExp).join("|") +
    String.raw`)(?:\.git)?(?![\w.-])`,
  "gu",
);

const DEPRECATION_OWNER = /organization\s+owner[\s*/#]+role\s+of\s+`([^`]+)`/gu;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function githubPublish(owner: unknown, repo: unknown) {
  return { build: { publish: [{ provider: "github", owner, repo }] } };
}

describe("repository identity source of truth", () => {
  it("reads owner/repo from the one github publish entry", () => {
    expect(repositoryIdentity(githubPublish("some-owner", "ave"))).toEqual({
      owner: "some-owner",
      repo: "ave",
      slug: "some-owner/ave",
    });
  });

  it.each([
    ["no build", {}],
    ["publish as an object", { build: { publish: { provider: "github", owner: "o", repo: "r" } } }],
    ["no publish entry", { build: { publish: [] } }],
    [
      "a second feed",
      {
        build: {
          publish: [
            { provider: "github", owner: "o", repo: "r" },
            { provider: "github", owner: "p", repo: "r" },
          ],
        },
      },
    ],
    ["a non-github provider", { build: { publish: [{ provider: "generic", url: "https://example.invalid" }] } }],
    ["a missing owner", githubPublish(undefined, "ave")],
    ["an owner with a slash", githubPublish("a/b", "ave")],
    ["an owner with a trailing hyphen", githubPublish("owner-", "ave")],
    ["an empty repo", githubPublish("owner", "")],
    ["a dot-dot repo", githubPublish("owner", "..")],
  ])("fails closed for %s", (_label, packageJson) => {
    expect(() => repositoryIdentity(packageJson)).toThrow("[repository-identity]");
  });

  it("keeps the package homepage on the same repository", () => {
    const pkg = JSON.parse(read("package.json")) as { homepage?: string };
    expect(pkg.homepage).toBe(`https://github.com/${identity.slug}`);
  });

  it("names this repository in every reference outside the not-checked list", () => {
    const mismatches: string[] = [];
    const covered = new Set<string>();
    for (const [path, source] of checkedTexts()) {
      for (const match of source.matchAll(REPOSITORY_REFERENCE)) {
        covered.add(path);
        const named = `${match[1]}/${match[2]}`;
        if (named !== identity.slug) {
          mismatches.push(`${path}:${lineOf(source, match.index ?? 0)} names ${named}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    // The live sites a move must change are among the references read.
    const missed = [
      ".github/CONTRIBUTING.md",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/SECURITY.md",
      ".github/workflows/ci.yml",
      ".github/workflows/web-ci.yml",
      ".github/workflows/web-deploy.yml",
      "docs/ko/guides/windows-setup.md",
      "package.json",
      "src/__tests__/packaging-discipline-source.test.ts",
      "web/DEPLOY.md",
      "web/README.md",
      "web/lib/downloads.ts",
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
    // Each form: its pattern, then whether it holds for the expected value.
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

  it("links the website's downloads to this repository's releases", () => {
    expect(read("web/lib/downloads.ts")).toContain(`"https://github.com/${identity.slug}/releases"`);
  });

  it("points the packaged agent contract's gh commands at this repository's owner", () => {
    const owners = [...read("resources/AGENTS.md").matchAll(/gh -R ([^/\s`]+)\//gu)].map((match) => match[1]);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.filter((owner) => owner !== identity.owner)).toEqual([]);
  });

  it("lists every release tag's resources/AGENTS.md in the replaceable-hash list", () => {
    // The seeder replaces a user's copy in place only when its bytes are a
    // shipped version, so an edit to resources/AGENTS.md (as a move needs)
    // must keep every tagged copy listed. CI checks out full history and tags.
    const tags = gitText("tag", "--list", "v*")
      .split("\n")
      .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag));
    expect(tags.length, "no release tags in this checkout; fetch the tags").toBeGreaterThan(0);
    const listed = new Set(read("resources/AGENTS.md.replaceable-sha256").split(/\s+/u).filter(Boolean));
    const missing: string[] = [];
    let taggedCopies = 0;
    for (const tag of tags) {
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
