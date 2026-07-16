import { afterEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { aveHome } from "../ave-home.js";

const originalAveHome = process.env.AVE_HOME;

afterEach(() => {
  if (originalAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalAveHome;
});

describe("aveHome", () => {
  it("resolves a relative AVE_HOME against the process working directory", () => {
    process.env.AVE_HOME = join("relative-state", "..", "ave-state");
    expect(aveHome()).toBe(resolve("ave-state"));
  });

  it("normalizes an absolute AVE_HOME override", () => {
    process.env.AVE_HOME = join(tmpdir(), "ave-parent", "..", "ave-state");
    expect(aveHome()).toBe(resolve(tmpdir(), "ave-state"));
  });
});
