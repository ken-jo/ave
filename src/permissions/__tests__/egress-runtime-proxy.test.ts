import { randomUUID } from "node:crypto";
import net, { type AddressInfo, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
import * as policyHome from "../../shared/policy-home.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { SandboxManager, type SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import type { ApprovalDecision, ApprovalRequestInput } from "../approval-gate.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { openHostEgressListener } from "../egress-host-listener.js";
import { openInvocationProxyListener } from "../egress-invocation-listener.js";
import { openEgressInvocation, type EgressInvocation } from "../egress-invocations.js";
import { createEgressAskRuntimeCallback, listEgressGrants, revokeEgressGrant } from "../egress-runtime.js";
import type { EgressGrantScope } from "../../shared/egress-grant-scopes.js";

const DESTINATION = { host: "8.8.8.8", port: 443 };
const sockets = new Set<Socket>();
const invocations: EgressInvocation[] = [];
const listeners: Array<{ close(): Promise<void> }> = [];
const servers: net.Server[] = [];
const policyFixture = useTempDirs("egress-stamp-floor-");

beforeEach(() => {
  vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([policyFixture()]);
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const invocation of invocations.splice(0)) invocation.release();
  for (const listener of listeners.splice(0).reverse()) await listener.close();
  await resetAsrtSandbox();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const grant of await listEgressGrants()) await revokeEgressGrant(grant);
  vi.restoreAllMocks();
});

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

function openShell(sessionId = randomUUID(), workspaceRoot = join(process.cwd(), "socket-workspace")) {
  const invocation = openEgressInvocation({
    kind: "shell",
    toolName: "powershell",
    toolUseId: randomUUID(),
    context: { sessionId, workspaceRoot, approvalSurface: "interactive" },
  });
  invocations.push(invocation);
  return invocation;
}

// All destination bytes terminate at this local endpoint.
async function localUpstream() {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    track(socket);
    let head = "";
    const onHead = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      received.push(head);
      socket.off("data", onHead);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    };
    socket.on("data", onHead);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { port: (server.address() as AddressInfo).port, received };
}

interface ObservedAsk {
  readonly host: string;
  readonly context: Parameters<SandboxAskCallback>[1];
}

async function startRuntime(answerScope: () => EgressGrantScope = () => "session") {
  const upstream = await localUpstream();
  const observed: ObservedAsk[] = [];
  // This controlled gate exercises production request conversion and grant storage. It does not stand in for a person's installed-app approval.
  const requestAndWait = vi.fn(async (request: ApprovalRequestInput): Promise<ApprovalDecision> => ({
    requestId: request.id,
    choice: "allow-once",
    egressScope: answerScope(),
  }));
  const callback = createEgressAskRuntimeCallback({
    approvalGate: { requestAndWait },
    shellAskEnabled: () => true,
  });
  await initializeAsrtSandbox({
    allowedDomains: [],
    windows: { externalConfinement: true, proxyPortRange: [42000, 42009] },
    upstreamRouter: async () => ({ routes: [{ kind: "http", host: "127.0.0.1", port: upstream.port }] }),
  }, async (destination, context) => {
    observed.push({ host: destination.host, context });
    return callback(destination, context);
  });
  const port = SandboxManager.getProxyPort();
  const credential = SandboxManager.getProxyAuthToken();
  if (port === undefined || credential === undefined) throw new Error("Shared proxy was not initialized");
  return { upstream, observed, requestAndWait, sharedPort: port, credential };
}

function proxyAuthorization(token: string, credential: string): string {
  const username = `srt.${Buffer.from(token).toString("base64")}`;
  return `Basic ${Buffer.from(`${username}:${credential}`).toString("base64")}`;
}

async function invocationFrontend(token: string) {
  const relay = await openHostEgressListener(token);
  listeners.push(relay);
  const frontend = await openInvocationProxyListener({
    upstream: () => ({ host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }),
    onRefused: relay.recordRefusal,
  });
  relay.registerPort(frontend.port);
  listeners.push(frontend);
  return frontend;
}

function connect(port: number, authorization?: string) {
  let response = "";
  const socket = track(net.connect(port, "127.0.0.1", () => {
    const auth = authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`;
    socket.write(`CONNECT ${DESTINATION.host}:${DESTINATION.port} HTTP/1.1\r\nHost: ${DESTINATION.host}:${DESTINATION.port}\r\n${auth}\r\n`);
  }));
  socket.on("data", (chunk: Buffer) => { response += chunk.toString("latin1"); });
  return { socket, response: () => response };
}

async function expectResponse(client: ReturnType<typeof connect>, status: number): Promise<void> {
  await expect.poll(client.response).toMatch(new RegExp(`^HTTP/1\\.1 ${status}\\b`, "u"));
}

describe.skipIf(process.platform !== "win32")("native proxy with production egress callback", () => {
  it("keeps the invocation listener identity through the ordinary shell frontend", async () => {
    // Owner 2026-10-25 (five-choice network card): a shell call is offered once, This session, This project and Always (with Deny).
    const runtime = await startRuntime(() => "always");
    const invocation = openShell();
    const other = openShell();
    const frontend = await invocationFrontend(invocation.token);
    const client = connect(frontend.port, proxyAuthorization(other.token, runtime.credential));
    await expectResponse(client, 200);

    expect(runtime.observed.length).toBeGreaterThan(0);
    expect(runtime.observed.every(({ context }) => context?.identity === "listener"
      && context.attributionKey === invocation.token)).toBe(true);
    expect(runtime.requestAndWait).toHaveBeenCalledTimes(1);
    expect(runtime.requestAndWait.mock.calls[0]?.[0]).toMatchObject({
      kind: "egress-host", toolName: "powershell", sessionId: invocation.owner.kind === "shell" ? invocation.owner.context.sessionId : undefined,
      forceExplicit: true, durableApprovalRecordAllowed: false,
      egressHost: { ...DESTINATION, scopes: ["once", "session", "project", "always"], network: "public" },
    });
    expect(await listEgressGrants()).toEqual([expect.objectContaining({
      scope: "always", origin: "shell", ...DESTINATION, network: "public",
    })]);
    expect(runtime.upstream.received).toHaveLength(1);
  });

  it("offers a shared frontend shell call only the in-memory scopes, without reusing or deleting a stronger stored grant", async () => {
    let scope: EgressGrantScope = "always";
    const runtime = await startRuntime(() => scope);
    const invocation = openShell();
    const frontend = await invocationFrontend(invocation.token);
    await expectResponse(connect(frontend.port), 200);
    const stronger = (await listEgressGrants()).filter((grant) => grant.scope === "always");
    expect(stronger).toEqual([expect.objectContaining({ scope: "always", origin: "shell", ...DESTINATION, network: "public" })]);

    scope = "once";
    runtime.observed.length = 0;
    await expectResponse(connect(runtime.sharedPort, proxyAuthorization(invocation.token, runtime.credential)), 200);
    expect(runtime.observed.every(({ context }) => context?.identity === "username"
      && context.attributionKey === invocation.token)).toBe(true);
    expect(runtime.requestAndWait).toHaveBeenCalledTimes(2);
    expect(runtime.requestAndWait.mock.calls[1]?.[0]).toMatchObject({
      forceExplicit: true, durableApprovalRecordAllowed: false,
      // A shared channel keeps shell grants to the in-memory rungs: once and This session.
      egressHost: { ...DESTINATION, scopes: ["once", "session"], network: "public" },
    });
    const grants = await listEgressGrants();
    expect(grants.filter((grant) => grant.scope === "always")).toEqual(stronger);
    expect(grants).toHaveLength(stronger.length);
    const nextInvocation = openShell();
    const nextFrontend = await invocationFrontend(nextInvocation.token);
    await expectResponse(connect(nextFrontend.port), 200);
    expect(runtime.requestAndWait).toHaveBeenCalledTimes(2);
    expect((await listEgressGrants()).filter((grant) => grant.scope === "always")).toEqual(stronger);
    expect(runtime.upstream.received).toHaveLength(3);
  });

  it.each(["missing", "wrong"] as const)("refuses %s shared proxy credentials before calling the production policy", async (kind) => {
    const runtime = await startRuntime();
    const invocation = openShell();
    const authorization = kind === "missing" ? undefined : proxyAuthorization(invocation.token, `${runtime.credential}-wrong`);
    await expectResponse(connect(runtime.sharedPort, authorization), 407);
    expect(runtime.observed).toEqual([]);
    expect(runtime.requestAndWait).not.toHaveBeenCalled();
    expect(runtime.upstream.received).toEqual([]);
    expect(await listEgressGrants()).toEqual([]);
  });

  it.each(["unknown", "released"] as const)("refuses %s tokens despite valid shared proxy credentials", async (kind) => {
    const runtime = await startRuntime();
    const invocation = openShell();
    const token = kind === "unknown" ? randomUUID().replaceAll("-", "") : invocation.token;
    if (kind === "released") invocation.release();
    await expectResponse(connect(runtime.sharedPort, proxyAuthorization(token, runtime.credential)), 403);
    expect(runtime.observed.length).toBeGreaterThan(0);
    expect(runtime.observed.every(({ context }) => context?.identity === "username"
      && context.attributionKey === token)).toBe(true);
    expect(runtime.requestAndWait).not.toHaveBeenCalled();
    expect(runtime.upstream.received).toEqual([]);
    expect(await listEgressGrants()).toEqual([]);
  });

  it("refuses a shared answer selecting a durable scope that the real request did not offer", async () => {
    const runtime = await startRuntime(() => "project");
    const invocation = openShell();
    await expectResponse(connect(runtime.sharedPort, proxyAuthorization(invocation.token, runtime.credential)), 403);
    expect(runtime.requestAndWait).toHaveBeenCalledTimes(1);
    expect(runtime.requestAndWait.mock.calls[0]?.[0].egressHost?.scopes).toEqual(["once", "session"]);
    expect(runtime.upstream.received).toEqual([]);
    expect(await listEgressGrants()).toEqual([]);
  });
});
