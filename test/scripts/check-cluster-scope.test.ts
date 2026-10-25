import { describe, expect, it } from "vitest";
import {
  createGhApiRequester,
  evaluateClusterScope,
  evaluateSensitiveRollingWindow,
  isCommentOnlyPatch,
  pathsFromFileRecords,
  pullRequestHasSensitiveCommitBundle,
  pullRequestTouchesSensitiveFiles,
} from "../../scripts/check-cluster-scope.mjs";

const REPO = "owner/repo";

function sha(character: string): string {
  return character.repeat(40);
}

// Page maps may vary per scan; page 1 advances the snapshot and later scans reuse the last.
// Observe page requests separately from repeated scans to verify stopping conditions.
function rollingWindowRequestPage(
  pulls: Record<number, unknown[]> | Record<number, unknown[]>[],
  files: Record<number, unknown[]>,
  onPullsPage?: (page: number) => void,
) {
  const snapshots = Array.isArray(pulls) ? pulls : [pulls];
  let scan = -1;
  return (endpoint: string, parameters: { page?: number }) => {
    if (endpoint === "repos/owner/repo/pulls") {
      const page = parameters.page as number;
      if (page === 1) scan += 1;
      onPullsPage?.(page);
      return snapshots[Math.min(scan, snapshots.length - 1)]![page] ?? [];
    }
    const match = endpoint.match(/^repos\/owner\/repo\/pulls\/(\d+)(\/files)?$/);
    if (!match) throw new Error("unexpected-endpoint");
    const number = Number(match[1]);
    return match[2] ? files[number]! : { changed_files: files[number]!.length };
  };
}

function trackPullDetailRequests(
  base: (endpoint: string, parameters: { page?: number }) => unknown,
  detailed: number[],
) {
  return (endpoint: string, parameters: { page?: number }) => {
    const match = endpoint.match(/^repos\/owner\/repo\/pulls\/(\d+)$/);
    if (match) detailed.push(Number(match[1]));
    return base(endpoint, parameters);
  };
}

describe("cluster scope API evaluation", () => {
  it("includes previous filenames so sensitive renames remain fail-closed", () => {
    expect(
      pathsFromFileRecords([
        {
          status: "renamed",
          filename: "src/ipc/__tests__/domain.test.ts",
          previous_filename: "src/ipc/domain.ts",
        },
      ]),
    ).toEqual(["src/ipc/__tests__/domain.test.ts", "src/ipc/domain.ts"]);
  });

  it("classifies paginated mixed production and test files with one helper", () => {
    const requestPage = (_endpoint: string, parameters: { page: number }) =>
      parameters.page === 1
        ? [
            { status: "modified", filename: "src/ipc/__tests__/domain.test.ts" },
            { status: "modified", filename: "src/ui/view.tsx" },
          ]
        : [{ status: "modified", filename: "src/ipc/domain.ts" }];

    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage,
        pageSize: 2,
      }),
    ).toBe(true);
  });

  it("fails closed for incomplete and saturated file pagination", () => {
    const incomplete = () => [{ status: "modified", filename: "src/ui/view.tsx" }];
    expect(() =>
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage: incomplete,
        pageSize: 2,
      }),
    ).toThrow("pull-request-files-incomplete");

    const saturated = () => [
      { status: "modified", filename: "src/ui/one.tsx" },
      { status: "modified", filename: "src/ui/two.tsx" },
    ];
    expect(() =>
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 7,
        expectedFileCount: 3,
        requestPage: saturated,
        pageSize: 2,
        maxFiles: 2,
      }),
    ).toThrow("pull-request-files-saturated");
  });

  it("counts three mixed sensitive commits as a bundle", () => {
    const commits = [sha("1"), sha("2"), sha("3")];
    const requestPage = (endpoint: string) => {
      if (endpoint.endsWith("/commits")) {
        return commits.map((commit) => ({ sha: commit }));
      }
      return {
        files: [
          { status: "modified", filename: "src/audit/__tests__/writer.test.ts" },
          { status: "modified", filename: "src/audit/writer.ts" },
        ],
      };
    };

    expect(
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 3,
        threshold: 3,
        requestPage,
      }),
    ).toBe(true);
  });

  it("paginates the rolling window and distinguishes test-only, mixed, and rename records", () => {
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T09:00:00Z" },
      ],
      2: [
        { number: 3, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
        { number: 4, merged_at: "2026-07-12T06:00:00Z", updated_at: "2026-07-12T07:00:00Z" },
      ],
    };
    const files = {
      1: [{ status: "modified", filename: "src/ipc/__tests__/only.test.ts" }],
      2: [
        { status: "modified", filename: "src/ipc/__tests__/mixed.test.ts" },
        { status: "modified", filename: "src/ipc/domain.ts" },
      ],
      3: [
        {
          status: "renamed",
          filename: "src/ipc/__tests__/renamed.test.ts",
          previous_filename: "src/ipc/renamed.ts",
        },
      ],
      4: [{ status: "modified", filename: "src/boot/start.ts" }],
    };

    const requestPage = rollingWindowRequestPage(pulls, files);

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        requestPage,
        pageSize: 2,
      }),
    ).toEqual({ count: 3, hit: true });
  });

  it("returns a bundle violation from the integrated current-PR scope", () => {
    const commits = [sha("4"), sha("5"), sha("6")];
    const requestPage = (endpoint: string) => {
      if (endpoint.endsWith("/pulls/9/files")) {
        return [
          { status: "modified", filename: "src/sandbox/__tests__/policy.test.ts" },
          { status: "modified", filename: "src/sandbox/policy.ts" },
        ];
      }
      if (endpoint.endsWith("/pulls/9/commits")) {
        return commits.map((commit) => ({ sha: commit }));
      }
      if (endpoint.includes("/commits/")) {
        return { files: [{ status: "modified", filename: "src/core/permissions/gate.ts" }] };
      }
      throw new Error("unexpected-endpoint");
    };

    expect(
      evaluateClusterScope({
        snapshot: { number: 9, changed_files: 2, commits: 3 },
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        requestPage,
      }),
    ).toEqual({
      bundle: true,
      reason: "bundle",
      sensitive: true,
      violation: true,
      window: false,
      windowCount: 0,
    });
  });

  it("stops after the current PR is proven non-sensitive", () => {
    let calls = 0;
    const result = evaluateClusterScope({
      snapshot: { number: 10, changed_files: 1, commits: 1 },
      repo: REPO,
      since: "2026-07-01T00:00:00Z",
      threshold: 3,
      requestPage: () => {
        calls += 1;
        return [{ status: "modified", filename: "src/ui/view.tsx" }];
      },
    });
    expect(result).toEqual({
      bundle: false,
      reason: "",
      sensitive: false,
      violation: false,
      window: false,
      windowCount: 0,
    });
    expect(calls).toBe(1);
  });
  it("rejects missing, unknown, or incomplete rename status metadata", () => {
    expect(() =>
      pathsFromFileRecords([
        {
          filename: "src/ipc/__tests__/renamed.test.ts",
          status: "renamed",
        },
      ]),
    ).toThrow("github-previous-filename-required");
    expect(() =>
      pathsFromFileRecords([{ filename: "src/ui/view.tsx" }]),
    ).toThrow("github-file-record-invalid");
    expect(() =>
      pathsFromFileRecords([
        { filename: "src/ui/view.tsx", status: "unexpected" },
      ]),
    ).toThrow("github-file-record-invalid");
  });

  it("rejects a saturated page budget and accepts an out-of-order page", () => {
    const pull = (number: number, updatedAt: string) => ({
      merged_at: "2026-07-12T00:00:00Z",
      number,
      updated_at: updatedAt,
    });

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        pageSize: 2,
        maxPullPages: 1,
        requestPage: () => [
          pull(1, "2026-07-12T04:00:00Z"),
          pull(2, "2026-07-12T03:00:00Z"),
        ],
      }),
    ).toThrow("pull-request-pages-saturated");

    // Mutable timestamps may reorder entries; completeness still requires both pulls.
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 3,
        pageSize: 2,
        requestPage: rollingWindowRequestPage(
          {
            1: [pull(1, "2026-07-12T03:00:00Z"), pull(2, "2026-07-12T04:00:00Z")],
          },
          { 1: sensitive, 2: sensitive },
        ),
      }),
    ).toEqual({ count: 2, hit: false });
  });

  it("fails closed for incomplete, overflowed, and saturated commit pagination", () => {
    const first = sha("7");
    const second = sha("8");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 1,
        requestPage: () => [],
      }),
    ).toThrow("pull-request-commits-incomplete");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 2,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }, { sha: second }]
            : { files: [] },
      }),
    ).toThrow("pull-request-commits-overflow");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 3,
        threshold: 3,
        pageSize: 2,
        maxCommits: 2,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }, { sha: second }]
            : { files: [] },
      }),
    ).toThrow("pull-request-commits-saturated");

    expect(() =>
      pullRequestHasSensitiveCommitBundle({
        repo: REPO,
        number: 7,
        expectedCommitCount: 1,
        threshold: 1,
        pageSize: 1,
        maxFiles: 1,
        requestPage: (endpoint: string) =>
          endpoint.endsWith("/commits")
            ? [{ sha: first }]
            : {
                files: [
                  { filename: "src/ui/view.tsx", status: "modified" },
                ],
              },
      }),
    ).toThrow("commit-files-saturated");
  });

  it("builds gh API requests without a shell and rejects command or JSON failures", () => {
    let captured:
      | { command: string; args: string[]; options: { maxBuffer: number } }
      | undefined;
    const request = createGhApiRequester((command, args, options) => {
      captured = { command, args, options };
      return { status: 0, stdout: "[]" };
    });
    expect(request("repos/owner/repo/pulls", { page: 2, per_page: 100 })).toEqual([]);
    expect(captured?.command).toBe("gh");
    expect(captured?.args).toEqual([
      "api",
      "--method",
      "GET",
      "repos/owner/repo/pulls",
      "-f",
      "page=2",
      "-f",
      "per_page=100",
    ]);
    expect(captured?.options.maxBuffer).toBe(10 * 1024 * 1024);

    expect(() =>
      createGhApiRequester(() => ({ status: 1, stdout: "" }))("endpoint", {}),
    ).toThrow("github-api-request-failed");
    expect(() =>
      createGhApiRequester(() => ({ status: 0, stdout: "not-json" }))(
        "endpoint",
        {},
      ),
    ).toThrow("github-api-response-invalid");
  });
});

describe("comment-only exclusion from sensitive-cluster detection", () => {
  const COMMENT_PATCH =
    "@@ -1,2 +1,2 @@\n-  // old comment\n+  // new comment\n   const x = 1;\n";
  const JSDOC_PATCH = "@@ -1 +1 @@\n-   * old jsdoc\n+   * new jsdoc\n";
  const CODE_PATCH = "@@ -1 +1 @@\n-  const x = 1;\n+  const x = 2;\n";

  it("recognizes comment/JSDoc/blank-only patches and rejects code or missing patches", () => {
    expect(isCommentOnlyPatch(COMMENT_PATCH)).toBe(true);
    expect(isCommentOnlyPatch(JSDOC_PATCH)).toBe(true);
    expect(isCommentOnlyPatch("@@ -1 +1 @@\n-\n+\n+  // added\n")).toBe(true);
    expect(isCommentOnlyPatch(CODE_PATCH)).toBe(false);
    expect(
      isCommentOnlyPatch("@@ -1 +1 @@\n+  const x = 1; // trailing comment\n"),
    ).toBe(false);
    expect(isCommentOnlyPatch(undefined)).toBe(false);
    expect(isCommentOnlyPatch("")).toBe(false);
  });

  it("does NOT flag a sensitive file whose change is comment-only", () => {
    const requestPage = () => [
      { status: "modified", filename: "src/boot/steps/x.ts", patch: COMMENT_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage,
      }),
    ).toBe(false);
  });

  it("still flags a real code change, and a sensitive file with no patch (conservative)", () => {
    const codeChange = () => [
      { status: "modified", filename: "src/boot/steps/x.ts", patch: CODE_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage: codeChange,
      }),
    ).toBe(true);

    const noPatch = () => [
      { status: "modified", filename: "src/permissions/x.ts" },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 1,
        requestPage: noPatch,
      }),
    ).toBe(true);
  });

  it("flags when a comment-only sensitive file is mixed with a code-change sensitive file", () => {
    const requestPage = () => [
      { status: "modified", filename: "src/boot/a.ts", patch: COMMENT_PATCH },
      { status: "modified", filename: "src/permissions/b.ts", patch: CODE_PATCH },
    ];
    expect(
      pullRequestTouchesSensitiveFiles({
        repo: REPO,
        number: 1,
        expectedFileCount: 2,
        requestPage,
      }),
    ).toBe(true);
  });

  it("still finds every in-window pull when a page arrives out of order", () => {
    // Page-boundary movement must preserve completeness without duplicate counts.
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T05:00:00Z", updated_at: "2026-07-12T06:00:00Z" },
      ],
      2: [
        { number: 3, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T11:00:00Z" },
        { number: 4, merged_at: "2026-07-12T04:00:00Z", updated_at: "2026-07-12T05:00:00Z" },
      ],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive, 3: sensitive, 4: sensitive };

    const requestPage = rollingWindowRequestPage(pulls, files);

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 4,
        requestPage,
        pageSize: 2,
      }),
    ).toEqual({ count: 4, hit: true });
  });

  it("stops on the page's OLDEST entry, not on its last one", () => {
    // Stopping at the oldest timestamp can hide a later page, even after rescanning.
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T01:00:00Z" },
        { number: 3, merged_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T09:00:00Z" },
      ],
      2: [{ number: 4, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" }],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive, 3: sensitive, 4: sensitive };
    // Assert page numbers rather than request counts because evaluation repeats scans.
    const requestedPages = new Set<number>();
    const detailed: number[] = [];

    const requestPage = trackPullDetailRequests(
      rollingWindowRequestPage(pulls, files, (page) => requestedPages.add(page)),
      detailed,
    );

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 99,
        requestPage,
        pageSize: 3,
      }),
    ).toEqual({ count: 2, hit: false });

    expect([...requestedPages]).toEqual([1]);
    // The missed pull leaves two results where completeness requires three.
    expect(detailed).toEqual([1, 3]);
  });

  it("counts a pull once when a page shift makes it arrive twice", () => {
    // Deduplicate mutable page overlap without changing the window stop condition.
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
      ],
      2: [
        { number: 2, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
        { number: 3, merged_at: "2026-07-12T05:00:00Z", updated_at: "2026-07-12T06:00:00Z" },
      ],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive, 3: sensitive };

    // Three distinct pulls, not four sightings.
    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: "2026-07-01T00:00:00Z",
        threshold: 99,
        requestPage: rollingWindowRequestPage(pulls, files),
        pageSize: 2,
      }),
    ).toEqual({ count: 3, hit: false });
  });

  it("still terminates when every entry on a page is a repeat", () => {
    const pulls = {
      1: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        { number: 2, merged_at: "2026-07-12T07:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
      ],
      2: [
        { number: 1, merged_at: "2026-07-12T09:00:00Z", updated_at: "2026-07-12T10:00:00Z" },
        // Update the minimum before deduplication so an all-repeat page can terminate.
        { number: 2, merged_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T01:00:00Z" },
      ],
    };
    const sensitive = [{ status: "modified", filename: "src/boot/start.ts" }];
    const files = { 1: sensitive, 2: sensitive };
    const requestedPages = new Set<number>();

    evaluateSensitiveRollingWindow({
      repo: REPO,
      since: "2026-07-01T00:00:00Z",
      threshold: 99,
      requestPage: rollingWindowRequestPage(pulls, files, (page) =>
        requestedPages.add(page),
      ),
      pageSize: 2,
    });

    expect([...requestedPages]).toEqual([1, 2]);
  });
});

describe("rolling-window revalidation under concurrent merge", () => {
  const SINCE = "2026-07-01T00:00:00Z";
  const SENSITIVE = [{ status: "modified", filename: "src/boot/start.ts" }];
  const BENIGN = [{ status: "modified", filename: "src/ui/view.tsx" }];

  const merged = (number: number, updatedAt = "2026-07-12T10:00:00Z") => ({
    merged_at: "2026-07-12T09:00:00Z",
    number,
    updated_at: updatedAt,
  });

  // Verify fetched pull identity as well as aggregate counts.
  it("evaluates a pull that merged between the scans instead of failing the run", () => {
    // Include a pull merged during evaluation.
    const detailed: number[] = [];
    const requestPage = trackPullDetailRequests(
      rollingWindowRequestPage(
        [{ 1: [merged(1)] }, { 1: [merged(2), merged(1)] }],
        { 1: BENIGN, 2: SENSITIVE },
      ),
      detailed,
    );

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 3,
        requestPage,
        pageSize: 5,
      }),
    ).toEqual({ count: 1, hit: false });
    expect(detailed).toEqual([1, 2]);
  });

  it("counts a pull the first scan never delivered, to the point of changing the verdict", () => {
    // A second scan must recover entries missed after their sort key moves upward.
    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 2,
        requestPage: rollingWindowRequestPage(
          [{ 1: [merged(1)] }, { 1: [merged(2), merged(1)] }],
          { 1: SENSITIVE, 2: SENSITIVE },
        ),
        pageSize: 5,
      }),
    ).toEqual({ count: 2, hit: true });
  });

  it("treats an advanced updated_at and a reordered page as the same window", () => {
    // Stable membership may have different timestamps and ordering.
    const detailed: number[] = [];
    const requestPage = trackPullDetailRequests(
      rollingWindowRequestPage(
        [
          { 1: [merged(1, "2026-07-12T10:00:00Z"), merged(2, "2026-07-12T09:00:00Z")] },
          { 1: [merged(2, "2026-07-12T11:00:00Z"), merged(1, "2026-07-12T10:00:00Z")] },
        ],
        { 1: SENSITIVE, 2: BENIGN },
      ),
      detailed,
    );

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 3,
        requestPage,
        pageSize: 5,
      }),
    ).toEqual({ count: 1, hit: false });
    // Deduplicate pull numbers before fetching files.
    expect(detailed).toEqual([1, 2]);
  });

  it("keeps the verdict of a pull the rescan no longer delivers", () => {
    // A later snapshot hole must not discard earlier results.
    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 3,
        requestPage: rollingWindowRequestPage(
          [{ 1: [merged(1), merged(2)] }, { 1: [merged(2)] }],
          { 1: SENSITIVE, 2: SENSITIVE },
        ),
        pageSize: 5,
      }),
    ).toEqual({ count: 2, hit: false });
  });

  it("settles within the pass budget, and fails loudly when it cannot", () => {
    // Each snapshot introduces a pull until membership settles.
    const growing = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        1: Array.from({ length: index + 1 }, (_entry, offset) =>
          merged(index + 1 - offset),
        ),
      }));
    const files = { 1: BENIGN, 2: BENIGN, 3: BENIGN, 4: BENIGN };

    expect(
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 99,
        requestPage: rollingWindowRequestPage(growing(3), files),
        pageSize: 5,
      }),
    ).toEqual({ count: 0, hit: false });

    // Fail when membership still moves at the scan budget.
    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 99,
        requestPage: rollingWindowRequestPage(growing(4), files),
        pageSize: 5,
      }),
    ).toThrow("pull-request-window-unsettled");

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 99,
        maxWindowPasses: 2,
        requestPage: rollingWindowRequestPage(growing(3), files),
        pageSize: 5,
      }),
    ).toThrow("pull-request-window-unsettled");

    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 99,
        maxWindowPasses: 0,
        requestPage: () => [],
      }),
    ).toThrow("window-pass-limit-invalid");

    // A scan budget below the minimum must be rejected before any request.
    expect(() =>
      evaluateSensitiveRollingWindow({
        repo: REPO,
        since: SINCE,
        threshold: 99,
        maxWindowPasses: 1,
        requestPage: () => [],
      }),
    ).toThrow("window-pass-limit-invalid");
  });
});
