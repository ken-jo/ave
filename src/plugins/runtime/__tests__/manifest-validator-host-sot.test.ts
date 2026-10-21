/**
 * Host-owned manifest validator SOT guard (ph2).
 *
 * The host compiles its OWN vendored `schemas/plugin-manifest.schema.json`
 * (imported as a bundler-visible JSON module) with AJV. This suite pins:
 *   1. the validator compiles + accepts every host-required field,
 *   2. the negative-strictness guards (formerly runtime probes, now test-time
 *      assertions per ph2) still REJECT removed / unreachable / removed-ui shapes,
 *   3. fail-closed semantics when AJV cannot compile the schema,
 *   4. schema ↔ types ↔ parsePluginJson coherence on a full-featured manifest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifestValidator,
  formatUnknownErrorMessage,
  parsePluginJson,
} from "../manifest-validation.js";
import type { PluginManifest } from "../../types.js";
import { MCP_APP_PERMISSION_FEATURES } from "../../../shared/mcp-app-permissions.js";
import manifestSchema from "../../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";
import { MAX_PLUGIN_ONBOARDING_HIGHLIGHTS } from "../../public-contract.js";
import { TOOL_NAME_PATTERN, isValidToolName } from "../../../tools/types.js";

/** A `_meta` vendor prefix the host does not own; the schema refuses it on a tool. */
const UNKNOWN_META_PREFIX = "xyz.example/";

const CRLF_GUARD_PATTERN = "[\\r\\n]";

function patternNodesMissingCrlfGuard(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      patternNodesMissingCrlfGuard(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];

  const node = value as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof node.pattern === "string" && node.pattern !== "(^|\\.)xn--") {
    const negative = node.not;
    if (
      negative === null
      || typeof negative !== "object"
      || Array.isArray(negative)
      || (negative as Record<string, unknown>).pattern !== CRLF_GUARD_PATTERN
    ) {
      missing.push(path);
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "not") {
      missing.push(...patternNodesMissingCrlfGuard(child, `${path}.${key}`));
    }
  }
  return missing;
}

function manifestWithOnboarding(onboarding: Record<string, unknown>,
): Record<string, unknown> {
  return agentPluginsDocument({
    id: "sample-onboarding-plugin",
    name: "Sample Onboarding Plugin",
    version: "1.0.0",
    description: "Synthetic manifest used to validate declarative onboarding.",
    entry: "dist/index.js",
    tools: [],
    onboarding,
  });
}

function manifestWithFirstTask(firstTask: Record<string, unknown>,
): Record<string, unknown> {
  return manifestWithOnboarding({ firstTask });
}

const validFirstTask = {
  priority: 10,
  locales: {
    en: {
      headline: "Try the sample plugin",
      body: "Prefill a visible prompt without invoking a tool.",
      actionLabel: "Prefill",
      composerPrompt: "Help me use the sample plugin",
    },
  },
};

describe("buildManifestValidator — host-owned schema SOT (ph2)", () => {
  it("enforces the same tools[].name grammar the schema pins", () => {
    // Narrowed to the ONE definition this reads. A `Record` over every
    // definition stopped overlapping once a definition without `properties`
    // landed (`pluginOnboardingAction` is a `oneOf`), and widening the record
    // to make that assignable would stop typing what is actually read.
    const toolDefinition = (manifestSchema as {
      definitions: { tool: { properties: Record<string, { pattern?: string }> } };
    }).definitions.tool;
    expect(toolDefinition.properties.name.pattern).toBe(TOOL_NAME_PATTERN.source);
    expect(isValidToolName("sample_tool")).toBe(true);
    expect(isValidToolName("_private")).toBe(true);
    expect(isValidToolName("sample.tool")).toBe(false);
    expect(isValidToolName("sample-tool")).toBe(false);
    expect(isValidToolName("1st")).toBe(false);
    expect(isValidToolName(undefined)).toBe(false);
  });

  it("compiles the host schema into a working validator", async () => {

    const validator = await buildManifestValidator();
    expect(typeof validator).toBe("function");
  });

  it("rejects terminal CR/LF at every pattern-constrained manifest field", async () => {
    expect(patternNodesMissingCrlfGuard(manifestSchema)).toEqual([]);

    const validator = await buildManifestValidator();
    const base = {
      id: "line-safe-plugin",
      version: "1.0.0",
      description: "Terminal line fixture.",
      entry: "dist/index.js",
      tools: [],
    };
    expect(validator(agentPluginsDocument({ ...base, id: "line-safe-plugin\n" }))).toBe(false);
    expect(validator(agentPluginsDocument({
      ...base,
      requires: { minAppVersion: "1.0.0\r" },
    }))).toBe(false);
  });

  it("accepts structured plugin-owned Skill, Hook, and MCP declarations", async () => {
    const validator = await buildManifestValidator();
    expect(validator(agentPluginsDocument({
      id: "atomic-bundle-plugin",
      version: "1.0.0",
      description: "Atomic contribution bundle fixture.",
      entry: "dist/index.js",
      tools: [],
      skills: [{ id: "checkin", path: "skills/checkin" }],
      hooks: [{ id: "audit", path: "hooks/audit.json" }],
      mcpServers: [{ id: "portal", path: "mcp/portal.json" }],
    })),
    ).toBe(true);
  });

  it("rejects malformed contribution declarations and unknown fields", async () => {
    const validator = await buildManifestValidator();
    expect(validator(agentPluginsDocument({
      id: "atomic-bundle-plugin",
      version: "1.0.0",
      description: "Atomic contribution bundle fixture.",
      entry: "dist/index.js",
      tools: [],
      skills: [{ id: "invalid-id", path: "skills/checkin", trust: true }],
    })),
    ).toBe(false);
    expect(validator.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: "additionalProperties" }),
      expect.objectContaining({ keyword: "pattern" }),
    ]),
    );
  });

  it("rejects retired parallel UI and operation-governance fields", async () => {
    const validator = await buildManifestValidator();
    const base = {
      id: "retired-parallel-fields",
      version: "1.0.0",
      description: "Retired parallel manifest field fixture.",
      entry: "dist/index.js",
      tools: [],
    };

    for (const field of [
      "uiTool",
      "uiTools",
      "uiAction",
      "uiActions",
      "operationGovernance",
      "appAllowed",
    ]) {
      expect(validator(agentPluginsDocument({ ...base, [field]: {} })), field).toBe(false);
      expect(validator.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: field }),
        }),
      ]),
      );
    }

    expect(validator(agentPluginsDocument({
      ...base,
      tools: [{
        name: "legacy_governed",
        inputSchema: {
          type: "object",
          properties: { operation: { type: "string", const: "status" } },
          required: ["operation"],
        },
        _meta: {
          "ave/operationPolicy": {
            discriminant: "operation",
            appAllowed: ["status"],
            operations: {
              status: { kind: "read", minimumRisk: "read" },
            },
          },
        },
      },
        ],
    })),
    ).toBe(false);
    expect(validator.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        keyword: "additionalProperties",
        params: expect.objectContaining({ additionalProperty: "appAllowed" }),
      }),
    ]),
    );
  });

  // ── accept-probes against the host-compiled validator ────────────────────
  it("accepts a pure MCP Tool[] object carrying _meta.ui.visibility", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "pure-tool-plugin",
        name: "Pure Tool Plugin",
        version: "1.0.0",
        description: "Pure MCP Tool object fixture.",
        entry: "dist/index.js",
        tools: [
          {
            name: "pure_ping",
            description: "Pure ping tool fixture.",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      })),
    ).toBe(true);
  });

  it("accepts a complete declarative first task", async () => {
    const validator = await buildManifestValidator();
    expect(validator(manifestWithFirstTask(validFirstTask))).toBe(true);
  });

  it.each([
    ["missing priority", { locales: validFirstTask.locales }],
    ["missing English fallback", {
      ...validFirstTask,
      locales: { ko: validFirstTask.locales.en },
    },
    ],
    ["invalid locale key", {
      ...validFirstTask,
      locales: { ...validFirstTask.locales, en_US: validFirstTask.locales.en,
        },
    },
    ],
    ["oversized locale key", {
      ...validFirstTask,
      locales: {
        ...validFirstTask.locales,
        [`en-${"segment-".repeat(5)}us`]: validFirstTask.locales.en,
        },
      },
    ],
    ["out-of-range priority", { ...validFirstTask, priority: 1001 }],
    ["unknown executable field", { ...validFirstTask, autoSubmit: true }],
    [
      "incomplete localized copy",
      {
        ...validFirstTask,
        locales: { en: { headline: "Incomplete" } },
      },
    ],
    [
      "oversized composer prompt",
      {
        ...validFirstTask,
        locales: {
          en: { ...validFirstTask.locales.en, composerPrompt: "x".repeat(513) },
        },
      },
    ],
  ])("rejects malformed onboarding: %s", async (_name, firstTask) => {
    const validator = await buildManifestValidator();
    expect(validator(manifestWithFirstTask(firstTask))).toBe(false);
  });

  it("accepts declared onboarding highlights alongside a first task", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(manifestWithOnboarding({
        firstTask: validFirstTask,
        highlights: [
          {
            id: "pick-a-folder",
            priority: 20,
            copy: {
              en: {
                headline: "Choose a folder to index",
                body: "Name one folder and search it in plain language.",
                actionLabel: "Choose a folder",
              },
            },
            action: { kind: "composer", prompt: "Add a folder to index" },
          },
          {
            id: "open-the-settings",
            copy: {
              en: {
                headline: "Set the scan schedule",
                body: "Decide when the index refreshes.",
                actionLabel: "Open settings",
              },
            },
            action: { kind: "settings", path: "plugin-config" },
          },
          {
            id: "nothing-to-do",
            copy: {
              en: {
                headline: "Search now understands dates",
                body: "Ask for last week and it means last week.",
                actionLabel: "Got it",
              },
            },
            action: { kind: "none" },
          },
        ],
      })),
    ).toBe(true);
  });

  const validHighlight = {
    id: "pick-a-folder",
    copy: {
      en: {
        headline: "Choose a folder to index",
        body: "Name one folder and search it in plain language.",
        actionLabel: "Choose a folder",
      },
    },
    action: { kind: "none" },
  };

  it.each([
    ["missing copy", { id: "pick-a-folder", action: { kind: "none" } }],
    ["missing action", { id: "pick-a-folder", copy: validHighlight.copy }],
    ["missing id", { copy: validHighlight.copy, action: { kind: "none" } }],
    ["non-kebab id", { ...validHighlight, id: "Pick_A_Folder" }],
    ["missing English fallback", {
      ...validHighlight,
      copy: { ko: { headline: "h", body: "b", actionLabel: "a" } },
    }],
    ["composer action without a prompt", {
      ...validHighlight,
      action: { kind: "composer" },
    }],
    ["settings action without a path", {
      ...validHighlight,
      action: { kind: "settings" },
    }],
    // Every path segment opens with a letter. The schema shapes the string
    // before the host resolves it against the tabs and sections it ships, so a
    // spelling no registry id could ever carry is refused one layer earlier.
    ["settings action whose tab segment opens with a digit", {
      ...validHighlight,
      action: { kind: "settings", path: "2fa" },
    }],
    ["settings action whose section segment opens with a digit", {
      ...validHighlight,
      action: { kind: "settings", path: "llm/2fa" },
    }],
    ["settings action naming a bare separator", {
      ...validHighlight,
      action: { kind: "settings", path: "-" },
    }],
    ["unknown action kind", { ...validHighlight, action: { kind: "run-tool" } }],
    ["action carrying an extra field", {
      ...validHighlight,
      action: { kind: "none", autoSubmit: true },
    }],
    ["a composerPrompt smuggled into highlight copy", {
      ...validHighlight,
      copy: {
        en: { ...validHighlight.copy.en, composerPrompt: "do the thing" },
      },
    }],
  ])("rejects malformed onboarding highlight: %s", async (_name, highlight) => {
    const validator = await buildManifestValidator();
    expect(validator(manifestWithOnboarding({ highlights: [highlight] }))).toBe(false);
  });

  it("rejects more highlights than a plugin may declare", async () => {
    const validator = await buildManifestValidator();
    const tooMany = Array.from({ length: MAX_PLUGIN_ONBOARDING_HIGHLIGHTS + 1 }, (_, i) => ({
      ...validHighlight,
      id: `highlight-${i}`,
    }));
    expect(validator(manifestWithOnboarding({ highlights: tooMany }))).toBe(false);
  });

  it("REJECTS a tool _meta carrying pathFields under an unknown vendor prefix (fail-closed)", async () => {
    // Tool `_meta` is `additionalProperties:false`: the host owns only `ave/*`
    // (and `ui`), so a manifest declaring pathFields under any other prefix is
    // REJECTED at the load-time schema gate — it is NOT silently accepted with
    // the security-bearing pathFields ignored (that would be fail-OPEN: the
    // permission gate would stop seeing the plugin's filesystem effects). This is
    // the schema half of the Doctor safety net: rejection → `manifest_schema`
    // → `manifest-validation-error` → reinstall.
    const validator = await buildManifestValidator();
    const result = validator(agentPluginsDocument({
      id: "unknown-meta-plugin",
      name: "Unknown Meta Plugin",
      version: "1.0.0",
      description: "Unknown-vendor _meta pathFields fixture.",
      entry: "dist/index.js",
      tools: [
        {
          name: "unknown_export",
          description: "Export to a path.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
          _meta: {
            ui: { visibility: ["model"] },
            [`${UNKNOWN_META_PREFIX}pathFields`]: ["path"],
          },
        },
      ],
    }));
    expect(result).toBe(false);
    // The rejection specifically names the unknown key as the disallowed
    // additional property (not some unrelated failure).
    expect(validator.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({
            additionalProperty: `${UNKNOWN_META_PREFIX}pathFields`,
          }),
        }),
      ]),
    );
  });

  it("REJECTS retired pluginAccess.plugins[].tools grants (fail-closed)", async () => {
    const validator = await buildManifestValidator();
    const result = validator(agentPluginsDocument({
      id: "retired-plugin-access-tool-grant",
      name: "Retired Plugin Access Tool Grant",
      version: "1.0.0",
      description: "A manifest carrying the removed cross-plugin tool grant.",
      entry: "dist/index.js",
      tools: [],
      pluginAccess: {
        plugins: [
          {
            pluginId: "samplemail",
            events: ["samplemail.snapshot.ready"],
            tools: ["samplemail_email_list"],
          },
        ],
      },
    }));

    expect(result).toBe(false);
    expect(validator.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: "tools" }),
        }),
      ]),
    );
  });

  it("accepts networkAccess.allowPrivateNetworks", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "private-network-plugin",
        name: "Private Network Plugin",
        version: "1.0.0",
        description: "Private network fixture.",
        entry: "dist/index.js",
        tools: [],
        networkAccess: {
          allowedDomains: ["intranet.example.com"],
          allowPrivateNetworks: true,
          reasoning: "Host-mediated intranet access.",
        },
      })),
    ).toBe(true);
  });

  it("accepts the loopback literals in networkAccess.allowedDomains", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "local-endpoint-plugin",
        name: "Local Endpoint Plugin",
        version: "1.0.0",
        description: "Local inference endpoint fixture.",
        entry: "dist/index.js",
        tools: [],
        networkAccess: {
          allowedDomains: ["localhost", "127.0.0.1", "::1", "api.example.com"],
          reasoning: "A local inference server the user configures.",
        },
      })),
    ).toBe(true);
  });

  it("still rejects single-label hosts that are not loopback literals", async () => {
    const validator = await buildManifestValidator();
    // The loopback exemption is three exact literals — it is not a general
    // relaxation of the one-dot rule that stops a bare label blanket-matching.
    for (const host of ["intranet", "localhost.", "::2", "127.0.0.1:1234"]) {
      expect(
        validator(agentPluginsDocument({
          id: "local-endpoint-plugin",
          name: "Local Endpoint Plugin",
          version: "1.0.0",
          description: "Local inference endpoint fixture.",
          entry: "dist/index.js",
          tools: [],
          networkAccess: { allowedDomains: [host] },
        })),
      ).toBe(false);
    }
  });

  // "Declared POLICY, served CONTENT": a uiResources[] entry declares the uri +
  // the resource's security policy. The card HTML is NOT a manifest field — the
  // plugin serves its own bytes (RuntimePlugin.readUiResource), so `uri` is the
  // only required member.
  it("accepts a uiResources[] ui:// serving declaration (csp buckets)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-plugin/card.html",
            csp: {
              connectDomains: ["https://api.example.com"],
              resourceDomains: [],
            },
          },
        ],
      })),
    ).toBe(true);
  });

  it("accepts a uiResources[] entry declaring host-honorable `permissions` (camera/microphone/geolocation)", async () => {
    // The inner app frame now carries `allow-same-origin` (spec origin requirement), so a
    // declared permission can actually be delegated + honored. Main derives BOTH the frame
    // `allow` attribute and the Electron session grant from this declaration; the accepted
    // set is exactly what an e2e proved works (mcp-app-permissions.spec.ts).
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-plugin/card.html",
            permissions: { camera: {}, microphone: {}, geolocation: {} },
          },
        ],
      })),
    ).toBe(true);
  });

  it("REJECTS a uiResources[] `permissions` key the host cannot honor (clipboardWrite / unknown) — fails LOUDLY", async () => {
    // clipboardWrite is deliberately absent from the schema: measured, a script-initiated
    // clipboard write is denied even when delegated, so accepting it would be an unhonored
    // knob. `additionalProperties:false` on mcpUiResourcePermissions makes declaring it — or
    // any unknown feature — fail validation loudly rather than silently doing nothing.
    const validator = await buildManifestValidator();
    const withPermission = (permissions: Record<string, unknown>) =>
      validator(agentPluginsDocument({
        id: "ui-resource-plugin",
        name: "UI Resource Plugin",
        version: "1.0.0",
        description: "Plugin serving a ui:// MCP App card.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          { uri: "ui://ui-resource-plugin/card.html", permissions },
        ],
      }));
    expect(withPermission({ clipboardWrite: {} })).toBe(false);
    expect(withPermission({ notARealFeature: {} })).toBe(false);
  });

  // LOCKSTEP GUARD (cluster critic MINOR-2): the schema's `mcpUiResourcePermissions`
  // properties are a SECOND hand-maintained enumeration of the accepted permission set,
  // and its `$comment` names MCP_APP_PERMISSION_FEATURES as the SOT — but nothing bound
  // them, so a 5th feature added to the table (or the schema) without the other would
  // drift silently. Bind them here: adding/removing a feature on either side fails this
  // test instead of shipping a schema that accepts a feature the host cannot honor, or
  // rejects one it can.
  it("schema `mcpUiResourcePermissions` keys match MCP_APP_PERMISSION_FEATURES exactly (no silent drift)", () => {
    const schemaKeys = Object.keys(
      manifestSchema.definitions.mcpUiResourcePermissions.properties,
    ).sort();
    const sotKeys = MCP_APP_PERMISSION_FEATURES.map((f) => f.key).sort();
    expect(schemaKeys).toEqual(sotKeys);
    // Anchor the current accepted set so a change to EITHER side is visible in the diff,
    // and clipboardWrite stays excluded on both.
    expect(sotKeys).toEqual(["camera", "geolocation", "microphone"]);
    expect(schemaKeys).not.toContain("clipboardWrite");
  });

  it("accepts a uiResources[] entry declaring only its uri (policy is optional)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-resource-bare",
        name: "UI Resource Bare",
        version: "1.0.0",
        description: "uiResources entry with no declared policy.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [{ uri: "ui://ui-resource-bare/card.html" }],
      })),
    ).toBe(true);
  });

  it("rejects a uiResources[] entry with an unknown sub-property (additionalProperties:false)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-resource-bad",
        name: "UI Resource Bad",
        version: "1.0.0",
        description: "uiResources entry with a stray field.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-bad/card.html",
            cspHeader: "default-src 'none'",
          },
        ],
      })),
    ).toBe(false);
  });

  // The removed `html` member is now an unknown sub-property: a manifest still
  // shipping a disk path is REJECTED, not silently tolerated (the host no longer
  // reads plugin files, so an ignored `html` would be a lie in the manifest).
  it("rejects a uiResources[] entry still declaring the removed html path", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-resource-legacy",
        name: "UI Resource Legacy",
        version: "1.0.0",
        description: "uiResources entry with the removed html path.",
        entry: "dist/index.js",
        tools: [],
        uiResources: [
          {
            uri: "ui://ui-resource-legacy/card.html",
            html: "dist/cards/card.html",
          },
        ],
      })),
    ).toBe(false);
  });

  it("accepts a marketplace-provider host secret grant", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "marketplace-provider-secret",
        name: "Marketplace Provider Secret Plugin",
        version: "1.0.0",
        description: "Marketplace provider secret fixture.",
        entry: "dist/index.js",
        tools: [],
        hostSecrets: { read: ["llm.marketplaceProvider.future-router.apiKey"] },
      })),
    ).toBe(true);
  });

  // ── negative-strictness guards (opposite polarity — each must REJECT) ───────
  it("rejects a pure tool carrying a removed field (writesToOwnSandbox)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "removed-field-plugin",
        name: "Removed Field Plugin",
        version: "1.0.0",
        description: "Pure tool carrying a removed field fixture.",
        entry: "dist/index.js",
        tools: [
          {
            name: "leaky_tool",
            description: "Declares a removed field.",
            inputSchema: { type: "object", properties: {} },
            writesToOwnSandbox: true,
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      })),
    ).toBe(false);
  });

  it("rejects an empty _meta.ui.visibility: [] (minItems:1)", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "empty-visibility-plugin",
        name: "Empty Visibility Plugin",
        version: "1.0.0",
        description: "Pure tool with empty visibility fixture.",
        entry: "dist/index.js",
        tools: [
          {
            name: "unreachable_tool",
            description: "Reachable by neither surface.",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: [] } },
          },
        ],
      })),
    ).toBe(false);
  });

  it('rejects a ui[] extension declaring the removed kind:"action"', async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-action-kind-plugin",
        name: "UI Action Kind Plugin",
        version: "1.0.0",
        description: 'Removed ui[].kind="action" fixture.',
        entry: "dist/index.js",
        tools: [],
        ui: [
          { id: "a", slot: "sidebar", kind: "action", title: "x", tool: "t" },
        ],
      })),
    ).toBe(false);
  });

  it("rejects retired ui[] detached-window hints", async () => {
    const validator = await buildManifestValidator();
    expect(
      validator(agentPluginsDocument({
        id: "ui-window-hints-plugin",
        name: "UI Window Hints Plugin",
        version: "1.0.0",
        description: "UI extension carrying retired window hints.",
        entry: "dist/index.js",
        tools: [],
        ui: [
          {
            id: "main",
            slot: "sidebar",
            kind: "embedded-page",
            title: "Main",
            page: "main",
            window: { width: 640 },
          },
        ],
      })),
    ).toBe(false);
    expect(validator.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          params: expect.objectContaining({ additionalProperty: "window" }),
        }),
      ]),
    );
  });

  // ── fail-closed: an uncompilable schema aborts plugin loading ───────────────
  describe("per-language display text (locales)", () => {
    const uiEntry = (locales: unknown) => ({
      id: "panel",
      slot: "sidebar",
      kind: "embedded-page",
      displayName: "미팅",
      title: "회의 기록",
      page: "panel",
      locales,
    });
    const withUi = (locales: unknown) => agentPluginsDocument({
      id: "ui-locales-plugin",
      name: "UI Locales Plugin",
      version: "1.0.0",
      description: "UI extension with per-language labels.",
      entry: "dist/index.js",
      tools: [],
      ui: [uiEntry(locales)],
    });
    const withConfigProperty = (locales: unknown) => agentPluginsDocument({
      id: "config-locales-plugin",
      name: "Config Locales Plugin",
      version: "1.0.0",
      description: "Config property with per-language text.",
      entry: "dist/index.js",
      tools: [],
      configSchema: { properties: { folder: { type: "string", title: "폴더", locales } } },
    });
    const withAuth = (locales: unknown) => agentPluginsDocument({
      id: "auth-locales-plugin",
      name: "Auth Locales Plugin",
      version: "1.0.0",
      description: "Auth block with per-language label.",
      entry: "dist/index.js",
      tools: [
        { name: "al_status", description: "Report the sign-in state.", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        { name: "al_login", description: "Begin the sign-in flow.", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
      ],
      auth: { label: "계정", statusTool: "al_status", loginTool: "al_login", locales },
    });

    it("accepts ui[].locales with any subset of displayName/title/description", async () => {
      const validator = await buildManifestValidator();
      const ok = validator(withUi({
        en: { displayName: "Meeting", description: "Records meetings.\nTwo lines are fine here." },
        "pt-br": { title: "Gravador de reuniões" },
        ko: { displayName: "미팅" },
      }));
      if (!ok) console.error(validator.errors);
      expect(ok).toBe(true);
    });

    it("accepts configSchema property and auth locales", async () => {
      const validator = await buildManifestValidator();
      expect(validator(withConfigProperty({ en: { title: "Folder", description: "Where to scan." } }))).toBe(true);
      expect(validator(withAuth({ en: { label: "Account" } }))).toBe(true);
    });

    it.each([
      ["an empty map", {}],
      ["an upper-case tag", { EN: { displayName: "Meeting" } }],
      ["an underscore tag", { pt_br: { displayName: "Reunião" } }],
      ["a tag with a line break", { "en\n": { displayName: "Meeting" } }],
      ["an empty entry", { en: {} }],
      ["an unknown field", { en: { label: "Meeting" } }],
      ["a non-string value", { en: { displayName: 42 } }],
      ["a blank label", { en: { displayName: "   " } }],
      ["an empty label", { en: { title: "" } }],
      ["a multi-line label", { en: { title: "Meeting\nRecorder" } }],
      ["a blank description", { en: { description: " \n " } }],
      ["a string instead of an entry", { en: "Meeting" }],
      ["an array instead of a map", [{ en: { displayName: "Meeting" } }]],
      ["more than 16 locales", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`l${String.fromCharCode(97 + i)}`, { title: "x" }]))],
    ])("rejects ui[].locales with %s", async (_name, locales) => {
      const validator = await buildManifestValidator();
      expect(validator(withUi(locales))).toBe(false);
    });

    it.each([
      ["a ui-only field on a config property", withConfigProperty({ en: { displayName: "Folder" } })],
      ["an auth entry without label", withAuth({ en: {} })],
      ["an auth label over 64 characters", withAuth({ en: { label: "x".repeat(65) } })],
    ])("rejects %s", async (_name, document) => {
      const validator = await buildManifestValidator();
      expect(validator(document)).toBe(false);
    });

    it("names the offending field when a locale entry carries an unknown key", async () => {
      const validator = await buildManifestValidator();
      expect(validator(withUi({ en: { label: "Meeting" } }))).toBe(false);
      expect(validator.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          keyword: "additionalProperties",
          instancePath: expect.stringContaining("/ui/0/locales/en"),
          params: expect.objectContaining({ additionalProperty: "label" }),
        }),
      ]));
    });
  });

  describe("fail-closed", () => {
    beforeEach(() => {
      vi.resetModules();
    });
    afterEach(() => {
      vi.doUnmock("ajv");
      vi.doUnmock("ajv-formats");
      vi.resetModules();
    });

    it("throws a wrapped error when AJV cannot compile the host schema", async () => {
      vi.doMock("ajv", () => {
        class ThrowingAjv {
          compile(): never {
            throw new Error("boom-compile");
          }
        }
        return { default: ThrowingAjv };
      });
      vi.doMock("ajv-formats", () => ({ default: () => undefined }));

      const { buildManifestValidator: build } = await import(
        "../manifest-validation.js"
      );
      await expect(build()).rejects.toThrow(
        /Host plugin manifest validator failed to compile: boom-compile/,
      );
    });
  });

  // ── formatUnknownErrorMessage (still exported + used by the fail-closed wrap) ─
  it("formatUnknownErrorMessage stringifies Error / string / object / null", () => {
    expect(formatUnknownErrorMessage(new Error("boom"))).toBe("boom");
    expect(formatUnknownErrorMessage("failed")).toBe("failed");
    expect(formatUnknownErrorMessage({ code: "ERR_X" })).toBe(
      '{"code":"ERR_X"}',
    );
    expect(formatUnknownErrorMessage(null)).toBe("null");
  });
});

describe("schema ↔ types ↔ parsePluginJson coherence (ph2)", () => {
  // Full-featured manifest: pure Tool[] with _meta.ui.visibility + pathFields,
  // an app-only auth trio, keywords, networkAccess, hostSecrets, requires,
  // ui[], and configSchema. Must satisfy BOTH the compiled host schema AND the
  // host cross-field checks in parsePluginJson end-to-end.
  const fullFeatured = {
    id: "full-featured-plugin",
    name: "Full Featured Plugin",
    version: "1.2.3",
    description:
      "A representative manifest exercising every host-required field.",
    packageName: "@ave/full-featured-plugin",
    author: { name: "Ave Team" },
    uiSlots: ["sidebar"],
    entry: "dist/index.js",
    tools: [
      {
        name: "ff_search",
        description: "Search indexed documents by query.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, path: { type: "string" } },
          required: ["query"],
        },
        _meta: {
          ui: { visibility: ["model", "app"] },
          "ave/pathFields": ["path"],
        },
      },
      {
        name: "ff_status",
        description: "Return the plugin auth status for the host UI.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "ff_login",
        description: "Begin the host-triggered login flow.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "ff_logout",
        description: "Sign the user out of the plugin session.",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
    ],
    capabilities: ["knowledge-index"],
    auth: {
      label: "Full Featured Account",
      locales: { ko: { label: "전체 기능 계정" } },
      statusTool: "ff_status",
      loginTool: "ff_login",
      logoutTool: "ff_logout",
    },
    emittedEvents: ["full-featured-plugin.auth.changed"],
    networkAccess: {
      allowedDomains: ["api.example.com"],
      reasoning: "Host-mediated egress for document sync.",
    },
    hostSecrets: { read: ["llm.apiKey.openai"] },
    requires: { capabilities: ["knowledge-index"], minAppVersion: "1.0.0" },
    ui: [
      {
        id: "settings-page",
        slot: "sidebar",
        kind: "embedded-page",
        title: "Settings",
        locales: { ko: { title: "설정", description: "플러그인 설정" } },
        page: "settings",
      },
    ],
    uiResources: [
      {
        uri: "ui://full-featured-plugin/card.html",
        csp: { connectDomains: ["https://api.example.com"] },
      },
    ],
    configSchema: {
      properties: {
        enabled: { type: "boolean", default: true, title: "Enable", locales: { ko: { title: "사용" } } },
        apiKey: { type: "string", format: "secret", title: "API Key" },
      },
      required: ["enabled"],
    },
    python: {
      managedBy: "ave",
      requirementsLock: "python-requirements.lock",
      interpreter: "python3",
    },
    startupTimeoutMs: 8000,
    // `author` is portable Agent Plugins metadata, so it rides at the document
    // level and is deliberately absent from PluginManifest — which is the point
    // of the `"author" in parsed` assertion below.
  } satisfies PluginManifest & { author: { name: string } };

  it("validates against the compiled host schema", async () => {
    const validator = await buildManifestValidator();
    const ok = validator(agentPluginsDocument(fullFeatured));
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV errors:", validator.errors);
    }
    expect(ok).toBe(true);
  });

  it("parses end-to-end through parsePluginJson (schema + host cross-field checks)", async () => {
    const validator = await buildManifestValidator();
    const dir = await mkdtemp(
      join(realpathSync(tmpdir()), "manifest-full-featured-"),
    );
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(agentPluginsDocument(fullFeatured)), "utf-8");
      const parsed = await parsePluginJson(file, validator);

      expect(parsed.id).toBe("full-featured-plugin");
      expect(parsed.auth?.statusTool).toBe("ff_status");
      expect(parsed.auth?.logoutTool).toBe("ff_logout");
      expect(parsed.packageName).toBe("@ave/full-featured-plugin");
      // Portable Agent Plugins metadata is accepted by the schema (the fixture
      // carries `author`) and deliberately does NOT cross into the manifest the
      // host reads: it is catalog-facing, and `public-contract.ts` keeps catalog
      // concepts out of the plugin contract. Asserted rather than assumed, so a
      // future flattener change that starts leaking it is caught here.
      expect("author" in parsed).toBe(false);
      expect(parsed.uiSlots).toEqual(["sidebar"]);
      expect(parsed.python).toEqual({
        managedBy: "ave",
        requirementsLock: "python-requirements.lock",
        interpreter: "python3",
      });
      expect(parsed.requires?.minAppVersion).toBe("1.0.0");
      // Per-language text reaches the manifest every surface reads, unchanged.
      expect(parsed.ui?.[0]?.locales).toEqual({ ko: { title: "설정", description: "플러그인 설정" } });
      expect(parsed.configSchema?.properties.enabled?.locales).toEqual({ ko: { title: "사용" } });
      expect(parsed.auth?.locales).toEqual({ ko: { label: "전체 기능 계정" } });
      expect(parsed.networkAccess?.allowedDomains).toEqual(["api.example.com"]);
      expect(parsed.uiResources?.[0]).toEqual({
        uri: "ui://full-featured-plugin/card.html",
        csp: { connectDomains: ["https://api.example.com"] },
      });

      const search = parsed.tools.find((t) => t.name === "ff_search");
      expect(search?._meta?.ui?.visibility).toEqual(["model", "app"]);
      expect(search?._meta?.["ave/pathFields"]).toEqual(["path"]);

      // Auth trio materialized as app-only (never model-visible).
      const status = parsed.tools.find((t) => t.name === "ff_status");
      expect(status?._meta?.ui?.visibility).toEqual(["app"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("materializes omitted Tool visibility into independent arrays", async () => {
    const validator = await buildManifestValidator();
    const dir = await mkdtemp(
      join(realpathSync(tmpdir()), "manifest-default-visibility-"),
    );
    try {
      const file = join(dir, "plugin.json");
      await writeFile(
        file,
        JSON.stringify(agentPluginsDocument({
          id: "default-visibility-plugin",
          name: "Default Visibility Plugin",
          version: "1.0.0",
          description: "Exercises default Tool visibility materialization.",
          entry: "dist/index.js",
          tools: [
            {
              name: "first_default",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "second_default",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        })),
        "utf-8");

      const parsed = await parsePluginJson(file, validator);
      const first = parsed.tools[0]?._meta?.ui?.visibility;
      const second = parsed.tools[1]?._meta?.ui?.visibility;
      if (!first || !second) {
        throw new Error("Expected omitted Tool visibility to be materialized");
      }

      expect(first).toEqual(["model", "app"]);
      expect(second).toEqual(["model", "app"]);
      expect(first).not.toBe(second);

      first.pop();
      expect(second).toEqual(["model", "app"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("colocated operation policy cross-field contract", () => {
  const governed = {
    id: "governed-plugin",
    version: "1.0.0",
    description: "Governed operation union fixture.",
    entry: "dist/index.js",
    tools: [
      {
        name: "domain_read",
        description: "Read domain state before a write.",
        inputSchema: {
          type: "object",
          properties: { operation: { type: "string", enum: ["status"] } },
          required: ["operation"],
          additionalProperties: false,
        },
        _meta: {
          ui: { visibility: ["model", "app"] },
          "ave/operationPolicy": {
            discriminant: "operation",
            operations: {
              status: {
                kind: "read",
                minimumRisk: "read",
                appVisible: true,
                successfulResultStatuses: ["success"],
              },
            },
          },
        },
      },
      {
        name: "domain_write",
        description: "Write domain state after confirmation.",
        inputSchema: {
          type: "object",
          properties: { operation: { type: "string", enum: ["save"] } },
          required: ["operation"],
          additionalProperties: false,
        },
        _meta: {
          ui: { visibility: ["model", "app"] },
          "ave/operationPolicy": {
            discriminant: "operation",
            operations: {
              save: {
                kind: "write",
                minimumRisk: "network",
                appVisible: true,
                requiresRead: {
                  tool: "domain_read",
                  operations: ["status"],
                  maxAgeMs: 60000,
                },
              },
            },
          },
        },
      },
    ],
  };

  async function parse(value: unknown) {
    const dir = await mkdtemp(
      join(realpathSync(tmpdir()), "manifest-governance-"),
    );
    try {
      const file = join(dir, "plugin.json");
      await writeFile(file, JSON.stringify(agentPluginsDocument(value as Record<string, unknown>)), "utf-8");
      return await parsePluginJson(file, await buildManifestValidator());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("accepts a policy whose operation union exactly matches its tool schema", async () => {
    await expect(parse(governed)).resolves.toMatchObject({
      tools: governed.tools,
    });
  });

  it("rejects operation drift but accepts an app write without an artificial read", async () => {
    const drifted = structuredClone(governed);
    drifted.tools[1].inputSchema.properties.operation.enum = ["save", "delete"];
    await expect(parse(drifted)).rejects.toThrow(/exactly match/);

    const noRead = structuredClone(governed);
    delete (
      noRead.tools[1]._meta["ave/operationPolicy"].operations.save as {
        requiresRead?: unknown;
      }
    ).requiresRead;
    await expect(parse(noRead)).resolves.toMatchObject({ tools: noRead.tools });
  });

  it("does not let an operation policy expand app visibility", async () => {
    const modelOnly = structuredClone(governed);
    modelOnly.tools[1]._meta.ui.visibility = ["model"];
    await expect(parse(modelOnly)).rejects.toThrow(/cannot expand/);
  });

  it("rejects read-result success statuses on a write operation", async () => {
    const invalid = structuredClone(governed);
    (
      invalid.tools[1]._meta["ave/operationPolicy"].operations.save as {
        successfulResultStatuses?: string[];
      }
    ).successfulResultStatuses = ["success"];
    await expect(parse(invalid)).rejects.toThrow(
      /valid only for a read operation/,
    );
    // The error path names the real _meta key, not a stale namespace.
    await expect(parse(invalid)).rejects.toThrow(
      /\._meta\.ave\/operationPolicy\.operations\.save\.successfulResultStatuses'/,
    );
  });
});
