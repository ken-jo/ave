import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const BUNDLED_RENDERER_NOTICES = require("../../scripts/lib/bundled-renderer-notices.json") as readonly { packageName: string; version?: string; source?: string; noticeFile: string; sha256: string }[];
const { assertBundledRendererNotices } = require("../../scripts/lib/bundled-renderer-notices.cjs") as {
  assertBundledRendererNotices: (resources: string) => void;
};
const normalize = (bytes: Buffer) => bytes.toString().replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n';
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
    for (const { packageName, noticeFile, source, version } of BUNDLED_RENDERER_NOTICES) {
      if (version) expect(JSON.parse(readFileSync(join("node_modules", packageName, "package.json"), "utf8")).version).toBe(version);
      expect(normalize(readFileSync(join(resources, "licenses", "renderer", noticeFile)))).toEqual(normalize(source === "seedrandom.js" ? Buffer.from(readFileSync(join("node_modules", packageName, source), "utf8").split("*/")[0] + "*/\n") : readFileSync(join("node_modules", packageName, source ?? "LICENSE"))));
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
