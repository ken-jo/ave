import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGateScript, writeFixtureFile as write } from "./gate-script-runner.js";

// Fixtures cover both scan roots, variant prefixes, and the test-file exemption.
const SCRIPT = resolve(process.cwd(), "scripts/check-type-tokens.mjs");
const roots: string[] = [];

function createRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ave-type-tokens-"));
  roots.push(root);
  write(root, "src/ui/.keep.ts", "");
  write(root, "src/components/.keep.ts", "");
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
    expect(result.stdout).toContain("[type-token-check] OK files=4");
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

  it("leaves test files to assert whatever class names they need", () => {
    const root = createRoot({
      "src/ui/renderer/__tests__/Row.test.tsx": `expect(el.className).toContain("text-[11px]");\n`,
      "src/components/ui/select.spec.tsx": `const cls = "text-[11px]";\n`,
    });
    expect(runGateScript(SCRIPT, root).status).toBe(0);
  });

  it("fails closed when a scan root is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-type-tokens-"));
    roots.push(root);
    write(root, "src/ui/Row.tsx", "");
    const result = runGateScript(SCRIPT, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot scan src/components");
  });
});
