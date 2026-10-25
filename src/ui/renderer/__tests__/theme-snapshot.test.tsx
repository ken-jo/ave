/** Theme changes swap tokens; component markup must remain identical across bundles. */
import "../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

async function renderInBundle(bundleId: string, node: JSX.Element) {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  const result = render(<ThemeProvider initialBundleId={bundleId}>{node}</ThemeProvider>);
  await waitFor(() => {
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe(bundleId);
  });
  return {
    html: result.container.innerHTML,
    rootBundle: document.documentElement.getAttribute("data-theme-bundle"),
    cleanup: () => result.unmount(),
  };
}

describe("Theme snapshots — semantic-token components are bundle-invariant", () => {
  it("Button (primary) renders identical markup in gallery vs moonstone", async () => {
    const first = await renderInBundle("gallery", <Button>Click</Button>);
    expect(first.rootBundle).toBe("gallery");
    first.cleanup();
    const second = await renderInBundle("moonstone", <Button>Click</Button>);
    expect(second.rootBundle).toBe("moonstone");
    expect(second.html).toBe(first.html);
    second.cleanup();
  });

  it("Button variants still emit bundle-agnostic class strings", async () => {
    for (const variant of ["default", "destructive", "outline", "secondary", "ghost"] as const) {
      const first = await renderInBundle("gallery", <Button variant={variant}>x</Button>);
      first.cleanup();
      const second = await renderInBundle("moonstone", <Button variant={variant}>x</Button>);
      expect(second.html, `variant=${variant} differs between bundles`).toBe(first.html);
      second.cleanup();
    }
  });

  it("Input is bundle-invariant", async () => {
    const first = await renderInBundle("gallery", <Input placeholder="search" />);
    first.cleanup();
    const second = await renderInBundle("moonstone", <Input placeholder="search" />);
    expect(second.html).toBe(first.html);
    second.cleanup();
  });

  it("Card composition is bundle-invariant", async () => {
    const tree = (
      <Card>
        <CardHeader><CardTitle>Title</CardTitle></CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    );
    const first = await renderInBundle("gallery", tree);
    first.cleanup();
    const second = await renderInBundle("moonstone", tree);
    expect(second.html).toBe(first.html);
    second.cleanup();
  });

  it("Button does NOT include any theme-literal Tailwind palette utilities", async () => {
    const { html, cleanup } = await renderInBundle("gallery", <Button>x</Button>);
    expect(html).not.toMatch(/\bbg-slate-\d+\b/);
    expect(html).not.toMatch(/\bbg-zinc-\d+\b/);
    expect(html).not.toMatch(/\bbg-gray-\d+\b/);
    expect(html).not.toMatch(/\btext-white\b/);
    expect(html).not.toMatch(/\btext-black\b/);
    /* Opacity-variant black/white classes — caught the original modal backdrop
       regression where `bg-black/50` looked correct in tokyo-night but became
       invisible in forest/violet-light. The base rule (bare bg-white/bg-black)
       was already covered; this extends it to include /N variants. */
    expect(html).not.toMatch(/\bbg-(black|white)\/\d+\b/);
    expect(html).not.toMatch(/\bhover:bg-(black|white)\/\d+\b/);
    cleanup();
  });
});

/* Source-level forbidden-pattern audit — scans every renderer .tsx/.ts file
   for raw Tailwind palette utilities, opacity-variant black/white, and inline
   raw color literals. Acts as a tripwire for new violations introduced by
   future feature work — much faster than a Playwright per-bundle screenshot
   sweep and catches the problem before it reaches a theme. */
describe("Renderer source has no hardcoded color escapes", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");

  /** Files where palette literals are intentional (theme definitions, brand SVG). */
  const ALLOW = [
    "theme/bundles/",
    "__tests__/",
    "components/AveLogo.tsx",   /* brand gradient — not theme-bound */
    "test/",
  ];

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        out.push(...await walk(p));
      } else if (e.isFile() && (p.endsWith(".tsx") || p.endsWith(".ts"))) {
        out.push(p);
      }
    }
    return out;
  }

  /** vitest is invoked from the project root via package.json scripts — `process.cwd()` is the contract. */
  const RENDERER_ROOT = resolve(process.cwd(), "src/ui/renderer");
  const FORBIDDEN_TAILWIND_PALETTE =
    /\b(?:text|bg|fill|border|ring|stroke|hover:bg|hover:text|hover:border|dark:text|dark:bg)-(?:red|green|yellow|blue|purple|pink|amber|emerald|rose|orange|indigo|violet|fuchsia|cyan|teal|sky|lime|stone|gray|slate|zinc|neutral)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;
  const FORBIDDEN_BLACK_WHITE = /\b(?:bg|text|border|ring|fill|hover:bg|hover:text|hover:border)-(?:black|white)(?:\/\d+)?\b/;
  const FORBIDDEN_HEX_LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]/;

  it("no Tailwind palette utilities outside bundle TS / tests", async () => {
    const files = await walk(RENDERER_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const normalizedFile = file.replace(/\\/g, "/");
      if (ALLOW.some((a) => normalizedFile.includes(a))) continue;
      const content = await readFile(file, "utf8");
      // Strip block comments before line comments so issue references cannot look like color literals; the walker excludes
      // literal-URL cases.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN_TAILWIND_PALETTE.test(line)) {
          violations.push(`${file}:${i + 1} palette → ${line.trim().slice(0, 100)}`);
        }
        if (FORBIDDEN_BLACK_WHITE.test(line)) {
          violations.push(`${file}:${i + 1} black/white → ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });

  it("no inline hex color literals in renderer .tsx files (excluding brand SVG)", async () => {
    const files = (await walk(RENDERER_ROOT)).filter((f) => f.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const normalizedFile = file.replace(/\\/g, "/");
      if (ALLOW.some((a) => normalizedFile.includes(a))) continue;
      const content = await readFile(file, "utf8");
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        if (FORBIDDEN_HEX_LITERAL.test(line)) {
          violations.push(`${file}:${i + 1} hex → ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });
});
