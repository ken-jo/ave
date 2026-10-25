import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs build script without declarations
import { stageMxcLauncher } from "../../scripts/fetch-mxc.mjs";

const roots: string[] = [];
function projectRoot(license: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), "fetch-mxc-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "resources", "licenses", "mxc"), { recursive: true });
  const target = path.join(root, "resources", "licenses", "mxc", "LICENSE.md");
  if (license === null) cpSync(path.resolve("resources/licenses/mxc/LICENSE.md"), target);
  else writeFileSync(target, license);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetch-mxc staging fails the Windows build instead of shipping an unverified launcher", () => {
  it("rejects a tarball whose sha512 is not the pinned integrity", async () => {
    const root = projectRoot(null);
    const tarball = path.join(root, "mxc.tgz");
    writeFileSync(tarball, "not the published tarball");
    await expect(stageMxcLauncher({ arch: "x64", tarball, projectRoot: root })).rejects.toThrow(/integrity mismatch/);
  });

  it("rejects a committed license that differs from the package's MIT text", async () => {
    const root = projectRoot("edited");
    await expect(stageMxcLauncher({ arch: "x64", tarball: path.join(root, "unused.tgz"), projectRoot: root }))
      .rejects.toThrow(/differs from the MIT license/);
  });
});
