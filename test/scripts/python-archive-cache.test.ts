import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PYTHON_VERSION, pythonArchiveCacheKey } from "../../.github/scripts/python-archive-cache.mjs";
import { githubExpression as expr } from "../../src/__tests__/test-helpers.js";

const read = (file: string) => readFileSync(resolve(file), "utf8");

describe("managed interpreter archive cache", () => {
  it("keys downloads by the installed tool version, interpreter version and target", () => {
    const key = pythonArchiveCacheKey("uv 0.7.3 (build)\n", "win32", "x64");
    expect(key).toBe(`python-archive-v1-uv-0.7.3-python-${PYTHON_VERSION}-win32-x64`);
    expect(pythonArchiveCacheKey("uv 0.7.4", "win32", "x64")).not.toBe(key);
    expect(pythonArchiveCacheKey("uv 0.7.3", "darwin", "arm64")).not.toBe(key);
  });
  it.each(["", "something 0.7.3", "uv latest", "uv 0.7.3-invalid"])("refuses an unidentified version %s", (version) => {
    expect(() => pythonArchiveCacheKey(version, "win32", "x64")).toThrow("Cannot identify");
  });
  it("restores archives before the real install and keeps installed environments out of the cache", () => {
    const steps = parse(read(".github/workflows/ci.yml")).jobs["windows-permission-tests"].steps;
    const cache = steps.find((step: { name?: string }) => step.name === "Restore native interpreter archives");
    const tests = steps.find((step: { name?: string }) => step.name === "Run Windows permission regressions");
    expect(cache.uses).toBe("actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(cache.with).toEqual({ path: `${expr("runner.temp")}/python-archives`, key: expr("steps.python-archive.outputs.key") });
    expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(tests));
    expect(tests.env.UV_PYTHON_CACHE_DIR).toBe(cache.with.path);
    expect(tests.run).toContain("src/sandbox/__tests__/runtime-grant-native.test.ts");
    const native = read("src/sandbox/__tests__/runtime-grant-native.test.ts");
    expect(native).toContain('UV_PYTHON_INSTALL_DIR: join(env, "python")');
    expect(native).toContain('UV_CACHE_DIR: join(env, "uv-cache")');
    expect(native).toContain('UV_PYTHON_CACHE_DIR: process.env.UV_PYTHON_CACHE_DIR ?? join(env, "python-archives")');
    expect(native).toContain('["python", "install", PYTHON_VERSION]');
    expect(native).toContain('["venv", join(env, "venv"), "--python", PYTHON_VERSION]');
  });
});
