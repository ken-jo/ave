/** The strict shell CSP requires an external host bootstrap and contained plugin asset URLs. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = dirname(__filename);
const repoRoot = resolve(__dirnameLocal, "..", "..");
const shellHtmlPath = resolve(repoRoot, "src/plugin-ui-shell.html");
const shellJsPath = resolve(repoRoot, "src/plugin-ui-shell.js");
const packageJsonPath = resolve(repoRoot, "package.json");
const devScriptPath = resolve(repoRoot, "scripts/run-electron-dev.mjs");
const buildAssetsPath = resolve(repoRoot, "scripts/lib/build-assets.mjs");

const shellHtml = readFileSync(shellHtmlPath, "utf8");
const shellJs = readFileSync(shellJsPath, "utf8");
const packageJson = readFileSync(packageJsonPath, "utf8");
const devScript = readFileSync(devScriptPath, "utf8");
const buildAssets = readFileSync(buildAssetsPath, "utf8");

function extractCsp(html: string): string {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  if (!m) throw new Error("CSP meta tag not found in plugin-ui-shell.html");
  return m[1];
}

function extractScripts(html: string): Array<{ raw: string; attrs: string; body: string }> {
  const out: Array<{ raw: string; attrs: string; body: string }> = [];
  let offset = 0;
  const lower = html.toLowerCase();
  while (offset < html.length) {
    const open = lower.indexOf("<script", offset);
    if (open < 0) break;
    const attrsStart = open + "<script".length;
    const openEnd = html.indexOf(">", attrsStart);
    if (openEnd < 0) break;
    const closeStart = findScriptCloseTag(html, openEnd + 1);
    if (closeStart < 0) break;
    const closeEnd = html.indexOf(">", closeStart);
    if (closeEnd < 0) break;
    out.push({
      raw: html.slice(open, closeEnd + 1),
      attrs: html.slice(attrsStart, openEnd),
      body: html.slice(openEnd + 1, closeStart),
    });
    offset = closeEnd + 1;
  }
  return out;
}

function findScriptCloseTag(html: string, from: number): number {
  const lower = html.toLowerCase();
  let cursor = from;
  while (cursor < html.length) {
    const candidate = lower.indexOf("</script", cursor);
    if (candidate < 0) return -1;
    const afterName = lower[candidate + "</script".length];
    if (afterName === undefined || afterName === ">" || /\s/.test(afterName)) {
      return candidate;
    }
    cursor = candidate + 1;
  }
  return -1;
}

describe("plugin-ui-shell — CSP-safe external bootstrap", () => {
  it("declares a strict CSP without 'unsafe-inline' for script-src", () => {
    const csp = extractCsp(shellHtml);
    expect(csp).toMatch(/script-src[^;]*'self'/);
    // Do not relax script-src to allow inline execution.
    const scriptSrc = csp.match(/script-src[^;]*/i)?.[0] ?? "";
    // Local plugin code must load through the contained per-plugin asset protocol.
    expect(scriptSrc).not.toMatch(/\bfile:/);
    expect(scriptSrc).toMatch(/\bave-plugin:/);
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
    expect(scriptSrc).not.toMatch(/'nonce-/);
    expect(scriptSrc).not.toMatch(/'sha(256|384|512)-/);
  });

  it("contains no inline executable <script> block (must use external src)", () => {
    const scripts = extractScripts(shellHtml);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      const hasSrc = /\bsrc\s*=/.test(s.attrs);
      const body = s.body.trim();
      const typeMatch = s.attrs.match(/\btype\s*=\s*"([^"]+)"/i);
      const type = typeMatch?.[1].toLowerCase() ?? "";
      const isExecutableType = type === "" || type === "module" || type === "text/javascript" || type === "application/javascript";
      if (isExecutableType) {
        expect(
          hasSrc,
          `Inline executable <script> blocks are not CSP-safe under script-src 'self' (no 'unsafe-inline'). Move bootstrap to an external sibling file. Found: ${s.raw.slice(0, 120)}…`,
        ).toBe(true);
        expect(body, "External executable <script> must have an empty body").toBe("");
      }
    }
  });

  it("references the host-owned external bootstrap as a module script", () => {
    expect(shellHtml).toMatch(
      /<script\s+type="module"\s+src="\.\/plugin-ui-shell\.js"\s*>\s*<\/script>/,
    );
  });

  it("ships the bootstrap source with the user-visible error fallbacks", () => {
    // Recoverable bootstrap failures must produce visible fallback text.
    expect(shellJs).toContain("avePlugin bridge missing");
    expect(shellJs).toContain("Plugin UI failed to load");
    expect(shellJs).toContain("entry lookup failed");
    expect(shellJs).toMatch(/avePlugin\.getEntryUrl/);
    // Protocol entry URLs preserve the install-directory base for relative imports and assets.
    expect(shellJs).not.toMatch(/avePlugin\.getEntryModuleSource/);
    expect(shellJs).not.toMatch(/URL\.createObjectURL/);
    expect(shellJs).not.toMatch(/URL\.revokeObjectURL/);
    expect(shellJs).toMatch(/import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*entry\s*\)/);
  });

  it("build script copies plugin-ui-shell.js into dist/src/", () => {
    expect(packageJson).toContain("node scripts/copy-build-assets.mjs");
    expect(packageJson).not.toContain("src/plugin-ui-shell.html dist/src/plugin-ui-shell.html");
    expect(packageJson).not.toContain("src/plugin-ui-shell.js dist/src/plugin-ui-shell.js");
    expect(buildAssets).toContain('src: "src/plugin-ui-shell.html"');
    expect(buildAssets).toContain('out: "dist/src/plugin-ui-shell.html"');
    expect(buildAssets).toContain('src: "src/plugin-ui-shell.js"');
    expect(buildAssets).toContain('out: "dist/src/plugin-ui-shell.js"');
  });

  it("dev launcher copies and watches the plugin-ui-shell.js asset", () => {
    expect(devScript).toContain('import { resolveBuildAssets } from "./lib/build-assets.mjs";');
    expect(devScript).toContain('resolveBuildAssets(repoRoot, "plugin-shell")');
    expect(buildAssets).toContain('category: "plugin-shell"');
  });

});
