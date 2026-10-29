/** Loopback execution enforces runtime admission and integrity checks while preserving structured result data. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pluginRuntimeToolDelegate,
  splitPluginToolUiMeta,
} from "../plugin-runtime-delegate.js";
import { RAW_RESULT_META } from "../protocol-constants.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  ManifestIntegrityError,
  manifestIntegrityState,
} from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";
import { sessionContext } from "../../engine/session-context.js";
import { publishTestHost, testLoopbackHost } from "./plugin-mcp-test-helpers.js";

beforeEach(() => manifestIntegrityState.resetForTests());

const PLUGIN_ID = "com.example.notes";

// Keep runtime admission real; only the activation state is controlled by the fixture.
function fakeRuntime(over: Partial<Pick<PluginRuntime, "isPluginEnabled" | "isSessionActivated" | "call">>): PluginRuntime {
  const call = over.call ?? vi.fn(async () => "ok");
  return {
    isPluginEnabled: () => true,
    isSessionActivated: (_sessionId: string, _pluginId: string) => false,
    call,
    callForPlugin: vi.fn(async (_pluginId: string, toolName: string, payload?: unknown) =>
      call(toolName, payload),
    ),
    ...over,
  } as unknown as PluginRuntime;
}

describe("pluginRuntimeToolDelegate — fail-closed gate parity", () => {
  it("inactive plugin → isError without invoking the runtime", async () => {
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("integrity-disabled plugin → isError without invoking the runtime", async () => {
    await manifestIntegrityState.recordViolation(PLUGIN_ID, "notes_read", "writeFileSync");
    const call = vi.fn(async () => "should-not-run");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("disabled after a manifest integrity violation");
    expect(call).not.toHaveBeenCalled();
  });

  it("success carries the raw value in _meta and renders text", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ items: ["a", "b"] })) }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toBe(JSON.stringify({ items: ["a", "b"] }, null, 2));
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ items: ["a", "b"] });
  });

  it("passes undefined when the MCP call has no arguments", async () => {
    const call = vi.fn(async () => "ok");
    const delegate = pluginRuntimeToolDelegate(fakeRuntime({ call }), PLUGIN_ID);
    await delegate("notes_read", {});
    expect(call).toHaveBeenCalledWith("notes_read", undefined);
  });

  it("ManifestIntegrityError → records the violation and fails closed", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new ManifestIntegrityError(PLUGIN_ID, "notes_read", "writeFileSync");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", { q: "x" });
    expect(out.isError).toBe(true);
    expect(manifestIntegrityState.isDisabled(PLUGIN_ID)).toBe(true);
  });

  it("ordinary thrown error → isError outcome", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("boom");
  });
});

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Notes",
  version: "1.0.0",
  entry: "dist/index.js",
  description: "notes",
  tools: [
    {
      name: "notes_read",
      description: "Read",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

describe("pluginRuntimeToolDelegate — Gate 4: session-scoped on-demand activation", () => {
  it("registry-disabled + session-activated → tool call SUCCEEDS (load-bearing mutation detector)", async () => {
    const call = vi.fn(async () => ({ scanned: 42 }));
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => true,
        call,
      }),
      PLUGIN_ID,
    );
    // Activation lookup requires the current async-local session id.
    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", { q: "test" }),
    );
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ scanned: 42 });
  });

  it("disabled + NOT session-activated → REFUSED (original fail-closed behavior preserved)", async () => {
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => false,
        call,
      }),
      PLUGIN_ID,
    );
    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("fail-closed when no ALS session context (e.g. out-of-band call): disabled plugin → REFUSED", async () => {
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        isPluginEnabled: () => false,
        isSessionActivated: (_sid, _pid) => true,
        call,
      }),
      PLUGIN_ID,
    );
    const out = await delegate("index_scan", {});
    expect(out.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("non-allow-listed disabled plugin (not session-activated) → STILL refused by gate", async () => {
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: (_s, _p) => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("some_tool", {});
    expect(out.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("main chat: disabled plugin (no session activation) → REFUSED (behavior unchanged)", async () => {
    const call = vi.fn(async () => "unreachable");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: (_s, _p) => false, call }),
      PLUGIN_ID,
    );
    const out = await delegate("tool", {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("inactive");
    expect(call).not.toHaveBeenCalled();
  });

  it("registry-ENABLED + session-activated → succeeds (enabled takes priority, no regression)", async () => {
    const call = vi.fn(async () => "result");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => true, isSessionActivated: (_s, _p) => true, call }),
      PLUGIN_ID,
    );
    const out = await delegate("tool", {});
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
  });
});

describe("pluginRuntimeToolDelegate — Gate 4: per-session isolation (clear-race regression)", () => {
  it("clearing session B's scope does NOT wipe session A's on-demand activation", async () => {
    // Clearing another session must preserve the routine session activation.

    const activations = new Map<string, Set<string>>();
    const sessionAId = "routine-session-22h00";
    const sessionBId = "main-chat-22h00-user";

    const sessionAwareIsActivated = (sid: string, pid: string) =>
      activations.get(sid)?.has(pid) ?? false;

    const call = vi.fn(async () => ({ scanned: 99 }));
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: sessionAwareIsActivated, call }),
      PLUGIN_ID,
    );

    if (!activations.has(sessionAId)) activations.set(sessionAId, new Set());
    activations.get(sessionAId)!.add(PLUGIN_ID);

    activations.delete(sessionBId);

    expect(sessionAwareIsActivated(sessionAId, PLUGIN_ID)).toBe(true);

    const out = await sessionContext.run({ sessionId: sessionAId }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBeUndefined();
    expect(call).toHaveBeenCalled();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ scanned: 99 });
  });

  it("[OLD-APPROACH REGRESSION] global flat-Set clear would wipe session A → refused", async () => {
    // A global activation set is the negative control: clearing one session destroys another activation.

    const globalSet = new Set<string>();
    const oldIsActivated = (_sid: string, pid: string) => globalSet.has(pid);

    const call = vi.fn(async () => "result");
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ isPluginEnabled: () => false, isSessionActivated: oldIsActivated, call }),
      PLUGIN_ID,
    );

    globalSet.add(PLUGIN_ID);

    globalSet.clear();

    expect(oldIsActivated("routine-session-A", PLUGIN_ID)).toBe(false);

    const out = await sessionContext.run({ sessionId: "routine-session-A" }, () =>
      delegate("index_scan", {}),
    );
    expect(out.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("end-to-end: raw plugin value survives manifest → server → host → metadata.rawResult", () => {
  it("registered Tool surfaces metadata.rawResult from the plugin return value", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ hits: 3 })) }),
      PLUGIN_ID,
    );
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.metadata?.rawResult).toEqual({ hits: 3 });
  });
});

/** Lift declared tool-result UI metadata onto the wire so plugin tools can render their own cards. */
const CARD_URI = `ui://${PLUGIN_ID}/note.html`;
const DECLARED = new Set([CARD_URI]);

describe("pluginRuntimeToolDelegate — MCP App card trigger (_meta.ui)", () => {
  it("a declared resourceUri on the handler's return value reaches the wire _meta.ui", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          note: "hello",
          _meta: { ui: { resourceUri: CARD_URI, slot: "sidebar", height: 420, title: "Note" } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toEqual({
      resourceUri: CARD_URI,
      slot: "sidebar",
      height: 420,
      title: "Note",
    });
  });

  it("the card declaration is protocol, not payload: text + rawResult carry the plugin's OWN result", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({ note: "hello", _meta: { ui: { resourceUri: CARD_URI } } })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    // UI metadata stays outside model-facing text and raw result data.
    expect(out.content[0].text).toBe(JSON.stringify({ note: "hello" }, null, 2));
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ note: "hello" });
  });

  it("an UNDECLARED resourceUri produces NO card (fail-closed) — the result still returns", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          note: "hello",
          _meta: { ui: { resourceUri: `ui://${PLUGIN_ID}/undeclared.html` } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
    expect(out.isError).toBeUndefined();
    expect(out._meta?.[RAW_RESULT_META]).toEqual({ note: "hello" });
  });

  it("a plugin that declared NO uiResources[] cannot trigger a card (empty-set default)", async () => {
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => ({ _meta: { ui: { resourceUri: CARD_URI } } })) }),
      PLUGIN_ID,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
  });

  it("a plugin result with no _meta (the common case) is untouched — no card, value identical", async () => {
    const value = { note: "hello" };
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({ call: vi.fn(async () => value) }),
      PLUGIN_ID,
      DECLARED,
    );
    const out = await delegate("notes_read", {});
    expect(out._meta?.ui).toBeUndefined();
    expect(out._meta?.[RAW_RESULT_META]).toBe(value);
  });

  it("a malformed _meta.ui (no resourceUri) yields no card and leaves the value alone", () => {
    const value = { note: "x", _meta: { ui: { height: 300 } } };
    expect(splitPluginToolUiMeta(value)).toEqual({ value });
    expect(splitPluginToolUiMeta("a string")).toEqual({ value: "a string" });
    expect(splitPluginToolUiMeta([1, 2])).toEqual({ value: [1, 2] });
  });
});

describe("end-to-end: a plugin tool result renders a card (delegate → server → host → uiPayload)", () => {
  const CARD_MANIFEST: PluginManifest = {
    ...MANIFEST,
    uiResources: [{ uri: CARD_URI, csp: { connectDomains: ["https://api.example.com"] } }],
  };

  it("registered Tool surfaces metadata.uiPayload with the HOST-stamped serverId", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({ hits: 3, _meta: { ui: { resourceUri: CARD_URI } } })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const host = testLoopbackHost(CARD_MANIFEST, delegate, registry);
    await publishTestHost(host, CARD_MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    // Host-derived server ids prevent plugins from selecting another card namespace.
    expect(result.metadata?.uiPayload).toEqual({
      serverId: PLUGIN_ID,
      generationId: "test-generation",
      resourceUri: CARD_URI,
      slot: "chat",
      height: undefined,
      title: undefined,
    });
    expect(result.metadata?.rawResult).toEqual({ hits: 3 });
  });

  it("stamps the exact loopback generation into a rendered card", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({ hits: 1, _meta: { ui: { resourceUri: CARD_URI } } })),
      }),
      PLUGIN_ID,
      DECLARED,
      "g1",
    );
    const host = testLoopbackHost(CARD_MANIFEST, delegate, registry, undefined, "g1");
    await publishTestHost(host, CARD_MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({}, {} as never);
    expect(result.metadata?.uiPayload).toMatchObject({
      serverId: PLUGIN_ID,
      generationId: "g1",
      resourceUri: CARD_URI,
    });
  });

  it("an undeclared resourceUri renders NO card end-to-end", async () => {
    const registry = new ToolRegistry();
    const delegate = pluginRuntimeToolDelegate(
      fakeRuntime({
        call: vi.fn(async () => ({
          hits: 3,
          _meta: { ui: { resourceUri: `ui://${PLUGIN_ID}/rogue.html` } },
        })),
      }),
      PLUGIN_ID,
      DECLARED,
    );
    const host = testLoopbackHost(CARD_MANIFEST, delegate, registry);
    await publishTestHost(host, CARD_MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ q: "x" }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.metadata?.uiPayload).toBeUndefined();
  });
});
