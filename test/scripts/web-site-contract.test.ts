import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The website's public contract. The app and the repository link to a few
 * URLs on the site, and installed apps fetch machine-readable files from it;
 * those must keep working whatever the site looks like. The checks read the
 * source tree, so they run without a build.
 */

const root = process.cwd();
const web = resolve(root, "web");
const pub = resolve(web, "public");
const read = (path: string) => readFileSync(path, "utf8");
const SITE = "https://ave.agent-connector.ai";
/** The Worker config that serves the static export. */
const workerConfig = () => JSON.parse(read(resolve(web, "wrangler.jsonc")).replace(/^\s*\/\/.*$/gmu, "")) as {
  name: string;
  assets: { directory: string };
  routes: { pattern: string; custom_domain: boolean }[];
};

// The site's sources are read as text: they belong to the web package, not to
// the app's TypeScript program.
const downloadsSource = read(resolve(web, "lib/downloads.ts"));
const docsSource = read(resolve(web, "lib/docs.ts"));
const DOC_SLUGS = JSON.parse(
  /export const DOC_SLUGS = (\[[^\]]*\]) as const;/u.exec(docsSource)?.[1] ?? "[]",
) as string[];

describe("released plugin guidance", () => {
  it("keeps protocol 3 current and labels protocol 4 unreleased in both locales", () => {
    const plugins = [...docsSource.matchAll(/^  plugins: \{[\s\S]*?^  \},?$/gmu)].map(match => match[0]);
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toContain("현재 출시된 앱용 플러그인은 호스트 프로토콜 3과 최소 앱 버전 0.14.0");
    expect(plugins[0]).toContain("프로토콜 4는 아직 출시 전");
    expect(plugins[1]).toContain("released hosts currently declare host protocol 3 and minimum app version 0.14.0");
    expect(plugins[1]).toContain("Protocol 4 is upcoming and unreleased");
  });
});

describe("responsive app copy", () => {
  it("describes the same width-driven window in both guide locales, and no retired mode names on the home and feature pages", () => {
    // The home page no longer describes the tiles; the workbench guide does, in both languages.
    const home = read(resolve(web, "lib/home.ts"));
    const workbench = [...docsSource.matchAll(/^  workbench: \{[\s\S]*?^  \},?$/gmu)].map((match) => match[0]);
    expect(workbench).toHaveLength(2);
    expect(workbench[0]).toMatch(/넓은 캔버스/u);
    expect(workbench[1]).toMatch(/wide canvas/u);
    for (const source of [home, read(resolve(web, "lib/features.ts"))]) {
      expect(source).not.toMatch(/\b(?:work|chat)[ -]mode\b|(?:업무|채팅|작업)\s*모드/iu);
    }
    // The app is one responsive shell (#255): no page or built fragment may
    // name the retired modes or draw the Chat | Work switch.
    const components = readdirSync(resolve(web, "components")).filter((name) => name.endsWith(".tsx"));
    expect(components.length).toBeGreaterThan(0);
    for (const name of components) {
      const source = read(resolve(web, "components", name));
      expect(source, name).not.toMatch(/\b(?:work|chat)[ -]mode\b|(?:업무|채팅|작업)\s*모드|\bis-work\b|data-mode=/iu);
      expect(source, name).not.toMatch(/>\s*Chat\s*<[\s\S]{0,200}>\s*Work\s*</u);
    }
  });
});

/** Every route the static export produces, as slashed URL paths. */
function sitePaths(): Set<string> {
  const paths = new Set<string>();
  const groups: [string, string][] = [
    [resolve(web, "app/(ko)"), ""],
    [resolve(web, "app/(en)/en"), "/en"],
  ];
  for (const [dir, prefix] of groups) {
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === "page.tsx") {
          const rel = relative(dir, at).split("\\").join("/");
          const route = `${prefix}/${rel ? `${rel}/` : ""}`;
          if (route.includes("[slug]")) {
            for (const slug of DOC_SLUGS) paths.add(route.replace("[slug]", slug));
          } else {
            paths.add(route);
          }
        }
      }
    };
    walk(dir);
  }
  return paths;
}

describe("machine-readable files the app fetches", () => {
  it("serves the service descriptor the app requests", () => {
    const client = read(resolve(root, "src/marketplace/service/client.ts"));
    expect(client).toContain(`AVE_SERVICE_BASE_URL = "${SITE}"`);
    const documentPath = /const DOCUMENT_PATH = "([^"]+)"/u.exec(client)?.[1];
    expect(documentPath).toBe("/.well-known/ave-service.json");

    const current = readFileSync(join(pub, documentPath as string));
    // Ave is a new app: the site carries no other descriptor and names no move.
    expect(readdirSync(join(pub, ".well-known"))).toEqual(["ave-service.json"]);

    const descriptor = JSON.parse(current.toString("utf8")) as {
      schemaVersion: number; announcements: string; movedTo: unknown; movedFrom: unknown;
    };
    expect(descriptor.schemaVersion).toBe(1);
    expect(descriptor.movedTo).toBeNull();
    expect(descriptor.movedFrom).toBeNull();
    expect(existsSync(join(pub, descriptor.announcements))).toBe(true);
    expect(JSON.parse(read(join(pub, descriptor.announcements)))).toHaveProperty("announcements");
  });

  it("sends JSON headers with a short cache for every file the app reads", () => {
    const headers = read(join(pub, "_headers"));
    for (const path of ["/.well-known/ave-service.json", "/announcements/*"]) {
      const block = headers.split(/\n\s*\n/u).find((b) => b.split("\n").some((line) => line.trim() === path));
      expect(block, path).toBeDefined();
      expect(block).toContain("Content-Type: application/json; charset=utf-8");
      expect(block).toContain("Cache-Control: public, max-age=300");
    }
  });

  it("keeps the plugin host protocol schema mirror in the public tree", () => {
    const manifest = JSON.parse(read(join(pub, "schemas/plugin-host-protocol/mirror.json"))) as {
      copies: { protocol: string; appVersion: string }[];
    };
    expect(manifest.copies.length).toBeGreaterThan(0);
    for (const copy of manifest.copies) {
      expect(existsSync(join(pub, `schemas/plugin-host-protocol/${copy.protocol}/v${copy.appVersion}/protocol.schema.json`))).toBe(true);
    }
    // Only recorded protocols are published: the host serves no other wire.
    const published = readdirSync(join(pub, "schemas/plugin-host-protocol")).filter((name) => name !== "mirror.json").sort();
    expect(published).toEqual([...new Set(manifest.copies.map((copy) => copy.protocol))].sort());
  });

  it("serves every published schema at its $id under the schema identity origin", () => {
    const schemaOrigin = /^const AVE_SCHEMA_ORIGIN = "([^"]+)";$/mu
      .exec(read(resolve(root, "scripts/lib/plugin-host-protocol-mirror.mjs")))?.[1];
    expect(schemaOrigin).toBeDefined();
    const schemas = join(pub, "schemas");
    const files = (readdirSync(schemas, { recursive: true }) as string[])
      .map((name) => name.split("\\").join("/")).filter((name) => name.endsWith(".schema.json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect((JSON.parse(read(join(schemas, file))) as { $id?: string }).$id).toBe(`${schemaOrigin}/schemas/${file}`);
    }
    // The site may move; the schema origin must stay a route of the Worker serving /schemas/.
    const served = workerConfig().routes.map((route) => route.pattern);
    expect(served, "schema $ids must stay resolvable: the Worker that serves /schemas/ must keep the schema origin as a route")
      .toContain(new URL(schemaOrigin!).host);
  });
});

describe("hosting", () => {
  it("serves the static export at the canonical host from the ave-web Worker", () => {
    const config = workerConfig();
    expect(config.name).toBe("ave-web");
    expect(config.assets.directory).toBe("./out");
    expect(config.routes).toEqual([{ pattern: new URL(SITE).host, custom_domain: true }]);
    expect(read(resolve(web, "lib/i18n.ts"))).toContain(`export const SITE_ORIGIN = "${SITE}";`);
    // The web build scripts read that declaration instead of a second literal.
    const buildScripts = readdirSync(resolve(root, "scripts/lib")).filter((name) => /^web-.*\.m?js$/u.test(name))
      .map((name) => `scripts/lib/${name}`);
    expect(buildScripts).toContain("scripts/lib/web-export.mjs");
    for (const script of ["scripts/run-web-build.mjs", ...buildScripts]) {
      expect(read(resolve(root, script)), script).not.toContain(SITE);
    }
    expect(read(join(pub, "robots.txt"))).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
});

describe("download links", () => {
  it("links each system to its stable alias on the release channel", () => {
    expect(downloadsSource).toContain('const RELEASE_CHANNEL_ORIGIN = "https://downloads.agent-connector.ai";');
    expect(downloadsSource).toContain("const latest = (file: string) => `${RELEASE_CHANNEL_ORIGIN}/latest/${file}`;");
    const linked = [...downloadsSource.matchAll(/os: "([a-z]+)",[\s\S]*?href: latest\("([^"]+)"\)/gu)].map((m) => [m[1], m[2]]);
    expect(linked).toEqual([
      ["mac", "mac-arm64.dmg"],
      ["windows", "windows-x64-setup.exe"],
      ["linux", "linux-x86_64.AppImage"],
    ]);
  });

  it("names the installed app in the setup commands", () => {
    expect(downloadsSource).toContain(`command: 'sudo xattr -dr com.apple.quarantine "/Applications/Ave.app"'`);
    expect(downloadsSource).toContain('command: "chmod +x Ave-*-linux-x86_64.AppImage"');
  });
});

describe("page map", () => {
  const paths = sitePaths();

  it("has the home, download and guide pages in both languages", () => {
    for (const path of ["/", "/download/", "/docs/", ...DOC_SLUGS.map((s) => `/docs/${s}/`)]) {
      expect(paths, path).toContain(path);
      expect(paths, `/en${path}`).toContain(`/en${path}`);
    }
    expect(DOC_SLUGS.length).toBeGreaterThan(0);
    // Each slug has a page in both locales: the ko and en tables each hold one entry per slug.
    for (const slug of DOC_SLUGS) {
      expect(docsSource.match(new RegExp(`slug: "${slug}"`, "gu"))?.length, slug).toBe(2);
    }
  });

  it("keeps every site URL the app and the repository link to", () => {
    // The unsigned-build update guide opens the site root; it must carry the downloads.
    const updater = read(resolve(root, "src/main/auto-updater.ts"));
    expect(updater).toContain(`const UPDATE_GUIDE_URL = "${SITE}";`);
    expect(paths).toContain("/");
    expect(read(resolve(web, "components/home.tsx"))).toContain('id="download"');

    const issueConfig = read(resolve(root, ".github/ISSUE_TEMPLATE/config.yml"));
    const linked = [...issueConfig.matchAll(/https:\/\/ave\.agent-connector\.ai(\/[^\s"']*)/gu)].map((m) => m[1] as string);
    expect(linked.length).toBeGreaterThan(0);
    for (const path of linked) expect(paths).toContain(path.endsWith("/") ? path : `${path}/`);
  });

  it("redirects earlier guide URLs to pages that exist, never from one", () => {
    const rules = read(join(pub, "_redirects"))
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/u));
    expect(rules.length).toBeGreaterThan(0);
    for (const [from, to, status] of rules) {
      expect(status).toBe("301");
      expect(paths, `${from} must not shadow a live page`).not.toContain(from);
      expect(paths, `${from} → ${to}`).toContain(to);
    }
  });
});

describe("site copy", () => {
  const sources = ["app", "components", "lib"].flatMap((dir) => {
    const out: string[] = [];
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/u.test(name)) out.push(full);
      }
    };
    walk(resolve(web, dir));
    return out;
  });

  it("states no licence and ends with the owner's notice", () => {
    for (const file of sources) {
      expect(/\bMIT\b|open[ -]source|오픈 ?소스/iu.test(read(file)), relative(root, file)).toBe(false);
    }
    expect(read(resolve(web, "lib/home.ts")).match(/© 2026 Ken Jo/gu)?.length).toBe(2);
  });
});
