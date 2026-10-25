// Assert theme-aware prose colors so inverted text cannot break light-theme contrast.
import "./setup.js";
import { describe, it, expect } from "vitest";
import { relativeLuminance } from "./helpers.js";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { AssistantCard } from "../../src/ui/renderer/components/AssistantCard.js";
import { BUNDLE_IDS, findBundle } from "../../src/ui/renderer/theme/bundles/index.js";
import { assistantEntry } from "../../src/__tests__/test-helpers.js";

describe("AssistantCard — markdown wrapper classes (light-theme regression guard)", () => {
  it("uses ave-prose and does NOT carry prose-invert", () => {
    const { getByTestId } = render(<AssistantCard entry={assistantEntry("hello world")} />);
    const body = getByTestId("assistant-message-body");
    expect(body.classList.contains("ave-prose")).toBe(true);
    // Inverted prose hardcodes light foregrounds and must stay off theme-aware chat surfaces.
    expect(body.classList.contains("prose-invert")).toBe(false);
  });

  it("still applies the base `prose` and `prose-sm` typography classes", () => {
    const { getByTestId } = render(<AssistantCard entry={assistantEntry("body")} />);
    const body = getByTestId("assistant-message-body");
    expect(body.classList.contains("prose")).toBe(true);
    expect(body.classList.contains("prose-sm")).toBe(true);
  });
});

function hslTripleToRgb(triple: string): [number, number, number] {
  const parts = triple.trim().split(/\s+/);
  const h = parseFloat(parts[0]!);
  const s = parseFloat(parts[1]!.replace("%", "")) / 100;
  const l = parseFloat(parts[2]!.replace("%", "")) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}


function contrastRatio(fgHsl: string, bgHsl: string): number {
  const fg = relativeLuminance(hslTripleToRgb(fgHsl));
  const bg = relativeLuminance(hslTripleToRgb(bgHsl));
  const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
  return (hi + 0.05) / (lo + 0.05);
}

// Keep fixture colors aligned with shipped CSS primitives; importing styles would alter test cascade.
const SHELL_TOKENS: Record<string, { fg: string; bg: string }> = {
  dark: {
    fg: "210 40% 98%",      // --p-slate-50
    bg: "222.2 84% 4.9%",    // --p-slate-950
  },
  light: {
    fg: "222 47% 11%",       // --p-slate-900
    bg: "0 0% 100%",         // --p-slate-0
  },
  "high-contrast": {
    fg: "0 0% 100%",
    bg: "0 0% 0%",
  },
};

describe("Theme tokens — body text contrast must clear WCAG AA on every shell", () => {
  for (const [shell, { fg, bg }] of Object.entries(SHELL_TOKENS)) {
    it(`data-theme=\"${shell}\" has --foreground / --background contrast >= 4.5:1`, () => {
      const ratio = contrastRatio(fg, bg);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("Theme bundles — chat and code text contrast must clear WCAG AA", () => {
  for (const bundleId of BUNDLE_IDS) {
    it(`${bundleId} foreground/background contrast >= 4.5:1`, () => {
      const bundle = findBundle(bundleId);
      expect(bundle).toBeDefined();
      if (!bundle) return;
      const ratio = contrastRatio(bundle.tokens.foreground, bundle.tokens.background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it(`${bundleId} code foreground/background contrast >= 4.5:1`, () => {
      const bundle = findBundle(bundleId);
      expect(bundle).toBeDefined();
      if (!bundle) return;
      const ratio = contrastRatio(bundle.tokens["code-fg"], bundle.tokens["code-bg"]);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("ave-prose CSS coverage — markdown tables stay readable", () => {
  const css = readFileSync("src/styles.css", "utf-8").replace(/\r\n/g, "\n");

  it("uses .prose.ave-prose specificity so Typography defaults cannot repaint text black", () => {
    expect(css).toContain(".prose.ave-prose {");
    expect(css).toMatch(/\.prose\.ave-prose\s+:where\([^)]*\bp\b[^)]*\bstrong\b[^)]*\bth\b[^)]*\btd\b[^)]*\)/);
  });

  it("forces table cells and headers onto semantic foreground tokens", () => {
    expect(css).toMatch(/\.prose\.ave-prose\s+:where\(td\).*color:\s*hsl\(var\(--foreground\) \/ 0\.88\)/s);
    expect(css).toMatch(/\.prose\.ave-prose\s+:where\(th\).*color:\s*hsl\(var\(--foreground\)\)/s);
    expect(css).toMatch(/\.ave-prose\s+:is\([^)]*\bth\b[^)]*\btd\b[^)]*\)/);
    expect(css).toMatch(/\.ave-prose\s+:is\(td\).*color:\s*hsl\(var\(--foreground\) \/ 0\.88\)/s);
    expect(css).toMatch(/\.ave-prose\s+:is\(th\).*color:\s*hsl\(var\(--foreground\)\)/s);
  });

  it("keeps nested bold and inline text inside table cells inheriting readable cell color", () => {
    expect(css).toContain(".prose.ave-prose :where(th *, td *)");
    expect(css).toContain(".ave-prose :is(th, td) :is(p, span, strong, em)");
  });

  // Merge repeated cascade-layer blocks and track nested braces when collecting their contents.
  function extractLayerBody(source: string, layerName: string): string | null {
    const markerRe = new RegExp(`@layer\\s+${layerName}\\s*\\{`, "g");
    const slices: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = markerRe.exec(source)) !== null) {
      let i = match.index + match[0].length;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      if (depth !== 0) return null;
      slices.push(source.slice(match.index + match[0].length, i - 1));
      markerRe.lastIndex = i;
    }
    return slices.length > 0 ? slices.join("\n") : null;
  }

  it("body font-family inside @layer base leads with system-ui and keeps Hangul fallback", () => {
    // Host and guest surfaces share a system-ui-first font stack; Korean fonts provide script fallback.
    const layerBase = extractLayerBody(css, "base");
    expect(layerBase, "@layer base block not found in styles.css").not.toBeNull();
    // User overrides wrap a default stack that must retain system-ui first and a Hangul fallback.
    expect(layerBase!).toMatch(
      /\bbody\s*\{[^{}]*?font-family:\s*var\(\s*--ave-font-family\s*,\s*system-ui\s*,/,
    );
    expect(layerBase!).toMatch(
      /body\s*\{[^{}]*?font-family:[^{}]*?("Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo")/,
    );
  });

  // CSS and HTML font mirrors must match the shared host stack despite whitespace differences.
  const HOST_FONT_STACK_LITERAL =
    "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, " +
    "\"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif";
  // Normalize whitespace and comma spacing before comparing font stacks.
  const normalize = (s: string) =>
    s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();

  const FONT_STACK_MIRRORS: Array<{
    label: string;
    path: string;
    extract: (text: string) => string | null;
  }> = [
    {
      label: "styles.css @layer base body",
      path: "src/styles.css",
      extract: (text) => {
        const layer = extractLayerBody(text, "base");
        if (!layer) return null;
        // Unwrap user customization to compare the default fallback stack.
        const wrapped = layer.match(/\bbody\s*\{[^{}]*?font-family:\s*var\(\s*--ave-font-family\s*,\s*([\s\S]*?)\s*\)\s*;/);
        if (wrapped) return wrapped[1]!;
        const raw = layer.match(/\bbody\s*\{[^{}]*?font-family:\s*([^;}]+)/);
        return raw ? raw[1]! : null;
      },
    },
    {
      label: "plugin-ui-shell.html body",
      path: "src/plugin-ui-shell.html",
      extract: (text) => text.match(/body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "bootstrap-splash.ts splash inline",
      path: "src/main/bootstrap-splash.ts",
      extract: (text) => text.match(/html,body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      // Register separate host windows as font mirrors so their typography cannot drift.
      label: "floating-dock-window.html body",
      path: "src/floating-dock-window.html",
      extract: (text) => text.match(/body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "window-titlebar-shell.ts body",
      path: "src/main/window-titlebar-shell.ts",
      extract: (text) => text.match(/body\s*\{[^{}]*?font-family:\s*([^;}]+)/)?.[1] ?? null,
    },
    {
      label: "tools/render-html.ts wrapWithCsp",
      path: "src/tools/render-html.ts",
      extract: (text) => text.match(/html,body\{[^{}]*?font-family:([^;}]+)/)?.[1] ?? null,
    },
  ];

  it("every host-owned chrome surface mirrors HOST_FONT_STACK byte-for-byte (whitespace-normalized)", () => {
    for (const { label, path, extract } of FONT_STACK_MIRRORS) {
      const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
      const value = extract(text);
      expect(value, `${label}: could not locate font-family literal — extractor stale?`).not.toBeNull();
      expect(normalize(value!), `${label}: stack diverges from HOST_FONT_STACK`).toBe(normalize(HOST_FONT_STACK_LITERAL));
    }
  });

  it("HOST_FONT_STACK is the ONLY surface that mentions Noto Sans KR as a fallback (grep-zero invariant)", () => {
    // Register new raw host font mirrors here; only shared definitions, mirrors and tests are exempt.
    const allowlist = new Set(
      [
        "src/shared/host-font-stack.ts",
        ...FONT_STACK_MIRRORS.map((m) => m.path),
        "test/renderer/assistant-card-contrast.test.tsx",
        // User-selectable font presets are configuration options rather than fixed host-stack mirrors.
        "src/ui/renderer/tabs/AppearanceTab.tsx",
        "src/data/__tests__/settings-store.test.ts",
      ].map((p) => p.replace(/\\/g, "/")),
    );
    function walk(dir: string, out: string[], depth = 0): void {
      // Bound traversal depth to avoid symlink cycles.
      if (depth > 12) return;
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = path.join(dir, name).replace(/\\/g, "/");
        let s;
        try { s = fs.lstatSync(full); } catch { continue; }
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full, out, depth + 1);
          continue;
        }
        if (/\.(ts|tsx|html|css)$/.test(name)) out.push(full);
      }
    }
    const files: string[] = [];
    walk("src", files);
    const violations: string[] = [];
    for (const f of files) {
      if (allowlist.has(f)) continue;
      const text = readFileSync(f, "utf-8");
      if (/"Noto Sans KR"|"Malgun Gothic"|"Apple SD Gothic Neo"/.test(text)) {
        violations.push(f);
      }
    }
    expect(
      violations,
      "Korean font fallback should only appear inside HOST_FONT_STACK mirrors — add new shell to FONT_STACK_MIRRORS + allowlist",
    ).toEqual([]);
  });

  it("keeps ave-prose rules UNLAYERED so they beat Tailwind Typography's @layer utilities", () => {
    // Prose overrides must follow typography utilities in cascade order to retain dark-theme emphasis colors.
    const aveAnchor = css.indexOf(".prose.ave-prose,\n  .ave-prose {");
    expect(aveAnchor).toBeGreaterThan(0);
    // Find the enclosing layer by matching braces backward from the target.
    const head = css.slice(0, aveAnchor);
    let depth = 0;
    let i = head.length;
    while (i > 0) {
      const ch = head[i - 1];
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) {
          const before = head.slice(Math.max(0, i - 80), i - 1).trim();
          expect(before).not.toMatch(/@layer\s+\w/);
          return;
        }
        depth--;
      }
      i--;
    }
  });
});
