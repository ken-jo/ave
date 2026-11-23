// windows-native: the Windows job runs this file from config/windows-native-tests.txt.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_ENTRY_POINTS } from "../../../scripts/lib/main-entry-points.mjs";
// @ts-expect-error standalone build utilities have no declaration output
import { mxcVerificationEntries } from "../../../scripts/lib/mxc-verification-build.mjs";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const SWITCH = "NoDefaultCurrentDirectoryInExePath";
const platform = process.platform;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LOOKUP = join(root, "src", "main", "bare-program-lookup.ts");
let saved: string | undefined;

beforeEach(() => {
  vi.resetModules();
  saved = process.env[SWITCH];
  delete process.env[SWITCH];
});
afterEach(() => {
  setProcessPlatform(platform);
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});

it("on Windows the host sets the variable that keeps the current folder out of a bare program name's lookup", async () => {
  setProcessPlatform("win32");
  await import("../bare-program-lookup.js");
  expect(process.env[SWITCH]).toBe("1");
});

it("elsewhere the environment is left as it is", async () => {
  setProcessPlatform("linux");
  await import("../bare-program-lookup.js");
  expect(process.env[SWITCH]).toBeUndefined();
});

describe("every esbuild entry imports the lookup before any other module", () => {
  const entries = (): string[] => [
    ...Object.values(MAIN_ENTRY_POINTS),
    ...Object.values(mxcVerificationEntries(root, { AVE_MXC_VERIFICATION_BUILD: "1" }) as Record<string, string>).map(path => relative(root, path).split("\\").join("/")),
  ];
  /** The entries whose first import is not the lookup. */
  function problems(read: (file: string) => string): string[] {
    return entries().filter((file) => {
      const specifier = relative(dirname(join(root, file)), LOOKUP).split("\\").join("/").replace(/\.ts$/u, ".js");
      const expected = specifier.startsWith(".") ? specifier : `./${specifier}`;
      const first = read(file).split("\n").find(line => line.startsWith("import "));
      return first !== `import "${expected}";` && first !== `import '${expected}';`;
    });
  }
  const source = (file: string): string => readFileSync(join(root, file), "utf8");

  it("the build takes its entries from the list and the verification probe alone", () => {
    const build = source("scripts/build-main-esbuild.mjs");
    const block = build.slice(build.indexOf("  entryPoints: {"), build.indexOf("\n  },", build.indexOf("  entryPoints: {")));
    expect(block.split("\n").slice(1).map(line => line.trim())).toEqual([
      "...Object.fromEntries(Object.entries(MAIN_ENTRY_POINTS).map(([name, path]) => [name, resolve(repoRoot, path)])),",
      "...mxcVerificationEntries(repoRoot),",
    ]);
  });

  it("in the tree", () => {
    expect(entries()).toEqual(expect.arrayContaining(["src/main.ts", "src/headless.ts", "tools/mxc-probes/packaged-main.ts"]));
    expect(problems(source)).toEqual([]);
  });

  it("an entry that imports anything before it is found", () => {
    const planted = (file: string): string => file === "src/headless.ts" ? `import { homedir } from "node:os";\n${source(file)}` : source(file);
    expect(problems(planted)).toEqual(["src/headless.ts"]);
  });
});
