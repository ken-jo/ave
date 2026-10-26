/** All app-only dispatch must pass callDeclaredAppOnlyTool and its shared ceiling; tests inject only a smaller deadline. */
import { describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function runtimeWithAppVisibleTool(
  method: string,
  handler: (payload?: unknown) => Promise<unknown>,
  auth?: { statusTool: string; loginTool: string; logoutTool: string },
): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, { manifest: unknown }>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  internals.plugins.set("test.plugin", {
    manifest: {
      tools: [
        {
          name: method,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["app"] } },
        },
      ],
      ...(auth ? { auth } : {}),
    },
  } as unknown as never);
  internals.methodMap.set(method, { pluginId: "test.plugin", handler });
  return rt;
}

describe("PluginRuntime.callDeclaredAppOnlyTool — structural ceiling (#1553)", () => {
  it("rejects at the ceiling when the app-only handler never resolves (caller does not hang)", async () => {
    const rt = runtimeWithAppVisibleTool(
      "meeting_stage_upload_begin",
      () => new Promise<never>(() => {}),
    );
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_stage_upload_begin", {}, 5),
    ).rejects.toThrow(/exceeded global ceiling \(5ms\): meeting_stage_upload_begin/);
  });

  it("returns the handler value when it resolves within the ceiling", async () => {
    const rt = runtimeWithAppVisibleTool(
      "meeting_stage_upload_begin",
      async (payload) => ({ echoed: payload }),
    );
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_stage_upload_begin", { chunk: 1 }, 5_000),
    ).resolves.toEqual({ echoed: { chunk: 1 } });
  });

  it("rejects an app-only invocation pinned to a stale generation", async () => {
    const handler = vi.fn(async () => "must-not-run");
    const rt = runtimeWithAppVisibleTool(
      "meeting_stage_upload_begin",
      handler,
    );

    await expect(
      rt.callDeclaredAppOnlyTool(
        "meeting_stage_upload_begin",
        {},
        5_000,
        "stale-generation",
      ),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks a pinned predecessor auth handler after publication before task entry", async () => {
    const method = "auth_status";
    const auth = {
      statusTool: method,
      loginTool: "auth_login",
      logoutTool: "auth_logout",
    };
    const handler = vi.fn(async () => "must-not-run");
    const rt = runtimeWithAppVisibleTool(method, handler, auth);
    const manifest = {
      tools: [{
        name: method,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      }],
      auth,
    };
    const predecessor = {
      pluginId: "test.plugin",
      generationId: "generation-predecessor",
      state: {
        runtime: {
          manifest,
          methods: new Map([[method, handler]]),
        },
      },
    };
    let active = {
      pluginId: "test.plugin",
      generationId: predecessor.generationId,
      manifest,
    };
    const release = vi.fn();
    rt.setGenerationAccess({
      getActive: vi.fn(() => active),
      acquire: vi.fn(async () => ({ generation: predecessor, release })),
      acquireExact: vi.fn(async () => ({ generation: predecessor, release })),
      runWithLease: vi.fn(async (
        _lease: unknown,
        operation: () => Promise<unknown>,
      ) => operation()),
      replaceRuntime: vi.fn(),
    } as never);

    const invocation = rt.callDeclaredAppOnlyTool(
      method,
      {},
      5_000,
      predecessor.generationId,
    );
    active = {
      pluginId: "test.plugin",
      generationId: "generation-replacement",
      manifest,
    };

    await expect(invocation).rejects.toThrow(
      "plugin auth generation changed before handler entry",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("runs the Host auth assertion immediately before the app-only handler", async () => {
    const method = "auth_status";
    const handler = vi.fn(async () => "must-not-run");
    const rt = runtimeWithAppVisibleTool(method, handler, {
      statusTool: method,
      loginTool: "auth_login",
      logoutTool: "auth_logout",
    });
    const assertion = vi.fn(() => {
      throw new Error("plugin operation session is revoked");
    });

    await expect(
      rt.callDeclaredAppOnlyTool(method, {}, 5_000, undefined, assertion),
    ).rejects.toThrow("plugin operation session is revoked");
    expect(assertion).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains the exact generation lease until a ceiling-detached handler settles", async () => {
    let settle!: (value: unknown) => void;
    const handler = vi.fn(
      () =>
        new Promise<unknown>((resolvePromise) => {
          settle = resolvePromise;
        }),
    );
    const method = "meeting_stage_upload_begin";
    const rt = runtimeWithAppVisibleTool(method, handler);
    const release = vi.fn();
    const manifest = {
      tools: [{
        name: method,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      }],
    };
    const generation = {
      pluginId: "test.plugin",
      generationId: "generation-current",
      state: {
        runtime: {
          manifest,
          methods: new Map([[method, handler]]),
        },
      },
    };
    rt.setGenerationAccess({
      getActive: vi.fn(() => generation),
      acquire: vi.fn(async () => ({ generation, release })),
      acquireExact: vi.fn(async (
        _pluginId: string,
        expectedGenerationId: string,
      ) => {
        if (expectedGenerationId !== generation.generationId) {
          throw new Error("stale generation");
        }
        return { generation, release };
      }),
      runWithLease: vi.fn(async (
        _lease: unknown,
        operation: () => Promise<unknown>,
      ) => operation()),
      replaceRuntime: vi.fn(),
    } as never);

    await expect(
      rt.callDeclaredAppOnlyTool(
        method,
        {},
        5,
        generation.generationId,
      ),
    ).rejects.toThrow(/exceeded global ceiling/);
    expect(release).not.toHaveBeenCalled();

    settle("late completion");
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 0);
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("enforces the app-visible tool allowlist BEFORE the ceiling wrap (a non-app-visible method is rejected)", async () => {
    const rt = runtimeWithAppVisibleTool("meeting_stage_upload_begin", async () => "ok");
    // App visibility admission precedes the execution ceiling even if methodMap contains the name.
    const internals = rt as unknown as {
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    internals.methodMap.set("meeting_not_ui", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    await expect(
      rt.callDeclaredAppOnlyTool("meeting_not_ui", {}, 5_000),
    ).rejects.toThrow(/not an app-visible Tool/);
  });
});
