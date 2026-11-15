import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { BUNDLED_RENDERER_NOTICES, assertBundledRendererNotices } = require("../../scripts/lib/bundled-renderer-notices.cjs") as {
  BUNDLED_RENDERER_NOTICES: readonly { packageName: string; noticeFile: string; sha256: string }[];
  assertBundledRendererNotices: (resources: string) => void;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function packagedNotices() {
  const root = mkdtempSync(join(tmpdir(), "renderer-notices-"));
  roots.push(root);
  const resources = join(root, "resources");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const entry = manifest.build.extraResources.find((row: { to: string }) => row.to === "licenses/renderer");
  if (!entry) throw new Error("Notice resource copy missing");
  mkdirSync(resources);
  cpSync(resolve(entry.from), join(resources, entry.to), { recursive: true });
  return resources;
}

describe("bundled renderer notices", () => {
  it("retains each installed package's complete original notice on the shipped resource path", () => {
    const resources = packagedNotices();
    expect(() => assertBundledRendererNotices(resources)).not.toThrow();
    for (const { packageName, noticeFile } of BUNDLED_RENDERER_NOTICES) {
      expect(readFileSync(join(resources, "licenses", "renderer", noticeFile))).toEqual(readFileSync(join("node_modules", packageName, "LICENSE")));
    }
  });
  it.each(BUNDLED_RENDERER_NOTICES)("refuses a missing $packageName notice", ({ noticeFile }) => {
    const resources = packagedNotices();
    rmSync(join(resources, "licenses", "renderer", noticeFile));
    expect(() => assertBundledRendererNotices(resources)).toThrow("notice missing");
  });
  it("refuses an empty notice", () => {
    const resources = packagedNotices();
    writeFileSync(join(resources, "licenses", "renderer", "dnd-kit-core-LICENSE"), "");
    expect(() => assertBundledRendererNotices(resources)).toThrow("notice mismatch");
  });
});
