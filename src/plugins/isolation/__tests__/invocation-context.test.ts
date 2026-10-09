/**
 * An out-of-process plugin's hostApi call runs in the host invocation it was
 * made for.
 *
 * In-process, a tool handler's hostApi call inherits the invocation's async
 * context, and with it the effect gate (`runWithEffectGateContext`): a gated
 * write asks the user in the foreground and fails closed headless. Across a
 * process boundary nothing inherits anything. The request arrives on the
 * child's pipe, in the context of whatever delivered it, and the gate reads
 * "no invocation" and lets the write through unasked. That was the state after
 * every entry plugin moved out of process: `raiseAlert` from a plugin tool
 * raised its alert with no approval, and would have done so in a headless
 * routine too.
 *
 * The link below delivers every frame through a callback bound at link
 * creation, so no async context crosses it, exactly as with a real child. The
 * child end is the real child runtime; the host end is the real session, the
 * bound dispatch table and the real effect gate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  requires: { hostProtocol: "2" },
  description: "a plugin whose tool raises an alert",
  tools: [
    { name: "raise", description: "raise", inputSchema: { type: "object", properties: {} } },
    { name: "raise_after_return", description: "raise later", inputSchema: { type: "object", properties: {} } },
  ],
};

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
    raise_after_return: async () => {
      setTimeout(() => { context.hostApi.raiseAlert({ kind: "reply", key: "late" }).catch(() => undefined); }, 0);
      return "returned";
    },
  },
  stop: async () => undefined,
});
`,
    "utf-8",
  );
});

afterAll(() => {
  rmSync(moduleDir, { recursive: true, force: true });
});

/**
 * A child link with no async-context bleed: both directions are pumped by
 * callbacks bound when the link is made, outside any invocation.
 */
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
  /** What the real implementation saw, per call: the gate context it ran in. */
  raised: Array<{ key: unknown; toolName: string | undefined }>;
  requestAndWait: ReturnType<typeof vi.fn>;
}

async function openProbe(): Promise<Probe> {
  const raised: Probe["raised"] = [];
  const requestAndWait = vi.fn(async () => ({ choice: "allow-once" as const }));
  const watch = () => () => undefined;
  const plain = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: watch,
    config: { get: () => undefined, set: async () => undefined, onChange: watch },
    raiseAlert: async (input: { key?: unknown }) => {
      raised.push({ key: input.key, toolName: currentEffectGateContext()?.toolName });
      return { status: "raised", alertId: `alert-${String(input.key)}` };
    },
  };
  // The production order: the gate wraps the implementation, and the bound
  // table dispatches into the gated object.
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
    hostProtocolVersion: "2",
    link: isolatedLink(),
    context,
    entryPath,
    table: createBoundHostApiDispatchTable(hostApi, ENVELOPE),
    onClosed: async () => undefined,
  });
  return { session, raised, requestAndWait };
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

  it("gives a call made after the tool returned no invocation, as in-process background work", async () => {
    const probe = await openProbe();
    try {
      await expect(runWithEffectGateContext(
        { headless: true, approvalSurface: "unavailable", toolName: "raise_after_return" },
        async () => await probe.session.instance.handlers.raise_after_return!(),
      )).resolves.toBe("returned");
      await vi.waitFor(() => expect(probe.raised).toHaveLength(1));
      // Its token named a call no longer in flight, so it borrowed nothing:
      // not the returned call's headless deny, nor its tool identity.
      expect(probe.raised).toEqual([{ key: "late", toolName: undefined }]);
      expect(probe.requestAndWait).not.toHaveBeenCalled();
    } finally {
      await probe.session.teardown("case over");
    }
  });
});
