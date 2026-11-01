import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { OwnedMxcExtensionProcess } from "../../src/permissions/mxc-extension-process.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../src/plugins/types.js";
import { attachMxcPluginChild } from "../../src/plugins/isolation/mxc-plugin-child.js";
import { openPluginProtocolSession } from "../../src/plugins/isolation/plugin-protocol-session.js";
import { createBoundHostApiDispatchTable } from "../../src/plugins/isolation/bound-host-api-table.js";
import { TOOL_TIMEOUT_POLICY } from "../../src/shared/tool-timeout-policy.js";
import { FRAME_BYTES_MAX } from "../../src/plugins/isolation/host-api-wire.js";

/** The native controller supplies pinned process ownership; this probe supplies the production plugin session. */
export async function probePluginStreams(owned: OwnedMxcExtensionProcess, directory: string, overflow: boolean) {
  const controller = new AbortController();
  let releases = 0, effects = 0, activeWatchers = 0;
  const watchers = new Map<string, Set<(value: unknown) => void>>();
  const refusalAudit: Array<{ pluginId?: unknown; method?: unknown; code?: unknown }> = [];
  const hostApi = {
    getInstalledPluginIds: () => ["stream-probe"],
    onPluginsChanged: () => () => {},
    config: {
      get: () => undefined,
      onChange: (key: string, callback: (value: unknown) => void) => {
        const callbacks = watchers.get(key) ?? new Set(); watchers.set(key, callbacks);
        callbacks.add(callback); activeWatchers++;
        return () => { if (callbacks.delete(callback)) activeWatchers--; };
      },
    },
    raiseAlert: async () => { effects++; return { status: "raised" }; },
  } as unknown as PluginHostApi;
  const child = attachMxcPluginChild(owned, {
    signal: controller.signal, release() { releases++; },
  });
  const manifest: PluginManifest = { id: "stream-probe", name: "Stream probe", version: "1.0.0", entry: "plugin.mjs",
    requires: { hostProtocol: "4" }, description: "Diagnostic stream fixture",
    tools: ["subscribe", "read", "forge", "overflow"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) };
  const context = { pluginId: manifest.id, pluginRoot: directory, pluginDataDir: directory,
    pluginSocketDir: directory, hostRoot: directory, userHome: directory, aveHome: directory, config: {},
    log() {}, hostApi } as PluginRuntimeContext;
  const session = await openPluginProtocolSession({ pluginId: manifest.id, manifest, context, hostProtocolVersion: "4",
    link: child.link, entryPath: path.join(directory, "plugin.mjs"),
    table: createBoundHostApiDispatchTable(hostApi, { read: [directory], write: [directory] }),
    auditLog: (_level, _message, data) => {
      if (data && typeof data === "object") refusalAudit.push(data);
    },
    onClosed: () => child.waitForExit(), signal: controller.signal });
  const call = (name: string) => session.channel.requestMcp("tools/call", { name, arguments: {} }, TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
  try {
    if (overflow) {
      let refused = false;
      let refusal = "";
      try { await call("overflow"); } catch (error) { refusal = String(error); refused = refusal.includes(`exceeded ${FRAME_BYTES_MAX}`); }
      await session.teardown("overflow finished");
      const terminal = await owned.completion;
      return { passed: refused && !terminal.timedOut && releases === 1 && activeWatchers === 0,
        oversizedFrameRejected: refused, refusal, frameLimit: FRAME_BYTES_MAX, terminal, releases, activeWatchers };
    }
    await call("subscribe");
    const until = Date.now() + TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs;
    while (!watchers.get("value")?.size && Date.now() < until) await pause(TOOL_TIMEOUT_POLICY.processGroupPollMs);
    if (!watchers.get("value")?.size) throw new Error("Native subscription did not register");
    for (const callback of watchers.get("value")!) callback("subscription-arrived");
    const expected = "한".repeat(256 * 1024), expectedSha256 = createHash("sha256").update(expected).digest("hex");
    let largeOutputVerified = true;
    const results: Array<{ bytes: number; sha256: string; subscriptionValue: string }> = [];
    for (let index = 0; index < 8; index++) {
      const reading = call("read");
      owned.stdout.pause();
      await pause(TOOL_TIMEOUT_POLICY.processGroupPollMs);
      owned.stdout.resume();
      const frame = await reading as { content: { text: string }[] };
      const value = JSON.parse(frame.content[0]!.text) as { seen: string; bytes: string };
      const sha256 = createHash("sha256").update(value.bytes).digest("hex");
      results.push({ bytes: Buffer.byteLength(value.bytes), sha256, subscriptionValue: value.seen });
      largeOutputVerified &&= value.seen === "subscription-arrived" && sha256 === expectedSha256;
    }
    const forged = await call("forge") as { content: { text: string }[] };
    const forgedIdentityRejected = forged.content[0]?.text.includes("argument-marshalling-rejected") === true && effects === 0
      && refusalAudit.some((entry) => entry.pluginId === manifest.id && entry.method === "raiseAlert" && entry.code === "argument-marshalling-rejected");
    controller.abort();
    await session.teardown("native revocation");
    const terminal = await owned.completion;
    return { passed: largeOutputVerified && forgedIdentityRejected && !terminal.timedOut && releases === 1 && activeWatchers === 0,
      handshake: true, subscription: true, largeOutputVerified, slowReadCycles: 8,
      results, expectedSha256, forgedIdentityRejected, refusalAudit, effects, terminal, releases, activeWatchers };
  } finally { owned.stdout.resume(); await session.teardown("probe finished"); }
}
