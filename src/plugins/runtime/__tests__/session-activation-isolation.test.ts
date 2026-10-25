/** Session activation stays in isolated in-memory state and never mutates registry enablement. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";

describe("PluginRuntime — per-session activation isolation (real methods)", () => {
  let rootDir: string;
  let pluginsRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "ave-session-activation-"));
    pluginsRoot = join(rootDir, "plugins", "installed");
    registryPath = join(rootDir, "plugins", "registry.json");
    await mkdir(pluginsRoot, { recursive: true });
    await mkdir(dirname(registryPath), { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeRuntime() {
    return makeTestPluginRuntime({ rootDir, pluginsRoot, registryPath });
  }

  it("set/isSessionActivated records activation scoped to a single session", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(true);
    expect(runtime.isSessionActivated("session-B", "local-indexer")).toBe(false);
    expect(runtime.isSessionActivated("session-A", "meeting")).toBe(false);
  });

  it("clearing session B does NOT remove session A's activation (mutation guard)", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");
    runtime.setSessionActivated("session-B", "meeting");

    // Clearing one session must preserve every other session activation.
    runtime.clearSessionActivated("session-B");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(true);
    expect(runtime.isSessionActivated("session-B", "meeting")).toBe(false);
  });

  it("clearing session A removes ONLY session A's activations", () => {
    const runtime = makeRuntime();
    runtime.setSessionActivated("session-A", "local-indexer");
    runtime.setSessionActivated("session-A", "meeting");
    runtime.setSessionActivated("session-B", "samplemail");

    runtime.clearSessionActivated("session-A");

    expect(runtime.isSessionActivated("session-A", "local-indexer")).toBe(false);
    expect(runtime.isSessionActivated("session-A", "meeting")).toBe(false);
    expect(runtime.isSessionActivated("session-B", "samplemail")).toBe(true);
  });
});
