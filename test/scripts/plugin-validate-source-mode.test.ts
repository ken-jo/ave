// Source validation must pass its loader to child processes without requiring dist/.
// Replace logging in both processes so stdout contains only report rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { cleanupTmpDir, removeLinkOnly } from "../../src/__tests__/support/tmp-dir-teardown.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemProcessProbe } from "../../src/__tests__/support/test-run-dirs.js";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GOLDEN_PLUGINS = join(APP_ROOT, "src/plugins/isolation/__tests__/fixtures/host-protocol/4/plugins");
const LINKED = ["package.json", "tsconfig.json", "node_modules", "schemas", "scripts", "src"];
const PLUGIN_LOG_TEXT = "the plugin is speaking through context.log";

let scratch: string;
let checkout: string;
let loggingPlugin: string;
let descendantPlugin: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "plugin-validate-source-"));
  checkout = join(scratch, "checkout");
  mkdirSync(checkout);
  for (const name of LINKED) {
    if (process.platform === "win32" && name.includes(".")) copyFileSync(join(APP_ROOT, name), join(checkout, name));
    else symlinkSync(join(APP_ROOT, name), join(checkout, name), name.includes(".") ? "file" : "junction");
  }

  descendantPlugin = join(scratch, "descendant-plugin");
  mkdirSync(descendantPlugin);
  writeFileSync(
    join(descendantPlugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "descendant-plugin",
      version: "1.0.0",
      description: "Starts a process that inherits its stderr and outlives it.",
      extensions: {
        "ai.agent-connector.ave": {
          displayName: "Descendant Plugin",
          entry: "entry.mjs",
          requires: { minAppVersion: "0.14.0", hostProtocol: "4" },
          tools: [],
        },
      },
    }),
  );
  writeFileSync(
    join(descendantPlugin, "entry.mjs"),
    `import { spawn } from "node:child_process";
export const createPlugin = async () => {
  const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  descendant.unref();
  process.stderr.write("descendant-pid=" + descendant.pid + "\\n");
  return { handlers: {} };
};
`,
  );

  loggingPlugin = join(scratch, "logging-plugin");
  mkdirSync(loggingPlugin);
  writeFileSync(
    join(loggingPlugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "logging-plugin",
      version: "1.0.0",
      description: "Logs through context.log at construct, start and in its tool.",
      extensions: {
        "ai.agent-connector.ave": {
          displayName: "Logging Plugin",
          entry: "entry.mjs",
          requires: { minAppVersion: "0.14.0", hostProtocol: "4" },
          tools: [
            {
              name: "speak",
              description: "Log a line and answer.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(loggingPlugin, "entry.mjs"),
    `export const createPlugin = async (context) => {
  context.log(${JSON.stringify(`${PLUGIN_LOG_TEXT} at construct`)});
  return {
    start: async () => context.log(${JSON.stringify(`${PLUGIN_LOG_TEXT} at start`)}),
    handlers: {
      speak: async () => {
        context.log(${JSON.stringify(`${PLUGIN_LOG_TEXT} in its tool`)});
        return "spoke";
      },
    },
  };
};
`,
  );
});

const descendantPids: number[] = [];

afterAll(async () => {
  for (const pid of descendantPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  // Windows descendants retain directory handles briefly after exit; wait before removal.
  const deadline = Date.now() + 10_000;
  while (descendantPids.some((pid) => systemProcessProbe.exists(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Remove links individually and non-recursively to avoid following junctions into the checkout.
  for (const name of LINKED) removeLinkOnly(join(checkout, name));
  await cleanupTmpDir(scratch);
});

function validate(pluginDir: string, env: NodeJS.ProcessEnv, timeout = 60_000) {
  return spawnSync("bun", ["run", "plugin:validate", pluginDir], {
    cwd: checkout,
    env,
    encoding: "utf-8",
    timeout,
  });
}

// Stdout rows contain check, ok, message and an optional path.
function reportRows(stdout: string): Array<Record<string, unknown>> {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const keys = Object.keys(row).filter((key) => key !== "path").sort();
      expect(keys).toEqual(["check", "message", "ok"]);
      return row;
    });
}

describe("bun run plugin:validate from source", () => {
  it("validates the local-indexer fixture in a checkout with no dist/", () => {
    expect(existsSync(join(checkout, "dist"))).toBe(false);
    const result = validate(join(GOLDEN_PLUGINS, "local-indexer"), process.env);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.status).toBe(0);
    const rows = reportRows(result.stdout);
    expect(rows.find((row) => row.check === "protocol.construct")?.ok).toBe(true);
  }, 60_000);

  it("exits once the report is written, although a descendant of the plugin holds its stderr", () => {
    const result = validate(descendantPlugin, process.env, 30_000);
    const descendant = Number(/descendant-pid=(\d+)/.exec(result.stderr)?.[1]);
    expect(Number.isInteger(descendant)).toBe(true);
    descendantPids.push(descendant);
    expect(() => process.kill(descendant, 0)).not.toThrow();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(reportRows(result.stdout).find((row) => row.check === "protocol.teardown")?.ok).toBe(true);
  }, 60_000);

  for (const [mode, env] of [
    ["the logger's test mode (VITEST set)", { ...process.env, VITEST: "true" }],
    [
      "the logger's pretty stream (VITEST and NODE_ENV unset)",
      Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "VITEST" && key !== "NODE_ENV"),
      ),
    ],
  ] as const) {
    it(`writes only the report to stdout under ${mode}`, () => {
      const result = validate(loggingPlugin, env);
      expect(result.status).toBe(0);
      const rows = reportRows(result.stdout);
      expect(rows.find((row) => row.check === "lifecycle.start")?.ok).toBe(true);
      expect(rows.find((row) => row.check === "tools.call:speak")?.ok).toBe(true);
      expect(result.stdout).not.toContain(PLUGIN_LOG_TEXT);
    }, 60_000);
  }
});
