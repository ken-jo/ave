/** Host-secret declarations must match the shared key grammar even with permissive schema input. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";
import {
  HOST_SECRET_READ_MAX_ITEMS,
  isAllowedHostSecretKey,
} from "../../../shared/marketplace-package-assets.js";
import manifestSchema from "../../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import {
  agentPluginsDocument,
  aveSchemaProperties,
  permissiveManifestValidatorFactory,
  pluginManifestWriter,
} from "../../__tests__/test-helpers.js";

describe("manifest hostSecrets.read[] validator (#893)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "host-secrets-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // Bypass schema strictness to exercise the host cross-field reader.
  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      hostSecrets: { type: "object" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  const writeManifest = pluginManifestWriter(
    { id: "host-secrets-test", name: "Host Secrets Test" },
    () => workDir,
  );

  it("accepts a well-formed `llm.apiKey.<vendor>` allowlist", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
    });
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets?.read).toEqual([
      "llm.apiKey.openai",
      "llm.apiKey.claude",
    ]);
  });

  it("accepts marketplace provider preset host secret keys", async () => {
    const path = await writeManifest({
      hostSecrets: {
        read: ["llm.marketplaceProvider.future-router.apiKey"],
      },
    });
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets?.read).toEqual([
      "llm.marketplaceProvider.future-router.apiKey",
    ]);
  });

  it("accepts marketplace provider preset host secret keys in the host schema", async () => {
    const validator = await buildManifestValidator();
    const valid = validator(agentPluginsDocument({
      id: "marketplace-provider-secret",
      name: "Marketplace Provider Secret Plugin",
      version: "1.0.0",
      description: "Marketplace provider secret fixture.",
      entry: "dist/index.js",
      tools: [],
      hostSecrets: {
        read: ["llm.marketplaceProvider.future-router.apiKey"],
      },
    }));
    expect(valid, JSON.stringify(validator.errors, null, 2)).toBe(true);
  });

  // The host key predicate must accept nothing the authoritative schema rejects.
  it("never accepts a hostSecrets.read key the vendored JSON schema rejects", async () => {
    const validator = await buildManifestValidator();
    const corpus = [
      "llm.apiKey.openai",
      "llm.apiKey.open-router",
      "llm.marketplaceProvider.future-router.apiKey",
      // Padded keys must not be accepted through trimming.
      "llm.marketplaceProvider.  future-router  .apiKey",
      "llm.marketplaceProvider.\tfuture-router.apiKey",
      "llm.marketplaceProvider.\nfuture-router.apiKey",
      "llm.marketplaceProvider.future router.apiKey",
      // Host checks must enforce per-item length bounds.
      `llm.apiKey.${"a".repeat(200)}`,
      "llm.apiKey.Claude",
      "webApiKey.tavily",
    ];
    for (const key of corpus) {
      const schemaAccepts = validator(agentPluginsDocument({
        id: "host-secret-corpus",
        name: "Host Secret Corpus Plugin",
        version: "1.0.0",
        description: "Host secret corpus fixture.",
        entry: "dist/index.js",
        tools: [],
        hostSecrets: { read: [key] },
      }));
      expect(isAllowedHostSecretKey(key), `key ${JSON.stringify(key)}`)
        .toBe(schemaAccepts);
    }
  });

  it("rejects a padded preset key in a manifest", async () => {
    const padded = "llm.marketplaceProvider.  future-router  .apiKey";
    expect(isAllowedHostSecretKey(padded)).toBe(false);

    const path = await writeManifest({ hostSecrets: { read: [padded] } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );
  });

  it("rejects malformed marketplace provider preset host secret keys", async () => {
    const path = await writeManifest({
      hostSecrets: {
        read: ["llm.marketplaceProvider.bad router.apiKey"],
      },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );
  });

  it("rejects a non-llm prefix with manifest_schema reason", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["webApiKey.tavily"] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*manifest_schema/,
    );
  });

  it("rejects mixed-case vendor segment", async () => {
    const path = await writeManifest({
      hostSecrets: { read: ["llm.apiKey.Claude"] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\]/,
    );
  });

  it("rejects non-string entries", async () => {
    const path = await writeManifest({
      hostSecrets: { read: [42] },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read\[0\].*must be a string/,
    );
  });

  it("rejects non-array `read`", async () => {
    const path = await writeManifest({
      hostSecrets: { read: "llm.apiKey.openai" },
    });
    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /hostSecrets\.read.*must be an array/,
    );
  });

  it("treats absent hostSecrets block as a no-op", async () => {
    const path = await writeManifest({});
    const validator = makeValidator();
    const parsed = await parsePluginJson(path, validator);
    expect(parsed.hostSecrets).toBeUndefined();
  });

  describe("manifest id policy parity", () => {
    async function writeManifestWithId(id: string): Promise<string> {
      const path = join(workDir, "plugin.json");
      await writeFile(
        path,
        JSON.stringify(agentPluginsDocument({
          id,
          name: "Id Test",
          description: "x",
          version: "1.0.0",
          entry: "dist/p.js",
          tools: [{ name: "t_one", description: "t_one tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        })));
      return path;
    }

    it("rejects dotted ids to match the authoritative kebab-case schema", async () => {
      const path = await writeManifestWithId("com.example.meeting-recorder");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /dotted ids are not allowed.*manifest_schema/,
      );
    });

    // Leading-dot IDs fail in the schema before host cross-field checks.
    it("rejects ids with leading dots", async () => {
      const path = await writeManifestWithId(".com.example.foo");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /id.*pattern/i,
      );
    });

    it("rejects ids with trailing dots (manifest_schema)", async () => {
      const path = await writeManifestWithId("com.example.foo.");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /dotted ids are not allowed.*manifest_schema/,
      );
    });

    it("rejects ids with consecutive dots (manifest_schema)", async () => {
      const path = await writeManifestWithId("com..example.foo");
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /dotted ids are not allowed.*manifest_schema/,
      );
    });
  });

  // Collection maxItems and uniqueness need their own host checks; item predicates cannot enforce them.
  describe("hostSecrets.read[] collection bounds (#1939)", () => {
    const readSchema = (
      aveSchemaProperties(manifestSchema).hostSecrets as {
        properties: { read: { maxItems?: number; uniqueItems?: boolean } };
      }
    ).properties.read;

    function distinctKeys(count: number): string[] {
      return Array.from(
        { length: count },
        (_, i) => `llm.marketplaceProvider.p${i}.apiKey`,
      );
    }

    // Keep collection limits synchronized with the schema.
    it("declares the same maxItems the vendored JSON schema declares", () => {
      expect(readSchema.maxItems).toBe(HOST_SECRET_READ_MAX_ITEMS);
      expect(readSchema.uniqueItems).toBe(true);
    });

    // Ensure generated keys pass item checks so count failures test the intended bound.
    it("generates fixture keys that are individually allowed", () => {
      for (const key of distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1)) {
        expect(isAllowedHostSecretKey(key), key).toBe(true);
      }
    });

    // The permissive validator makes these host collection checks independently observable.
    it("rejects a manifest over maxItems at the host check", async () => {
      const path = await writeManifest({
        hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1) },
      });
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /hostSecrets\.read.*entries.*manifest_schema/,
      );
    });

    it("rejects a manifest with duplicate entries at the host check", async () => {
      const path = await writeManifest({
        hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.openai"] },
      });
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /hostSecrets\.read\[1\].*duplicate.*manifest_schema/,
      );
    });

    it("rejects both bounds against the vendored schema too", async () => {
      const validator = await buildManifestValidator();
      const base = {
        id: "host-secret-bounds",
        name: "Host Secret Bounds Plugin",
        version: "1.0.0",
        description: "Host secret bounds fixture.",
        entry: "dist/index.js",
        tools: [],
      };
      expect(
        validator(agentPluginsDocument({
          ...base,
          hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS + 1) },
        })),
      ).toBe(false);
      expect(
        validator(agentPluginsDocument({
          ...base,
          hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.openai"] },
        })),
      ).toBe(false);
      expect(
        validator(agentPluginsDocument({
          ...base,
          hostSecrets: { read: distinctKeys(HOST_SECRET_READ_MAX_ITEMS) },
        })),
        JSON.stringify(validator.errors, null, 2),
      ).toBe(true);
    });
  });
});
