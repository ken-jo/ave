/** Declared auth tools must be app-only; see architecture.md §9.4a. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parsePluginJson } from "../runtime/manifest-validation.js";
import { pureTool } from "./test-helpers.js";
import { agentPluginsDocument } from "./test-helpers.js";

// Compile the real schema directly so test-location path resolution cannot silently disable validation.
let TEST_VALIDATOR: ValidateFunction | null = null;
beforeAll(() => {
  const schemaPath = fileURLToPath(
    new URL("../../../schemas/plugin-manifest.schema.json", import.meta.url),
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const AjvAny = AjvModule as unknown as { default?: unknown };
  const AjvCtor = (AjvAny.default ?? AjvModule) as new (opts?: unknown) => {
    compile: (schema: unknown) => ValidateFunction;
  };
  const ajv = new AjvCtor({
    strict: true,
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  // Assert compile is callable so module interop cannot turn schema assertions into no-ops.
  if (typeof ajv.compile !== "function") {
    throw new Error(
      "[manifest-auth.test] Ajv constructor cast did not yield a working ajv instance",
    );
  }
  const AddAny = AddFormatsModule as unknown as { default?: unknown };
  const addFormatsFn = (AddAny.default ?? AddFormatsModule) as (a: unknown,
  ) => void;
  if (typeof addFormatsFn !== "function") {
    throw new Error(
      "[manifest-auth.test] addFormats default cast did not yield a callable",
    );
  }
  addFormatsFn(ajv);
  TEST_VALIDATOR = ajv.compile(schema);
});

describe("manifest validation — auth cross-field", () => {
  let testDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-auth-manifest-"));
    manifestPath = join(testDir, "plugin.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeManifest(extra: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "auth fixture",
      entry: "dist/hostPlugin.js",
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
      ...extra,
    };
    merged.tools = Array.isArray(merged.tools)
      ? merged.tools.map((tool) => typeof tool === "string" ? pureTool(tool, ["model"])
      : tool,
        )
      : [];
    await mkdir(testDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(agentPluginsDocument(merged), null, 2), "utf-8");
  }

  it("accepts a manifest whose auth Tools are app-only", async () => {
    await writeManifest({
      auth: {
        label: "Test Account",
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.statusTool).toBe("test_status");
    expect(parsed.auth?.loginTool).toBe("test_login");
    expect(parsed.auth?.logoutTool).toBe("test_signout");
  });

  it("accepts manifest with auth omitting optional logoutTool", async () => {
    await writeManifest({
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.logoutTool).toBeUndefined();
  });

  it("#885 v6 — rejects auth.statusTool that resolves to no declared tool", async () => {
    await writeManifest({
      tools: [
        pureTool("test_login", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.statusTool.*not declared in tools\[\]/,
    );
  });

  it("#885 v6 — rejects auth.loginTool that resolves to no declared tool", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_signout", ["app"]),
      ],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.loginTool.*not declared in tools\[\]/,
    );
  });

  it("#885 v6 — rejects auth.logoutTool that resolves to no declared tool when declared", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["app"]),
      ],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth\.logoutTool.*not declared in tools\[\]/,
    );
  });

  it("AJV rejects auth missing required statusTool", async () => {
    await writeManifest({
      auth: {
        loginTool: "test_login",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /schema validation/i,
    );
  });

  it("AJV rejects auth with extra properties (additionalProperties: false)", async () => {
    await writeManifest({
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        nonsenseField: "boom",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /schema validation/i,
    );
  });

  it("R3 — does NOT warn when emittedEvents omits ${id}.auth.changed (host auto-derives the bridge)", async () => {
    // The host derives the literal <manifest.id>.auth.changed event from auth; no explicit declaration is required.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
          logoutTool: "test_signout",
        },
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when emittedEvents includes the expected ${id}.auth.changed entry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
        },
        emittedEvents: ["test-plugin.auth.changed"],
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("R3 — does NOT warn even when emittedEvents declares the WRONG (underscore) form (#131 class eliminated)", async () => {
    // Auth events use the dashed manifest ID even when tool names use underscores.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
        },
        emittedEvents: ["test_plugin.auth.changed"],
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("emittedEvents[] is missing")),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when manifest does not declare auth (don't pollute non-auth plugins)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("auth.changed"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Tool names grant no authority; app visibility and normal host permissions still apply.
  it("does not currently reject destructive-looking tool names in auth (host posture is plugin-author responsibility per §2.2)", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_email_delete", ["app"]),
      ],
      auth: {
        statusTool: "test_status",
        loginTool: "test_email_delete",
      },
    });
    const validator = TEST_VALIDATOR;
    const parsed = await parsePluginJson(manifestPath, validator);
    expect(parsed.auth?.loginTool).toBe("test_email_delete");
  });

  // Auth tools are app-only lifecycle operations and must never be model-visible.
  it("rejects a model-visible auth Tool", async () => {
    await writeManifest({
      tools: [
        pureTool("test_status", ["app"]),
        pureTool("test_login", ["model", "app"]),
        pureTool("test_signout", ["app"]),
      ],
      emittedEvents: ["test-plugin.auth.changed"],
      auth: {
        statusTool: "test_status",
        loginTool: "test_login",
        logoutTool: "test_signout",
      },
    });
    const validator = TEST_VALIDATOR;
    await expect(parsePluginJson(manifestPath, validator)).rejects.toThrow(
      /auth tool.*must not appear in tools\[\]|'test_login'/,
    );
  });

  it("does not warn when auth Tools are app-only", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await writeManifest({
        tools: [
          pureTool("test_other", ["model"]),
          pureTool("test_status", ["app"]),
          pureTool("test_login", ["app"]),
          pureTool("test_signout", ["app"]),
        ],
        emittedEvents: ["test-plugin.auth.changed"],
        auth: {
          statusTool: "test_status",
          loginTool: "test_login",
          logoutTool: "test_signout",
        },
      });
      const validator = TEST_VALIDATOR;
      await parsePluginJson(manifestPath, validator);
      const warnMessages = warnSpy.mock.calls.map((c) => c.join(" "));
      expect(warnMessages.some((m) => m.includes("must not be LLM-callable")),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

});
