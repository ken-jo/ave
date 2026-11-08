import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGateScript, writeFixtureFile as write } from "./gate-script-runner.js";

// Fixtures cover the whole Tailwind source tree, length units and prefixes, colour forms, and the test-file exemption.
const SCRIPT = resolve(process.cwd(), "scripts/check-type-tokens.mjs");
const roots: string[] = [];

function createRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ave-type-tokens-"));
  roots.push(root);
  write(root, "src/.keep.ts", "");
  for (const [rel, contents] of Object.entries(files)) write(root, rel, contents);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-type-tokens", () => {
  it("accepts components that use the named type scale", () => {
    const root = createRoot({
      "src/ui/renderer/Row.tsx": `export const Row = () => <span className="text-dense leading-4 text-muted-foreground" />;\n`,
      "src/components/ui/badge.tsx": `export const cls = "text-tiny sm:text-caption";\n`,
    });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[type-token-check] OK files=3");
  });

  it("rejects an arbitrary px size in the renderer", () => {
    const root = createRoot({ "src/ui/renderer/Row.tsx": `export const Row = () => <span className="text-[11px]" />;\n` });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/ui/renderer/Row.tsx:1  text-[11px]");
  });

  it("rejects fractional and variant-prefixed sizes in shared components", () => {
    const root = createRoot({ "src/components/ui/kbd.tsx": `export const a = "px-1";\nexport const b = "md:!text-[10.5px]";\n` });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/components/ui/kbd.tsx:2  text-[10.5px]");
  });

  it("rejects rem, em, length-prefixed and upper-case units in renderer entries outside src/ui", () => {
    const root = createRoot({
      "src/floating-dock-window.tsx": `const a = "text-[0.7rem]";\nconst b = "text-[length:1.1em]";\nconst c = "text-[11PX]";\n`,
      "src/studio/page.html": `<span class="text-[0.75rem]"></span>\n`,
    });
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/floating-dock-window.tsx:1  text-[0.7rem]");
    expect(result.stderr).toContain("src/floating-dock-window.tsx:2  text-[length:1.1em]");
    expect(result.stderr).toContain("src/floating-dock-window.tsx:3  text-[11PX]");
    expect(result.stderr).toContain("src/studio/page.html:1  text-[0.75rem]");
  });

  it("leaves arbitrary colour forms alone", () => {
    const root = createRoot({
      "src/ui/renderer/Banner.tsx": "const a = \"text-[hsl(var(--action-view))]\";\nconst b = \"text-[CanvasText]\";\nconst c = \"text-[var(--x)]\";\nconst d = `text-[hsl(var(--" + "$" + "{token}))]`;\n",
    });
    expect(runGateScript(SCRIPT, root).status).toBe(0);
  });

  it("leaves test files to assert whatever class names they need", () => {
    const root = createRoot({
      "src/ui/renderer/__tests__/Row.test.tsx": `expect(el.className).toContain("text-[11px]");\n`,
      "src/components/ui/select.spec.tsx": `const cls = "text-[11px]";\n`,
    });
    expect(runGateScript(SCRIPT, root).status).toBe(0);
  });

  it("fails closed when the source root is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-type-tokens-"));
    roots.push(root);
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot scan src");
  });
});
