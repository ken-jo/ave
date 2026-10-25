/** Floating-surface refusals use stable plugin-visible codes; admitting an invalid surface puts pixels above other apps. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { pureTool, TestPluginRuntime as PluginRuntime } from "./test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { servedAgentPluginsDocument } from "./test-helpers.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";

type UiEntry = {
  id: string;
  slot: string;
  kind: string;
  title: string;
  entry?: string;
  exportName?: string;
  page?: string;
  locales?: Record<string, { displayName?: string; title?: string; description?: string }>;
};

function writePlugin(root: string, id: string, ui: UiEntry[]): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "card.js"), "export const Card = () => null;");
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify(servedAgentPluginsDocument({
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      entry: "index.mjs",
      tools: [pureTool(`${id}_noop`, ["model"])],
      ui,
    })));
  writeFileSync(join(dir, "index.mjs"), "export default () => ({ handlers: {} });");
  return join(dir, "plugin.json");
}

const FLOATING: UiEntry = {
  id: "recorder",
  slot: "floating",
  kind: "embedded-module",
  title: "Recorder",
  entry: "dist/card.js",
  exportName: "Card",
};

describe("resolveFloatingSurface", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ave-floating-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(tmp);
  });

  // The fixture ID also forms a tool name, so it must satisfy the tool-name pattern.
  // Floating admission depends on the registry, never the plugin execution arm.
  async function runtimeWith(ui: UiEntry[], id = "dockfixture") {
    const runtime = new PluginRuntime({
      hostRoot: tmp,
      manifestPaths: [writePlugin(tmp, id, ui)],
    });
    await runtime.startAll();
    return runtime;
  }

  it("resolves a declared floating module surface", async () => {
    const runtime = await runtimeWith([FLOATING]);

    const resolved = runtime.resolveFloatingSurface("dockfixture", "recorder");

    expect(resolved).toMatchObject({
      pluginId: "dockfixture",
      extensionId: "recorder",
      title: "Recorder",
    });
    // Revision-stamped imports prevent a reloaded card from serving the previous module.
    expect((resolved as { entryUrl: string }).entryUrl).toMatch(/aveRuntimeRevision=\d+/u);
  });

  it("refuses an unknown plugin", async () => {
    const runtime = await runtimeWith([FLOATING]);
    expect(runtime.resolveFloatingSurface("nope", "recorder")).toBe("unknown-plugin");
  });

  it("refuses an extension the plugin did not declare", async () => {
    const runtime = await runtimeWith([FLOATING]);
    expect(runtime.resolveFloatingSurface("dockfixture", "not-declared")).toBe("surface-not-declared");
  });

  it("refuses a sidebar surface", async () => {
    // Only a card declaring the floating slot may appear above other windows.
    const runtime = await runtimeWith([{ ...FLOATING, slot: "sidebar" }]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it.each([
    ["embedded-page", { kind: "embedded-page", page: "dist/card.js", entry: undefined, exportName: undefined }],
    ["info-card", { kind: "info-card" }],
  ])("refuses kind=%s", async (_name, override) => {
    // The dock imports an entry module; embedded-page and info-card declarations cannot render there.
    // Fixtures must pass manifest validation so the refusal comes from this resolver.
    const runtime = await runtimeWith([{ ...FLOATING, ...override } as UiEntry]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it("never sees an entry-less module surface, because the manifest is refused first", async () => {
    // Manifest validation requires embedded-module entry and exportName before floating admission.
    const runtime = await runtimeWith([
      { id: "recorder", slot: "floating", kind: "embedded-module", title: "Recorder" },
    ]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("unknown-plugin");
    expect(runtime.listPluginCards()).toHaveLength(0);
  });

  it("refuses an entry that escapes the install root", async () => {
    // A single-surface lookup must report containment violations rather than silently skip them.
    const runtime = await runtimeWith([{ ...FLOATING, entry: "../../../etc/passwd" }]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-entry-rejected");
  });

  it("keeps a floating surface out of the sidebar list", async () => {
    // listUiExtensions is for in-window panels and must exclude floating surfaces.
    const runtime = await runtimeWith([
      { ...FLOATING, id: "recorder", slot: "floating" },
      { ...FLOATING, id: "settings", slot: "sidebar", title: "Settings" },
    ]);

    const listed = runtime.listUiExtensions();
    expect(listed.map((row) => row.extension.id)).toEqual(["settings"]);
    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({
      extensionId: "recorder",
    });
  });

  it("picks the named extension out of several", async () => {
    const runtime = await runtimeWith([
      { ...FLOATING, id: "levels", title: "Levels" },
      { ...FLOATING, id: "recorder", title: "Recorder" },
    ]);

    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({
      extensionId: "recorder",
      title: "Recorder",
    });
  });

  it("titles the slot in the current UI language", async () => {
    const runtime = await runtimeWith([
      { ...FLOATING, title: "녹음기", locales: { en: { title: "Recorder" } } },
    ]);
    const suiteLocale = getLocale();
    try {
      setLocale("en");
      expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({ title: "Recorder" });
      setLocale("ko");
      expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toMatchObject({ title: "녹음기" });
    } finally {
      setLocale(suiteLocale);
    }
  });

  it("does not let a sidebar entry answer for a floating id of the same name", async () => {
    // Duplicate IDs in different slots must resolve independently of declaration order.
    const runtime = await runtimeWith([
      { ...FLOATING, id: "recorder", slot: "sidebar" },
      { ...FLOATING, id: "recorder", slot: "floating" },
    ]);

    expect(runtime.resolveFloatingSurface("dockfixture", "recorder")).toBe("surface-not-floating");
  });

  it("answers from the registry alone, never from routing", () => {
    // Floating admission must be independent of the generation execution arm.
    // Read by path: a URL read creates an unused-export dependency edge.
    const source = readFileSync(
      join(__dirname, "..", "runtime", "index.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("  resolveFloatingSurface("),
      source.indexOf("  listUiExtensions("),
    );
    // A nonempty slice prevents an unmatched source anchor from making assertions vacuous.
    expect(body).toContain("return \"unknown-plugin\";");
    expect(body).toContain("this.plugins.get(pluginId)");
    // Routing facts must not decide whether a surface may float.
    for (const routing of [/\.arm\b/u, /\bconfinement\b/u, /importPluginFactoryForLifecycle/u, /\bPluginLoadArm\b/u]) {
      expect(body, `${routing.source} must not decide whether a surface may float`)
        .not.toMatch(routing);
    }
  });
});
