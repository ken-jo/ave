import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Missing lazy chunks fail silently, so package membership must be checked at build time.
// Use repository cwd because bundling can rewrite import.meta.url.
const scriptPath = resolve(process.cwd(), "scripts/check-package-footprint.mjs");
const scriptSrc = readFileSync(scriptPath, "utf8");

// Read the gate's actual regex without importing its side-effecting script.
const MERMAID_ENTRY = /\{\s*name:\s*"mermaid",\s*pattern:\s*\/(.+?)\/([a-z]*)\s*\}/.exec(scriptSrc);
if (!MERMAID_ENTRY) throw new Error("check-package-footprint.mjs has no mermaid LAZY_RENDERER_CHUNKS entry");
const MERMAID_CHUNK_RE = new RegExp(MERMAID_ENTRY[1], MERMAID_ENTRY[2]);

describe("packaged footprint mermaid chunk guard", () => {
  it("the footprint script still asserts the lazy mermaid chunk", () => {
    expect(scriptSrc).toContain("LAZY_RENDERER_CHUNKS");
    // Match the chunk fragment because the regex escapes path separators.
    expect(scriptSrc).toContain("mermaid\\.[0-9a-f]{8}\\.js");
    expect(scriptSrc).toContain("required lazy renderer chunks missing from app.asar");
  });

  it("accepts the emitted contenthash chunk name", () => {
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.7fd4e5a9.js")).toBe(true);
  });

  it("rejects the license sidecar and near-misses", () => {
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.7fd4e5a9.js.LICENSE.txt")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/mermaid.js")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/mermaid.7fd4e5a9.js")).toBe(false);
    expect(MERMAID_CHUNK_RE.test("/dist/src/renderer/chunks/other.7fd4e5a9.js")).toBe(false);
  });
});
