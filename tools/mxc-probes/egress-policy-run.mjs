import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { windowsQuote } from "./probe-common.mjs";

export function egressPolicyObservationPassed(result, attribution, expectedAttribution, unexpectedAccepts) {
  const denied = (value) => value?.connected === false && ["EACCES", "EPERM"].includes(value.error);
  return result?.ownAllowed?.status === 200 && result?.ownDenied?.status === 403
    && denied(result.otherListener) && denied(result.unrelatedListener) && denied(result.directEgress)
    && unexpectedAccepts === 0 && JSON.stringify(attribution) === JSON.stringify(expectedAttribution);
}

/** Real endpoint restrictions with independently observed host accepts and stamped labels. */
export async function runEgressPolicyProbe({ launch, request, temp, ioBudget, bounded }) {
  const { openInvocationProxyListener } = await import(new URL("../../node_modules/.cache/mxc-egress-listener.mjs", import.meta.url));
  const sockets = new Set();
  const servers = [];
  const listeners = [];
  const attribution = [];
  const refusals = [];
  let unrelatedAccepts = 0, otherAccepts = 0, otherPort;
  const originalEmit = net.Server.prototype.emit;
  // Observe the production server's accepts independently of the confined fixture's report.
  net.Server.prototype.emit = function (event, ...args) {
    if (event === "connection" && this.address()?.port === otherPort) otherAccepts++;
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  const listen = async (server) => {
    servers.push(server);
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    // Loopback only: a wildcard listener would expose fixtures on every interface and can make Windows Defender
    // Firewall prompt and persist an inbound rule for the runtime executable.
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return server.address().port;
  };
  const auth = (owner) => `Basic ${Buffer.from(owner + ":fixture").toString("base64")}`;
  try {
    const upstream = http.createServer((request, response) => {
      attribution.push({ owner: request.headers["proxy-authorization"], target: request.url });
      const allowed = request.url === "http://allowed.example/fixture";
      response.writeHead(allowed ? 200 : 403); response.end(allowed ? "fixture-success" : "fixture-denied");
    });
    const upstreamPort = await listen(upstream);
    const unrelatedPort = await listen(net.createServer((socket) => { unrelatedAccepts++; socket.end(); }));
    const directHost = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (!directHost) throw new Error("A non-loopback host IPv4 address is required for the direct-egress fixture");
    // Positive host controls. Loopback reaches the unrelated fixture. No listener exists on the non-loopback
    // address, so the host's own connection there must be actively refused (ECONNREFUSED): the address is routable
    // and answered by the host stack, and the container's EACCES/EPERM is then a policy refusal, not a missing route.
    const loopbackControl = await bounded(new Promise((resolve, reject) => {
      const socket = net.connect(unrelatedPort, "127.0.0.1", () => { socket.end(); resolve(true); });
      sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.once("error", reject);
    }), ioBudget);
    const directControl = await bounded(new Promise((resolve, reject) => {
      const socket = net.connect(unrelatedPort, directHost, () => {
        socket.destroy(); reject(new Error("Direct-egress control unexpectedly connected; the fixture port is not closed on the host address"));
      });
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve("ECONNREFUSED")
        : reject(new Error(`Direct-egress host control was not actively refused: ${error.code ?? error.message}`)));
    }), ioBudget);
    const initialAccepts = unrelatedAccepts;
    for (const owner of ["holder-a", "holder-b"]) {
      const listener = await openInvocationProxyListener({
        upstream: () => ({ host: "127.0.0.1", port: upstreamPort, proxyAuthorization: auth(owner) }),
        onRefused: (destination, reason) => refusals.push({ owner, destination, reason }),
      });
      listeners.push(listener);
    }
    otherPort = listeners[1].port;
    // A host positive control records B's independently reachable endpoint before confinement.
    const bControl = await bounded(new Promise((resolve, reject) => {
      const socket = net.connect(listeners[1].port, "127.0.0.1", () => { socket.end(); resolve(true); });
      sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.once("error", reject);
    }), ioBudget);
    if (otherAccepts !== 1) throw new Error("Other-holder listener positive control was not independently observed");
    const initialOtherAccepts = otherAccepts;
    const child = path.join(temp, "egress-policy-child.mjs");
    await copyFile(new URL("./egress-policy-child.mjs", import.meta.url), child);
    const config = request(process.execPath, [child], false);
    const childConfig = { ownPort: listeners[0].port, otherPort: listeners[1].port, unrelatedPort, directHost,
      forgedAuthorization: auth("holder-b"), deadline: ioBudget };
    config.command += " " + windowsQuote(JSON.stringify(childConfig));
    config.network.runtimeConfig.networkProxy = listeners[0].url;
    const active = await launch(config, "script-file");
    active.stdin.end();
    const completion = await bounded(active.completion);
    if (completion.error || completion.value?.timedOut || completion.value?.exitCode !== 0) throw new Error(`Native egress fixture failed: ${JSON.stringify(completion)}; ${active.stderr}`);
    const lines = active.stdout.trim().split(/\r?\n/);
    const result = JSON.parse(lines.at(-1));
    const expectedAttribution = [{ owner: auth("holder-a"), target: "http://allowed.example/fixture" }, { owner: auth("holder-a"), target: "http://denied.example/fixture" }];
    const passed = egressPolicyObservationPassed(result, attribution, expectedAttribution,
      unrelatedAccepts - initialAccepts + otherAccepts - initialOtherAccepts);
    return [{ ...result, accepted: passed, passed, attribution, refusals, hostControls: { loopback: loopbackControl, direct: directControl, otherListener: bControl },
      unrelatedAcceptsAfterBaseline: unrelatedAccepts - initialAccepts, holderProxyPorts: listeners.map((listener) => listener.port),
      otherListenerAcceptsAfterBaseline: otherAccepts - initialOtherAccepts,
      workerControlPorts: [], identity: "kernel-channel", peerOwnerAuthentication: false,
      boundary: "production listener with diagnostic upstream; production destination policy and audit remain a separate integration gate" }];
  } finally {
    net.Server.prototype.emit = originalEmit;
    await Promise.all(listeners.map((listener) => listener.close()));
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
