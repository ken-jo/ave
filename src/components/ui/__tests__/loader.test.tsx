// @vitest-environment jsdom
/**
 * The one loader. Every spinner in the renderer goes through it so the reduced-motion rule is written once: a raw
 * `animate-spin` keeps spinning under `prefers-reduced-motion`, because the global reduced-motion block collapses the
 * `--motion-*` tokens and Tailwind's `spin` keyframe does not read them.
 */
import "../../../../test/renderer/setup.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Loader } from "../loader.js";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("Loader", () => {
  it("spins only while motion is allowed", () => {
    const { container } = render(<Loader />);
    const svg = container.querySelector("svg[data-loader]");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("animate-spin");
    expect(svg?.getAttribute("class")).toContain("motion-reduce:animate-none");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each([
    [12, "h-3 w-3"],
    [14, "h-3.5 w-3.5"],
    [16, "h-4 w-4"],
  ] as const)("draws the %ipx icon step", (size, cls) => {
    const { container } = render(<Loader size={size} />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(cls);
  });

  it("spins a given glyph under the same rule", () => {
    const { container } = render(<Loader icon={RefreshCw} />);
    const svg = container.querySelector("svg[data-loader]");
    expect(svg?.getAttribute("class")).toContain("lucide-refresh-cw");
    expect(svg?.getAttribute("class")).toContain("motion-reduce:animate-none");
  });

  it("is the only place in src that spins", () => {
    const root = join(__dirname, "../../..");
    const offenders = sourceFiles(root)
      .filter((path) => !path.endsWith(join("components", "ui", "loader.tsx")))
      .filter((path) => /(^|[\s"'`:])animate-spin\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });
});
