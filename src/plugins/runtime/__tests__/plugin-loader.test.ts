/** The method map binds only own function handlers, whatever names the manifest declares. */
import { describe, expect, it } from "vitest";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import { buildMethodMap } from "../plugin-loader.js";

function declaring(...names: string[]): Pick<PluginManifest, "tools"> {
  return {
    tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })),
  };
}

function bind(manifest: Pick<PluginManifest, "tools">, instance: RuntimePlugin) {
  const missing: string[] = [];
  const methods = buildMethodMap(manifest, instance, (toolName) => void missing.push(toolName));
  return { methods: [...methods], missing };
}

describe("buildMethodMap", () => {
  it("binds an in-process handlers object, and reports declared names only its prototype answers", () => {
    const speak = async () => "spoke";
    const { methods, missing } = bind(
      declaring("speak", "constructor", "toString", "valueOf", "__proto__"),
      { handlers: { speak } },
    );
    expect(methods).toEqual([["speak", speak]]);
    expect(missing).toEqual(["constructor", "toString", "valueOf", "__proto__"]);
  });

  it("reports an own entry that is not a function", () => {
    const { methods, missing } = bind(
      declaring("speak"),
      { handlers: { speak: "not a function" } } as unknown as RuntimePlugin,
    );
    expect(methods).toEqual([]);
    expect(missing).toEqual(["speak"]);
  });
});
