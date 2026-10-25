/** Drive the production bridge; a local mirror can hide namespace-filtering failures. */
import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { emitEvent } from "../types.js";
import { registerPluginEventBridge } from "../steps/ipc-bridge.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  makeTestPluginEntrySource,
  type TestPluginRuntimeFixture,
} from "../../plugins/__tests__/test-helpers.js";

function makeFakeWindow() {
  const sent: Array<{ channel: string; eventType: string; data: unknown }> = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, eventType: string, data: unknown) => {
        sent.push({ channel, eventType, data });
      },
    },
    once: () => undefined,
    _sent: sent,
  };
}

function makeRuntime(
  manifests: Array<{ id: string; emittedEvents?: string[]; auth?: PluginManifest["auth"] }>,
) {
  return {
    listPluginManifests: () =>
      manifests.map((m) => ({
        pluginId: m.id,
        manifest: {
          id: m.id,
          name: m.id,
          version: "0.0.1",
          entry: "index.js",
          tools: [],
          emittedEvents: m.emittedEvents,
          ...(m.auth !== undefined ? { auth: m.auth } : {}),
        } satisfies Partial<PluginManifest> as unknown as PluginManifest,
      })),
  };
}

function bridge(runtime: ReturnType<typeof makeRuntime>, win: ReturnType<typeof makeFakeWindow>) {
  return registerPluginEventBridge(runtime as unknown as never, win as unknown as never);
}

describe("plugin event bridge — manifest.emittedEvents", () => {
  it("production bridge does not register undeclared legacy event literals", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([]), win);

    emitEvent("meeting.transcript.updated", { chunk: "hello" });

    expect(win._sent).toHaveLength(0);
    dispose();
  });

  it("forwards public events from two plugins with distinct emittedEvents", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-a", emittedEvents: ["meeting.status.changed"] },
        { id: "test-b", emittedEvents: ["email.action.needed"] },
      ]),
      win,
    );

    emitEvent("meeting.status.changed", { status: "started" });
    emitEvent("email.action.needed", { subject: "test" });

    expect(win._sent).toHaveLength(2);
    const eventTypes = win._sent.map((s) => s.eventType);
    expect(eventTypes).toContain("meeting.status.changed");
    expect(eventTypes).toContain("email.action.needed");
    for (const s of win._sent) {
      expect(s.channel).toBe("ave:plugin:event");
    }

    dispose();
  });

  it("does NOT forward private-namespace events", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-c", emittedEvents: ["audit.log.entry", "meeting.status.changed"] },
      ]),
      win,
    );

    emitEvent("audit.log.entry", { secret: true });
    // The public sibling proves filtering applies per namespace rather than per manifest.
    emitEvent("meeting.status.changed", { status: "started" });

    expect(win._sent.map((s) => s.eventType)).toEqual(["meeting.status.changed"]);

    dispose();
  });

  it("does NOT forward the host-derived <id>.auth.changed for a private-namespace id", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "dlp", auth: { statusTool: "x_status", loginTool: "x_login" } }]),
      win,
    );

    emitEvent("dlp.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(0);

    dispose();
  });

  it("stops forwarding after dispose()", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "test-d", emittedEvents: ["meeting.status.changed"] }]),
      win,
    );

    emitEvent("meeting.status.changed", { status: "started" });
    expect(win._sent).toHaveLength(1);

    dispose();
    emitEvent("meeting.status.changed", { status: "stopped" });
    expect(win._sent).toHaveLength(1);
  });

  it("deduplicates when two plugins declare the same emittedEvent", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([
        { id: "test-e1", emittedEvents: ["calendar.event.created"] },
        { id: "test-e2", emittedEvents: ["calendar.event.created"] },
      ]),
      win,
    );

    emitEvent("calendar.event.created", { id: "ev1" });

    expect(win._sent).toHaveLength(1);

    dispose();
  });
});

describe("plugin event bridge — host-derived <id>.auth.changed (R3)", () => {
  const AUTH: PluginManifest["auth"] = { statusTool: "x_status", loginTool: "x_login" };

  it("bridges ${id}.auth.changed when auth is declared but emittedEvents omits it", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "samplemail", auth: AUTH }]), win);

    emitEvent("samplemail.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("samplemail.auth.changed");
    expect(win._sent[0].channel).toBe("ave:plugin:event");

    dispose();
  });

  it("preserves the LITERAL dashed manifest id (no `_`<->`-` normalization)", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "foo-bar", auth: AUTH }]), win);

    emitEvent("foo-bar.auth.changed", { authenticated: false });
    // The underscore alias must not bridge alongside the canonical dash form.
    emitEvent("foo_bar.auth.changed", { authenticated: false });

    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("foo-bar.auth.changed");

    dispose();
  });

  it("dedupes when the author ALSO lists ${id}.auth.changed in emittedEvents (registers once)", () => {
    const win = makeFakeWindow();
    const dispose = bridge(
      makeRuntime([{ id: "sampleportal", auth: AUTH, emittedEvents: ["sampleportal.auth.changed"] }]),
      win,
    );

    emitEvent("sampleportal.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(1);
    expect(win._sent[0].eventType).toBe("sampleportal.auth.changed");

    dispose();
  });

  it("does NOT derive auth.changed for a plugin without an auth block", () => {
    const win = makeFakeWindow();
    const dispose = bridge(makeRuntime([{ id: "plain-plugin" }]), win);

    emitEvent("plain-plugin.auth.changed", { authenticated: true });

    expect(win._sent).toHaveLength(0);

    dispose();
  });
});

// The real loader must preserve private events so the bridge guard is reachable.

describe("plugin event bridge — real PluginRuntime producer", () => {
  let fixture: TestPluginRuntimeFixture | undefined;

  afterEach(async () => {
    if (fixture) await rm(fixture.rootDir, { recursive: true, force: true });
    fixture = undefined;
  });

  it("bridges the public emittedEvent and drops the private one from a disk-loaded manifest", async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-bridge-producer-" });
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: "producer-plugin",
      tools: ["producer_plugin_ping"],
      entrySource: makeTestPluginEntrySource({ producer_plugin_ping: `"pong"` }),
      manifest: {
        emittedEvents: ["producer-plugin.status.changed", "audit.log.entry"],
      },
    });
    await writeTestPluginRegistry(fixture, [
      { id: "producer-plugin", manifestPath, enabled: true },
    ]);

    const runtime = makeTestPluginRuntime(fixture);
    await runtime.startAll();

    // Assert the loader retained the private event to avoid passing through upstream filtering.
    const produced = runtime.listPluginManifests().find((m) => m.pluginId === "producer-plugin");
    expect(produced?.manifest.emittedEvents).toEqual([
      "producer-plugin.status.changed",
      "audit.log.entry",
    ]);

    const win = makeFakeWindow();
    const dispose = registerPluginEventBridge(runtime, win as unknown as never);

    emitEvent("audit.log.entry", { secret: "hunter2" });
    emitEvent("producer-plugin.status.changed", { status: "ok" });

    expect(win._sent.map((s) => s.eventType)).toEqual(["producer-plugin.status.changed"]);

    dispose();
    await runtime.stopAll();
  });
});
