/** Child host calls must restore the originating invocation context through the real session and effect gate. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncResource } from "node:async_hooks";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import { servePluginChild } from "../plugin-child-main.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import { openPluginProtocolSession, type PluginProtocolSession } from "../plugin-protocol-session.js";
import {
  currentEffectGateContext,
  enforceMutatingEffects,
  runWithEffectGateContext,
} from "../../../permissions/effect-enforcement.js";
import type { ApprovalGate } from "../../../permissions/approval-gate.js";

const PLUGIN_ID = "contextprobe";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Context Probe",
  version: "1.0.0",
  entry: "plugin.mjs",
  requires: { hostProtocol: "4" },
  description: "a plugin whose tool raises an alert",
  tools: [
    { name: "raise", description: "raise", inputSchema: { type: "object", properties: {} } },
    { name: "raise_after_return", description: "raise later", inputSchema: { type: "object", properties: {} } },
    { name: "subscribe", description: "subscribe", inputSchema: { type: "object", properties: {} } },
  ],
};

/** Observe late-call refusal by error name; the fixture module shares this test process. */
const LATE_OUTCOMES = "__invocationContextLateOutcomes";

function lateOutcomes(): string[] {
  return (globalThis as Record<string, unknown>)[LATE_OUTCOMES] as string[];
}

const ENVELOPE = {
  read: [`/plugins/${PLUGIN_ID}`, `/plugins/${PLUGIN_ID}/data`],
  write: [`/plugins/${PLUGIN_ID}/data`],
};

let moduleDir: string;
let entryPath: string;

beforeAll(() => {
  moduleDir = mkdtempSync(join(tmpdir(), "invocation-context-"));
  entryPath = join(moduleDir, "plugin.mjs");
  writeFileSync(
    entryPath,
    `export const createPlugin = async (context) => ({
  handlers: {
    raise: async () => context.hostApi.raiseAlert({ kind: "reply", key: "now" }),
    subscribe: async () => {
      context.hostApi.onEvent("probe.event", () => undefined);
      return "subscribed";
    },
    raise_after_return: async () => {
      setTimeout(() => {
        context.hostApi.raiseAlert({ kind: "reply", key: "late" }).then(
          () => globalThis.${LATE_OUTCOMES}.push("raised"),
          (error) => globalThis.${LATE_OUTCOMES}.push(error.name),
        );
      }, 0);
      return "returned";
    },
  },
  start: async () => { await context.hostApi.raiseAlert({ kind: "reply", key: "start" }); },
  stop: async () => undefined,
});
`,
    "utf-8",
  );
});

beforeEach(() => {
  (globalThis as Record<string, unknown>)[LATE_OUTCOMES] = [];
});

afterAll(() => {
  rmSync(moduleDir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[LATE_OUTCOMES];
});

/** Bind link callbacks outside invocations to prevent accidental async-context propagation. */
function isolatedLink(): ChildLink {
  const hostToChild = new PassThrough();
  const childInput = new PassThrough();
  const childOutput = new PassThrough();
  const childToHost = new PassThrough();
  const toChild = AsyncResource.bind((chunk: Buffer) => setImmediate(AsyncResource.bind(() => childInput.write(chunk))));
  const toHost = AsyncResource.bind((chunk: Buffer) => setImmediate(AsyncResource.bind(() => childToHost.write(chunk))));
  const pumpToChild = AsyncResource.bind((chunk: Buffer) => toChild(chunk));
  const pumpToHost = AsyncResource.bind((chunk: Buffer) => toHost(chunk));
  hostToChild.on("data", pumpToChild);
  childOutput.on("data", pumpToHost);
  const service = servePluginChild(childInput, childOutput);
  const gone: Array<(reason: string) => void> = [];
  hostToChild.on("end", () => {
    service.hostGone();
    childToHost.end();
    for (const handler of gone) handler("child exited");
  });
  return {
    input: childToHost,
    output: hostToChild,
    terminate: () => undefined,
    onGone: (handler) => void gone.push(handler),
    onFault: () => undefined,
  };
}

interface Probe {
  session: PluginProtocolSession;
  raised: Array<{ key: unknown; toolName: string | undefined }>;
  requestAndWait: ReturnType<typeof vi.fn>;
  stopWatcher: ReturnType<typeof vi.fn>;
  stopSubscription: ReturnType<typeof vi.fn>;
  onClosed: ReturnType<typeof vi.fn>;
}

async function openProbe(options: { watcherFailure?: boolean; subscriptionFailure?: boolean } = {}): Promise<Probe> {
  const raised: Probe["raised"] = [];
  const requestAndWait = vi.fn(async () => ({ choice: "allow-once" as const }));
  let watcherFailure = options.watcherFailure === true;
  const stopWatcher = vi.fn(() => {
    if (!watcherFailure) return;
    watcherFailure = false;
    throw new Error("watcher cleanup failed");
  });
  const watch = () => stopWatcher;
  const stopSubscription = vi.fn(() => {
    if (options.subscriptionFailure) throw new Error("subscription cleanup failed");
  });
  const onClosed = vi.fn(async () => undefined);
  const plain = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: watch,
    config: { get: () => undefined, set: async () => undefined, onChange: watch },
    onEvent: () => stopSubscription,
    raiseAlert: async (input: { key?: unknown }) => {
      raised.push({ key: input.key, toolName: currentEffectGateContext()?.toolName });
      return { status: "raised", alertId: `alert-${String(input.key)}` };
    },
  };
  // Wrap the implementation with the effect gate before binding dispatch.
  const hostApi = enforceMutatingEffects(plain, {
    pluginId: PLUGIN_ID,
    approvalGate: { requestAndWait } as unknown as ApprovalGate,
    flagEnabled: () => true,
    assertActive: () => undefined,
  }) as unknown as PluginHostApi;
  const context: PluginRuntimeContext = {
    pluginId: PLUGIN_ID,
    pluginRoot: `/plugins/${PLUGIN_ID}`,
    hostRoot: "/app",
    pluginDataDir: `/plugins/${PLUGIN_ID}/data`,
    pluginSocketDir: `/plugins/${PLUGIN_ID}/data/sockets`,
    userHome: "/Users/example",
    aveHome: "/Users/example/.ave",
    config: {},
    log: () => undefined,
    hostApi,
  };
  const session = await openPluginProtocolSession({
    pluginId: PLUGIN_ID,
    manifest: MANIFEST,
    hostProtocolVersion: "4",
    link: isolatedLink(),
    context,
    entryPath,
    table: createBoundHostApiDispatchTable(hostApi, ENVELOPE),
    onClosed,
  });
  return { session, raised, requestAndWait, stopWatcher, stopSubscription, onClosed };
}

describe("an out-of-process tool's hostApi call runs in its host invocation", () => {
  it("asks the user at the effect boundary for a foreground invocation", async () => {
    const probe = await openProbe();
    try {
      const result = await runWithEffectGateContext(
        { headless: false, approvalSurface: "interactive", toolName: "raise", sessionId: "session-1" },
        async () => await probe.session.instance.handlers.raise!(),
      );
      expect(result).toMatchObject({ status: "raised" });
      expect(probe.requestAndWait).toHaveBeenCalledTimes(1);
      expect(probe.requestAndWait.mock.calls[0]![0]).toMatchObject({
        toolName: "raise",
        sessionId: "session-1",
        approvalScope: "raiseAlert",
        sourcePluginId: PLUGIN_ID,
      });
      expect(probe.raised).toEqual([{ key: "now", toolName: "raise" }]);
    } finally {
      await probe.session.teardown("case over");
    }
  });

  it("fails closed for a headless invocation and never reaches the implementation", async () => {
    const probe = await openProbe();
    try {
      await expect(runWithEffectGateContext(
        { headless: true, approvalSurface: "unavailable", toolName: "raise" },
        async () => await probe.session.instance.handlers.raise!(),
      )).rejects.toThrow();
      expect(probe.requestAndWait).not.toHaveBeenCalled();
      expect(probe.raised).toEqual([]);
    } finally {
      await probe.session.teardown("case over");
    }
  });

  it("keeps a headless invocation's deny for a call made after the tool returned", async () => {
    const probe = await openProbe();
    try {
      await expect(runWithEffectGateContext(
        { headless: true, approvalSurface: "unavailable", toolName: "raise_after_return" },
        async () => await probe.session.instance.handlers.raise_after_return!(),
      )).resolves.toBe("returned");
      await vi.waitFor(() => expect(lateOutcomes()).toHaveLength(1));
      // A settled invocation token must preserve refusal of late work rather than reopen authority.
      expect(lateOutcomes()).toEqual(["EffectBoundaryDeniedError"]);
      expect(probe.requestAndWait).not.toHaveBeenCalled();
      expect(probe.raised).toEqual([]);
    } finally {
      await probe.session.teardown("case over");
    }
  });

  it("asks the user for a foreground call made after the tool returned, attributed to that tool", async () => {
    const probe = await openProbe();
    try {
      await expect(runWithEffectGateContext(
        { headless: false, approvalSurface: "interactive", toolName: "raise_after_return", sessionId: "session-2" },
        async () => await probe.session.instance.handlers.raise_after_return!(),
      )).resolves.toBe("returned");
      await vi.waitFor(() => expect(lateOutcomes()).toHaveLength(1));
      expect(lateOutcomes()).toEqual(["raised"]);
      expect(probe.requestAndWait).toHaveBeenCalledTimes(1);
      expect(probe.requestAndWait.mock.calls[0]![0]).toMatchObject({
        toolName: "raise_after_return",
        sessionId: "session-2",
        approvalScope: "raiseAlert",
      });
      expect(probe.raised).toEqual([{ key: "late", toolName: "raise_after_return" }]);
    } finally {
      await probe.session.teardown("case over");
    }
  });
});

describe("a request that names no invocation runs in none", () => {
  // A restarted child can inherit a tool spawn context; lifecycle work must still run outside that invocation.
  it.each<[string, Parameters<typeof runWithEffectGateContext>[0]]>([
    ["headless", { headless: true, approvalSurface: "unavailable", toolName: "config_set" }],
    ["foreground", { headless: false, approvalSurface: "interactive", toolName: "config_set", sessionId: "session-3" }],
  ])("ignores the %s invocation the child was spawned in", async (_label, spawnedIn) => {
    const probe = await runWithEffectGateContext(spawnedIn, () => openProbe());
    try {
      await probe.session.instance.start!();
      expect(probe.requestAndWait).not.toHaveBeenCalled();
      expect(probe.raised).toEqual([{ key: "start", toolName: undefined }]);
    } finally {
      await probe.session.teardown("case over");
    }
  });
});

describe("session cleanup always reaches the transport", () => {
  it("releases host watchers and the owner when a child subscription disposer throws", async () => {
    const probe = await openProbe({ subscriptionFailure: true });
    try {
      await expect(probe.session.instance.handlers.subscribe!()).resolves.toBe("subscribed");
      await expect(probe.session.teardown("subscription failure")).rejects.toThrow("subscription cleanup failed");
      expect(probe.stopSubscription).toHaveBeenCalledTimes(1);
      expect(probe.stopWatcher).toHaveBeenCalledTimes(2);
      expect(probe.onClosed).toHaveBeenCalledExactlyOnceWith("subscription failure");
      await expect(probe.session.channel.requestMcp("tools/list", {})).rejects.toThrow("subscription failure");
      await probe.session.teardown("repeat");
      expect(probe.stopWatcher).toHaveBeenCalledTimes(2);
      expect(probe.onClosed).toHaveBeenCalledTimes(1);
    } finally {
      probe.session.channel.closeInput();
      await probe.session.teardown("case over");
    }
  });

  it.each(["teardown", "stop"] as const)("closes the channel when a host watcher throws during %s", async (ending) => {
    const probe = await openProbe({ watcherFailure: true });
    try {
      await runWithEffectGateContext(
        { headless: false, approvalSurface: "interactive", toolName: "raise" },
        async () => await probe.session.instance.handlers.raise!(),
      );
      const closing = ending === "stop"
        ? probe.session.instance.stop!()
        : probe.session.teardown("watcher failure");
      await expect(closing).rejects.toThrow("watcher cleanup failed");
      await expect(probe.session.channel.requestMcp("tools/list", {}))
        .rejects.toThrow(/watcher failure|stopped/);
    } finally {
      probe.session.channel.closeInput();
      await probe.session.teardown("case over");
    }
  });
});
