/**
 * The validator as the plugin repositories vendor it: two bundles built with
 * their recipe, run by a plain `node` (`docs/design/plugin-hostapi-protocol.md`
 * §9.7 P2, §10.2).
 *
 * The recipe is the official repository's `tools/bundle-app-marketplace.mjs`
 * at the candidate wave, carried byte for byte in
 * `fixtures/bundle-app-marketplace.e53fb40a8.mjs`:
 *
 *   repository  ken-jo/agent-marketplace
 *   commit      e53fb40a8
 *   sha256      475a7275ccc1ec4793ac6c44598f729e19c335c5ec16f7be6b20a6d230aef85a
 *
 * and run the way its `tools/vendor.mjs` runs it — `bun -e <recipe> <app
 * checkout> <entry>` from the checkout. Refresh the fixture only when that
 * repository changes its recipe, and update the commit and hash here with it.
 *
 * What a vendored validator must be: free of `pino` (the recipe replaces the
 * app logger with a silent one, which the CLI needs because stdout is its
 * report), free of the build checkout's paths (the repository's own check
 * refuses a bundle that embeds one), runnable under bare Node although its
 * graph reaches `electron` (nothing on the validate path calls into it), and
 * silent on stdout but for the report.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedBuildPaths } from "./fixtures/vendor-embedded-build-paths.js";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RECIPE = fileURLToPath(new URL("./fixtures/bundle-app-marketplace.e53fb40a8.mjs", import.meta.url));
const RECIPE_SHA256 = "475a7275ccc1ec4793ac6c44598f729e19c335c5ec16f7be6b20a6d230aef85a";
const PLUGIN_LOG_TEXT = "hello from the plugin's context.log";

const BUNDLES = {
  "ave-plugin-validate.js": "src/plugins/validate/cli.ts",
  "ave-plugin-child-main.js": "src/plugins/isolation/plugin-child-main.ts",
} as const;

let scratch: string;
let vendor: string;

/** A `hello-world`-shaped plugin, logging at construct and in its tool. */
function helloWorld(name: string, minAppVersion: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      version: "1.0.0",
      description: "Says hello.",
      extensions: {
        "ai.agent-connector.ave": {
          displayName: "Hello World",
          entry: "dist/index.js",
          requires: { minAppVersion, hostProtocol: "2" },
          tools: [
            {
              name: "hello_world",
              description: "Say hello.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      },
    }),
  );
  mkdirSync(join(dir, "dist"));
  writeFileSync(
    join(dir, "dist", "index.js"),
    `export const createPlugin = async (context) => {
  context.log(${JSON.stringify(PLUGIN_LOG_TEXT)});
  return {
    handlers: {
      hello_world: async () => {
        context.log(${JSON.stringify(PLUGIN_LOG_TEXT)});
        return "hello";
      },
    },
  };
};
`,
  );
  return dir;
}

function runBundle(pluginDir: string) {
  return spawnSync("node", [join(vendor, "ave-plugin-validate.js"), pluginDir], {
    cwd: scratch,
    encoding: "utf-8",
    timeout: 60_000,
  });
}

function reportRows(stdout: string): Array<{ check: string; ok: boolean | null }> {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as { check: string; ok: boolean | null });
}

const built = new Map<string, { status: number | null; stderr: string; bytes: Buffer }>();

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "validate-plugin-bundle-"));
  vendor = join(scratch, "tools", "vendor");
  mkdirSync(vendor, { recursive: true });
  const recipe = readFileSync(RECIPE, "utf-8");
  for (const [output, entry] of Object.entries(BUNDLES)) {
    const result = spawnSync("bun", ["-e", recipe, APP_ROOT, entry], {
      cwd: APP_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(join(vendor, output), result.stdout);
    built.set(output, { status: result.status, stderr: result.stderr.toString(), bytes: result.stdout });
  }
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the vendored validator bundles", () => {
  it("carries the official recipe at the commit it names", () => {
    const digest = createHash("sha256").update(readFileSync(RECIPE)).digest("hex");
    expect(digest).toBe(RECIPE_SHA256);
  });

  it("builds both entries with the recipe, without pino or an embedded build path", () => {
    for (const output of Object.keys(BUNDLES)) {
      const { status, stderr, bytes } = built.get(output)!;
      expect({ output, status, stderr }).toEqual({ output, status: 0, stderr: "" });
      expect(bytes.includes("pino")).toBe(false);
      expect({ output, paths: embeddedBuildPaths(bytes) }).toEqual({ output, paths: [] });
    }
  });

  it("validates a hello-world plugin under plain node, with only the report on stdout", () => {
    const result = runBundle(helloWorld("hello-world", "0.12.0"));
    expect(result.status).toBe(0);
    const rows = reportRows(result.stdout);
    expect(rows.find((row) => row.check === "tools.call:hello_world")?.ok).toBe(true);
    expect(rows.find((row) => row.check === "protocol.stdin-close")?.ok).toBe(true);
    expect(result.stdout).not.toContain(PLUGIN_LOG_TEXT);
  }, 60_000);

  it("fails a broken plugin and names the failing check", () => {
    const result = runBundle(helloWorld("hello-broken", "0.11.0"));
    expect(result.status).toBe(1);
    const failing = reportRows(result.stdout).filter((row) => row.ok === false);
    expect(failing.map((row) => row.check)).toEqual(["manifest.min-app-version"]);
    expect(result.stderr).toContain("manifest.min-app-version");
  }, 60_000);
});
