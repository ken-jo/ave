// Keep the vendored fixture byte-for-byte with its upstream recipe; refresh its identity together.
// Bundles must omit build paths, run under bare Node and reserve stdout for reports.
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

function helloWorld(name: string, minAppVersion: string | undefined): string {
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
          requires: { minAppVersion, hostProtocol: "4" },
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
    const result = runBundle(helloWorld("hello-world", "0.14.0"));
    expect(result.status).toBe(0);
    const rows = reportRows(result.stdout);
    expect(rows.find((row) => row.check === "tools.call:hello_world")?.ok).toBe(true);
    expect(rows.find((row) => row.check === "protocol.stdin-close")?.ok).toBe(true);
    expect(result.stdout).not.toContain(PLUGIN_LOG_TEXT);
  }, 60_000);

  it("rejects a missing minimum declaration without inventing a release floor", () => {
    const result = runBundle(helloWorld("hello-broken", undefined));
    expect(result.status).toBe(1);
    const failing = reportRows(result.stdout).filter((row) => row.ok === false);
    expect(failing.map((row) => row.check)).toEqual(["manifest.min-app-version"]);
    expect(result.stderr).toContain("manifest.min-app-version");
  }, 60_000);
});
