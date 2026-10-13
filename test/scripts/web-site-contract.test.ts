import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The website's public contract with everything that links to it: schema `$id`s,
 * the issue template, and release notes name `https://former-site.invalid/...` URLs that
 * must keep resolving through any redesign, and every Ave user must be told
 * that 0.14.0 (Ave) is a fresh install.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "web");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Tracked files whose links to the site are published and cannot be edited after the fact. */
const LINKING_SOURCES = ["schemas/", "web/public/", ".github/ISSUE_TEMPLATE/", ".github/release-bodies/"];

function trackedLinkingFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...LINKING_SOURCES], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/** True when the static export serves `path`: a public file, or an app route's page. */
function servedBySite(path: string): boolean {
  const clean = path.replace(/[#?].*$/u, "").replace(/\/+$/u, "");
  if (clean === "" || clean === "en") return true;
  const asset = join(web, "public", clean);
  if (existsSync(asset) && statSync(asset).isFile()) return true;
  // Metadata routes (sitemap.xml ← app/sitemap.ts) and page routes.
  if (/^[a-z-]+\.xml$/u.test(clean) && existsSync(join(web, "app", clean.replace(/\.xml$/u, ".ts")))) return true;
  return existsSync(join(web, "app", clean, "page.tsx"));
}

describe("website public URLs", () => {
  it("serves every former-site.invalid URL that schemas, public files, and templates publish", () => {
    const urls = new Map<string, string>();
    for (const file of trackedLinkingFiles()) {
      for (const match of read(file).matchAll(/https:\/\/ave\.xyz\/([A-Za-z0-9_./#-]*)/gu)) {
        urls.set(match[1] as string, file);
      }
    }
    expect(urls.size).toBeGreaterThan(0);
    const missing = [...urls].filter(([path]) => !servedBySite(path)).map(([path, file]) => `${file}: /${path}`);
    expect(missing).toEqual([]);
  });

  it("keeps the published protocol schemas in web/public", () => {
    const mirror = JSON.parse(read("web/public/schemas/plugin-host-protocol/mirror.json")) as unknown;
    expect(mirror).toBeTruthy();
    expect(existsSync(join(web, "public/.well-known/former-service.json"))).toBe(true);
    expect(existsSync(join(web, "public/announcements/v1.json"))).toBe(true);
  });

  it("publishes the service document under both the Ave and the legacy Ave name", () => {
    // Ave fetches ave-service.json; installed Ave apps still fetch former-service.json.
    const ave = JSON.parse(read("web/public/.well-known/ave-service.json")) as unknown;
    const ave = JSON.parse(read("web/public/.well-known/former-service.json")) as unknown;
    expect(ave).toEqual(ave);
    const headers = read("web/public/_headers");
    expect(headers).toContain("/.well-known/ave-service.json");
    expect(headers).toContain("/.well-known/former-service.json");
  });

  it("copies both service documents into the static export when it is built", () => {
    const out = join(web, "out/.well-known");
    if (!existsSync(out)) return expect(existsSync(join(web, "out"))).toBe(false);
    const built = (name: string) => JSON.parse(readFileSync(join(out, name), "utf8")) as unknown;
    expect(built("ave-service.json")).toEqual(built("former-service.json"));
  });
});

describe("Ave to Ave reinstall notice", () => {
  it("states the fresh-install rule in both locales", () => {
    const source = read("web/lib/reinstall.ts");
    expect(source).toMatch(/0\.14\.0은 새로 설치해야 합니다/u);
    expect(source).toMatch(/새 앱 ID와 새 데이터 폴더/u);
    expect(source).toMatch(/자동으로 옮겨지지 않습니다/u);
    expect(source).toMatch(/자동 업데이트되지 않습니다/u);
    expect(source).toMatch(/0\.14\.0 is a fresh install/u);
    expect(source).toMatch(/new app ID and a new data folder/u);
    expect(source).toMatch(/not migrated automatically/u);
    expect(source).toMatch(/will not auto-update to 0\.14\.0/u);
  });

  it("shows it on the landing download section and the install and update docs", () => {
    expect(read("web/components/landing/downloads.tsx")).toContain("reinstallNotice(locale)");
    expect(read("web/components/landing/downloads.tsx")).toContain('id="reinstall"');
    for (const [path, locale] of [
      ["web/app/docs/getting-started/install/page.tsx", "ko"],
      ["web/app/docs/getting-started/updates/page.tsx", "ko"],
      ["web/app/en/docs/getting-started/install/page.tsx", "en"],
      ["web/app/en/docs/getting-started/updates/page.tsx", "en"],
    ] as const) {
      expect(read(path), path).toContain(`<ReinstallCallout locale="${locale}" />`);
    }
  });

  it("brands the install commands as Ave", () => {
    const downloads = read("web/lib/downloads.ts");
    expect(downloads).toContain('"/Applications/Ave.app"');
    expect(downloads).toContain("Ave-*-linux-x86_64.AppImage");
    expect(downloads).not.toMatch(/RETIREDNAME\.app|RETIREDNAME-\*/u);
  });
});
