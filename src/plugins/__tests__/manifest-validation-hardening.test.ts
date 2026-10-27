import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  pureTool,
  TestPluginRuntime as PluginRuntime,
} from "./test-helpers.js";
import { agentPluginsDocument, servedAgentPluginsDocument } from "./test-helpers.js";
import { buildManifestValidator, parsePluginJson } from "../runtime/manifest-validation.js";

/** An extension namespace Ave does not own: another vendor's data, never Ave fields. */
const UNKNOWN_NAMESPACE = "xyz.example";

describe("runtime manifest validation hardening", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-manifest-hardening-"));
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(
    id: string,
    manifestOverrides: Record<string, unknown> = {},
    entrySource?: string,
  ): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const defaultEntry = `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${id}_hello": async () => "hi",
      "${id}_bad": async () => { throw new Error("boom"); },
      "${id}_good": async () => "ok",
    },
    start: async () => {},
    stop: async () => {},
  };
}`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      entrySource ?? defaultEntry,
      "utf-8",
    );
    const overrideTools = Array.isArray(manifestOverrides.tools)
      ? manifestOverrides.tools
      : [`${id}_hello`, `${id}_bad`, `${id}_good`];
    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      entry: "entry.mjs",
      ...manifestOverrides,
      tools: overrideTools.map((tool) =>
        typeof tool === "string" ? pureTool(tool) : tool,
      ),
    };
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify(servedAgentPluginsDocument(manifest)),
      "utf-8");
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function captureErrors(): {
    errors: string[];
    warns: string[];
    restore: () => void;
  } {
    const errors: string[] = [];
    const warns: string[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (msg: unknown) => errors.push(String(msg));
    console.warn = (msg: unknown, ..._rest: unknown[]) =>
      warns.push(String(msg));
    return {
      errors,
      warns,
      restore: () => {
        console.error = origErr;
        console.warn = origWarn;
      },
    };
  }

  it("rejects the removed keyword-to-tool preload field", async () => {
    await writePlugin("p-kw", {
      tools: ["pkw_hello", "pkw_bad", "pkw_good"],
      keywords: [{ keyword: "회의", skillId: "p_kw_missing" }],
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toHaveLength(0);
    expect(cap.errors.some((e) => /keywords|additional/i.test(e))).toBe(true);
  });

  it("rejects the removed top-level schema map", async () => {
    await writePlugin("p-ts", {
      tools: ["pts_hello", "pts_bad", "pts_good"],
      toolSchemas: {
        p_ts_ghost: {
          description: "ghost tool description here",
          category: "read",
          inputSchema: { type: "object", properties: {} },
        },
      },
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-ts");
    expect(cap.errors.some((e) => /toolSchemas|additional/i.test(e))).toBe(
      true,
    );
  });

  it("3) retired notification declarations drop with a warning and the plugin still loads", async () => {
    await writePlugin("p-notif", {
      tools: ["pnotif_hello", "pnotif_bad", "pnotif_good"],
      eventSubscriptions: ["meeting.started"],
      notificationEvents: [{ event: "meeting.ghost" }],
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).toContain("p-notif");
    expect(runtime.listPluginManifests()[0]?.manifest).not.toHaveProperty("notificationEvents");
    expect(
      cap.warns.some((w) =>
        /ignoring retired field\(s\) notificationEvents/.test(w),
      ),
    ).toBe(true);
  });

  it("4) ui[] invalid entry fails load instead of dropping entries", async () => {
    await writePlugin("p-ui", {
      tools: ["pui_hello", "pui_bad", "pui_good"],
      ui: [
        {
          id: "a",
          slot: "sidebar",
          kind: "embedded-module",
          title: "A",
          entry: "dist/a.js",
        },
        { id: "b", slot: "sidebar", kind: "info-card", title: "B" },
        {
          id: "c",
          slot: "sidebar",
          kind: "embedded-page",
          title: "C",
          page: "dist/c.html",
        },
      ],
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-ui");
    expect(
      cap.errors.some((e) =>
        /ui\[0\].*kind="embedded-module" missing required field\(s\): exportName/.test(
          e,
        ),
      ),
    ).toBe(true);
  });

  it("4b) ui[] non-plain-object entries fail load instead of being dropped", async () => {
    await writePlugin("p-ui-bad", {
      tools: ["puibad_hello", "puibad_bad", "puibad_good"],
      ui: [
        [],
        123,
        null,
        { id: "z", slot: "sidebar", kind: "info-card", title: "Z" },
      ],
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-ui-bad");
    expect(cap.errors.some((e) => /ui\[0\].*must be an object/.test(e))).toBe(
      true,
    );
  });

  // Unknown root fields must fail schema validation; the host drops the offending plugin and continues.
  it("5) AJV rejects manifest with unknown root property (startupTools post 5.7.0)", async () => {
    await writePlugin("p-unknown-field", {
      tools: ["puf_hello", "puf_bad", "puf_good"],
      startupTools: ["p_unknown_field_hello"],
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-unknown-field");
    expect(
      cap.errors.some((e) => /additional|unknown|startupTools/i.test(e)),
    ).toBe(true);
  });

  // Manifest refusals must emit plugin_manifest_rejected so operators can identify the plugin and cause.
  it("6) auditLog emits plugin_manifest_rejected on manifest reject", async () => {
    await writePlugin("p-audit-target", {
      tools: ["pat_hello", "pat_bad", "pat_good"],
      startupTools: ["p_audit_target_hello"],
    });
    const auditLog = vi.fn();
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      auditLog,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-audit-target");
    const rejected = auditLog.mock.calls.find(
      (call) => call[1] === "plugin_manifest_rejected",
    );
    expect(rejected).toBeTruthy();
    expect(rejected?.[0]).toBe("error");
    const data = rejected?.[2] as { manifestPath: string; error: string };
    expect(data.manifestPath).toContain("p-audit-target");
    expect(data.error).toMatch(/additional|startupTools|schema/i);
  });

  // Structured author fields must remain bounded because manifests feed catalog and editor surfaces.
  it("7) accepts a bounded portable author and rejects an unbounded one", async () => {
    await writePlugin("p-author-ok", {
      tools: ["pao_hello"],
      author: { name: "Maintainer", email: "m@example.com", url: "https://example.com" },
      homepage: "https://example.com/plugin",
      license: "MIT",
      keywords: ["email"],
    });
    const okRuntime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const okCapture = captureErrors();
    try {
      await okRuntime.load();
    } finally {
      okCapture.restore();
    }
    expect(okRuntime.listPluginIds()).toContain("p-author-ok");

    await writePlugin("p-author-long", {
      tools: ["pal_hello"],
      author: { name: "x".repeat(257) },
    });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    const cap = captureErrors();
    try {
      await runtime.load();
    } finally {
      cap.restore();
    }
    expect(runtime.listPluginIds()).not.toContain("p-author-long");
  });
});

/** Process-entry refusals must identify the invalid command, argument, environment or version field. */
describe("runtime manifest validation of a process entry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-process-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const PROCESS = {
    command: "./bin/plugin",
    args: ["${PLUGIN_ROOT}/vendor", "--x=1"],
    env: { SMOKE_VENDOR_DIR: "${PLUGIN_ROOT}/vendor" },
  };

  async function parse(overrides: {
    process?: unknown;
    entry?: unknown;
    requires?: Record<string, unknown>;
  }): Promise<unknown> {
    const manifest: Record<string, unknown> = {
      id: "process-kit",
      name: "Process Kit",
      version: "1.0.0",
      description: "A process entry fixture.",
      tools: [pureTool("process_kit_ping")],
      requires: overrides.requires ?? { minAppVersion: "0.13.0", hostProtocol: "4" },
    };
    if ("process" in overrides) manifest.process = overrides.process;
    if ("entry" in overrides) manifest.entry = overrides.entry;
    const path = join(dir, "plugin.json");
    await writeFile(path, JSON.stringify(agentPluginsDocument(manifest)), "utf-8");
    return parsePluginJson(path, await buildManifestValidator());
  }

  it("admits a process entry with root-anchored arguments, a declared variable and the version floor", async () => {
    await expect(parse({ process: PROCESS })).resolves.toMatchObject({ process: PROCESS });
  });

  it("refuses a process extension declared only under an unknown namespace, and admits one beside the Ave key", async () => {
    const document = agentPluginsDocument({
      id: "process-kit", name: "Process Kit", version: "1.0.0", description: "A process entry fixture.",
      tools: [pureTool("process_kit_ping")], process: PROCESS, requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
    }) as Record<string, unknown> & { extensions: Record<string, unknown> };
    const ave = document.extensions["ai.agent-connector.ave"];
    const path = join(dir, "plugin.json");
    await writeFile(path, JSON.stringify({ ...document, extensions: { [UNKNOWN_NAMESPACE]: ave } }), "utf-8");
    await expect(parsePluginJson(path, await buildManifestValidator())).rejects.toThrow(
      `Invalid plugin manifest 'process-kit' at 'extensions["ai.agent-connector.ave"].entry' (${path}): must be a non-empty relative path to the plugin ESM entry, or declare 'process' instead.`,
    );
    await writeFile(path, JSON.stringify({ ...document, extensions: { "ai.agent-connector.ave": ave, [UNKNOWN_NAMESPACE]: {} } }), "utf-8");
    await expect(parsePluginJson(path, await buildManifestValidator())).resolves.toMatchObject({ process: PROCESS });
  });

  it.each([
    ["a bare command", { ...PROCESS, command: "plugin" }],
    ["an absolute command", { ...PROCESS, command: "/usr/bin/python3" }],
    ["a command segment containing '='", { ...PROCESS, command: "./bin/a=b" }],
  ])("refuses %s at the schema, naming the command", async (_name, process) => {
    await expect(parse({ process })).rejects.toThrow(/\/extensions\/ai\.agent-connector\.ave\/process\/command must match pattern/u);
  });

  it.each([
    ["a '..' segment in an argument", ["${PLUGIN_ROOT}/../outside"], /process\.args\[0\].*not a contained relative path/u],
    ["a ${HOME} token in an argument", ["${HOME}/x"], /process\.args\[0\].*placeholder/u],
    ["an argument literal that looks like a path", ["./vendor"], /process\.args\[0\].*looks like a path/u],
  ])("refuses %s, naming the argument", async (_name, args, message) => {
    await expect(parse({ process: { ...PROCESS, args } })).rejects.toThrow(message);
  });

  it.each(["BASH_ENV", "LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "PLUGIN_ROOT", "PLUGIN_DATA", "Path", "plugin_root"])(
    "refuses %s as an environment name, naming it",
    async (name) => {
      await expect(parse({ process: { ...PROCESS, env: { [name]: "x" } } })).rejects.toThrow(
        new RegExp(`extensions\\["ai\\.agent-connector\\.ave"\\]\\.process\\.env\\.${name}'.*reserves`, "u"),
      );
    },
  );

  it("refuses a placeholder other than the two in an environment value", async () => {
    await expect(parse({ process: { ...PROCESS, env: { SMOKE_VENDOR_DIR: "${HOME}/vendor" } } }))
      .rejects.toThrow(/process\.env\.SMOKE_VENDOR_DIR.*placeholder/u);
  });

  it.each([
    ["0.12.0", { minAppVersion: "0.12.0", hostProtocol: "4" }],
    ["no minAppVersion", { hostProtocol: "4" }],
  ])("refuses %s, naming requires.minAppVersion", async (_name, requires) => {
    await expect(parse({ process: PROCESS, requires })).rejects.toThrow(/requires\.minAppVersion.*0\.13\.0 or newer/u);
  });

  it("refuses both entry and process", async () => {
    await expect(parse({ process: PROCESS, entry: "dist/index.js" })).rejects.toThrow(/schema validation failed/u);
  });

  it("refuses neither entry nor process when the plugin declares tools", async () => {
    await expect(parse({})).rejects.toThrow(/schema validation failed/u);
  });
});
