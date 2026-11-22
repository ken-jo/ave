import { spawnSync } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UV_TARGETS } from "../uv-targets.mjs";

/**
 * @param {{
 *   loadArchive: (target: (typeof UV_TARGETS)[number]) => Promise<Buffer>,
 *   run?: (file: string, args: string[], options: { stdio: "inherit", windowsHide: boolean }) =>
 *     { status: number | null, signal?: NodeJS.Signals | null, error?: NodeJS.ErrnoException }
 * }} options
 */
export async function verifyPinnedAttestations({ loadArchive, run = spawnSync }) {
  const directory = await mkdtemp(join(tmpdir(), "uv-attestation-"));
  try {
    for (const target of UV_TARGETS) {
      const archive = join(directory, target.archive);
      try {
        await writeFile(archive, await loadArchive(target));
        const { status, signal, error } = run("gh", ["attestation", "verify", archive, "--repo", "astral-sh/uv"], {
          stdio: "inherit",
          windowsHide: true,
        });
        if (error?.code === "ENOENT") throw new Error("gh CLI is required to verify archive attestations", { cause: error });
        if (error) throw new Error(`Could not start attestation verification for ${target.archive}`, { cause: error });
        if (status !== 0) {
          throw new Error(`Attestation verification failed for ${target.archive} (${signal ?? `exit ${status}`})`);
        }
      } finally {
        await rm(archive, { force: true });
      }
    }
  } finally {
    await rmdir(directory);
  }
}
