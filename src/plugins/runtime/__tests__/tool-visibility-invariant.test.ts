/** Tool visibility determines governed dispatch; app-only declarations must never widen trusted bypass authority. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson,
} from "../manifest-validation.js";
import { pureTool } from "../../__tests__/test-helpers.js";
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";

describe("#885 v6 — dual-declared visibility (the #1554 governed-vs-bypass invariant)", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tools-visibility-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>,
  ): Promise<string> {
    const path = join(workDir, "plugin.json");
    const { tools, ...restExtra } = extra as {
      tools?: unknown[];
    } & Record<string, unknown>;
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "overlap-test",
        name: "Overlap Test",
        description: "x",
        version: "1.0.0",
        entry: "dist/p.js",
        ...restExtra,
        tools: (tools ?? []).map((tool) =>
          typeof tool === "string" ? pureTool(tool, ["model"]) : tool,
        ),
      })));
    return path;
  }

  it("preserves model, app, and dual Tool visibility", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: [
        pureTool("shared_method", ["model", "app"], {
          description: "dual-visible",
        }),
        pureTool("t_one", ["model"]),
        pureTool("ui_only_method", ["app"]),
      ],
      // Omit auth to cover ordinary app-only tools.
    });
    const manifest = await parsePluginJson(path, validator);
    expect(manifest.tools.find((t) => t.name === "shared_method")?._meta?.ui?.visibility,
    ).toEqual([
      "model",
      "app"]);
    expect(manifest.tools.find((t) => t.name === "t_one")?._meta?.ui?.visibility,
    ).toEqual(["model"]);
    expect(manifest.tools.find((t) => t.name === "ui_only_method")?._meta?.ui?.visibility,
    ).toEqual([
      "app"]);
  });

  it("REJECTS an auth tool that resolves model-visible (the #1554 'auth never model-callable' invariant)", async () => {
    const validator = await buildManifestValidator();
    const path = await writeManifest({
      tools: [
        pureTool("ms_status", ["model", "app"]),
        pureTool("ms_login", ["app"]),
        pureTool("shared_method", ["model", "app"], { description: "dual-visible non-auth",
      }),
      ],
      auth: { statusTool: "ms_status", loginTool: "ms_login" },
      emittedEvents: ["overlap-test.auth.changed"],
    });
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /must have visibility exactly \["app"\]/,
    );
  });
});
