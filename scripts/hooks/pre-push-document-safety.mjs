import { spawnSync } from "node:child_process";
import { withoutGitContext } from "../lib/git-process-environment.mjs";

const MERGE_MARKERS = /^(<<<<<<< |=======|>>>>>>> )/m;

export function checkPushedDocumentation(repoRoot, entries) {
  const env = withoutGitContext();
  const ranges = new Set(entries.map(({ baseSha, localSha }) => `${baseSha}..${localSha}`));
  for (const range of ranges) {
    const result = spawnSync("git", ["-C", repoRoot, "diff", "--check", range], { encoding: "utf8", env });
    if (result.error || result.status !== 0) {
      throw new Error(`[document-safety] pushed diff failed: ${result.stderr?.trim() || range}`);
    }
  }
  for (const { path, localSha } of entries) {
    const result = spawnSync("git", ["-C", repoRoot, "show", `${localSha}:${path}`], {
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`[document-safety] cannot read pushed document ${path}`);
    }
    let content;
    try {
      content = new TextDecoder("utf8", { fatal: true }).decode(result.stdout);
    } catch {
      throw new Error(`[document-safety] pushed document is not UTF-8: ${path}`);
    }
    if (MERGE_MARKERS.test(content)) {
      throw new Error(`[document-safety] merge marker in pushed document ${path}`);
    }
  }
}
