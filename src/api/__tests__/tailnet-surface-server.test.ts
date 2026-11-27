import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthorizedTailnetController,
  isAuthorizedTailnetObserver,
  startTailnetSurfaceServer,
  type TailnetPairingOptions,
  type TailnetSurfaceServer,
  type TailnetWebOptions,
} from "../tailnet-surface-server.js";
import { TailnetControllerReceiptStore } from "../tailnet-controller-receipt-store.js";
import { createPlatformConversationTimeline } from "../../engine/conversation-platform-protocol.js";
import { createSharedConversationProjectionStore } from "../../engine/shared-conversation-projection.js";
import type { ConversationCommandPort } from "../../main/conversation-command-port.js";
import type { TailnetPairedShareAuthorizer } from "../../main/tailnet-paired-share-authorizer.js";
import type { TailnetAuthorization } from "../../shared/tailnet-observer-config.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import { openEgressRelay, startEgressRelayService, stopEgressRelayService } from "../../permissions/egress-relay/relay.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import type { TailnetWorkDecisionRequest, TailnetWorkReviewSnapshot } from "../../shared/tailnet-work-decisions.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import * as tailnetListenerPolicy from "../../permissions/tailnet-listener-policy.js";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { quoteSandboxWrappedWord } from "../../permissions/sandbox-wrapped-command.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { RoutinesStore } from "../../main/routines-store.js";
import { createTailnetObserverConfigService } from "../../main/tailnet-observer-config-service.js";
import { maybeStartTailnetObserverServer, resetTailnetObserverServerForTests, stopTailnetObserverServer, type TailnetObserverConfigFile } from "../../main/tailnet-surface-server.js";
import type { TailnetPairedSharingRuntime } from "../../main/tailnet-paired-sharing-runtime.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import { createTailnetWorkDecisions } from "../../main/tailnet-work-decisions.js";
import { itemDigestOf } from "../../main/work-board-store.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";

const CAPABILITY = "ave.example.com/cap/conversation-observer";
const APP_CAPABILITY = Object.freeze({ kind: "app-capability" as const, capability: CAPABILITY });
const CONVERSATION_ID = "owner-session-do-not-expose";
const OWNER_ONLY_SENTINEL = "OWNER_ONLY_SECRET_DO_NOT_EXPOSE";
const WEB_ORIGIN = "https://ave.example.ts.net";
const PNG = Buffer.from("iVBORw0KGgo=", "base64");

let servers: TailnetSurfaceServer[] = [];
let stores: ReturnType<typeof createSharedConversationProjectionStore>[] = [];
let receiptDirs: string[] = [];

afterEach(async () => {
  const active = servers;
  servers = [];
  await Promise.all(active.map((server) => server.close()));
  for (const store of stores) store.stop();
  stores = [];
  for (const directory of receiptDirs.splice(0)) await cleanupTmpDir(directory);
});

interface FixtureOptions {
  readonly port?: number;
  readonly probeOwnerIdentity?: () => Promise<import("../../main/tailnet-owner-policy.js").TailnetOwnerIdentityEvidence>;
  readonly ownerIdentityError?: (login: string, evidence: import("../../main/tailnet-owner-policy.js").TailnetOwnerIdentityEvidence) => import("../../shared/tailnet-sharing.js").TailnetOwnerIdentityErrorCode | null;
  readonly authorization?: TailnetAuthorization;
  readonly conversationId?: () => string;
  readonly replayLimitPerConversation?: number;
  readonly maxConnections?: number;
  readonly maxWebReadRequestsPerWindow?: number;
  readonly maxStreamLifetimeMs?: number;
  readonly controllerCommandPort?: ConversationCommandPort;
  readonly controllerReceiptStore?: TailnetControllerReceiptStore;
  readonly maxRequestsPerWindow?: number;
  readonly pairedSharing?: TailnetPairedShareAuthorizer;
  readonly pairing?: TailnetPairingOptions;
  readonly requestWindowMs?: number;
  readonly web?: TailnetWebOptions;
}

async function fixture(options: FixtureOptions = {}) {
  const timeline = createPlatformConversationTimeline();
  const receiptStore = options.controllerCommandPort === undefined
    ? undefined
    : options.controllerReceiptStore ?? createReceiptStore();
  const store = createSharedConversationProjectionStore(timeline, {
    ...(options.replayLimitPerConversation === undefined
      ? {}
      : { replayLimitPerConversation: options.replayLimitPerConversation }),
  });
  stores.push(store);
  const server = await startTailnetSurfaceServer({
    probeOwnerIdentity: options.probeOwnerIdentity ?? (async () => ({ revision: 1, ownerLogin: "owner@example.com" })),
    ownerIdentityError: options.ownerIdentityError ?? (() => null),
    port: options.port ?? await reservePort(),
    authorization: options.authorization ?? APP_CAPABILITY,
    projectionStore: store,
    getCurrentConversationId: options.conversationId ?? (() => CONVERSATION_ID),
    ...(options.maxWebReadRequestsPerWindow === undefined
      ? {} : { maxWebReadRequestsPerWindow: options.maxWebReadRequestsPerWindow }),
    isConversationBusy: () => false,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.maxStreamLifetimeMs === undefined
      ? {}
      : { maxStreamLifetimeMs: options.maxStreamLifetimeMs }),
    ...(options.maxRequestsPerWindow === undefined
      ? {}
      : { maxRequestsPerWindow: options.maxRequestsPerWindow }),
    ...(options.requestWindowMs === undefined ? {} : { requestWindowMs: options.requestWindowMs }),
    ...((options.pairedSharing ?? (options.controllerCommandPort === undefined ? undefined : pairedSharing({ observe: true, control: true }).authorizer)) === undefined ? {} : { pairedSharing: options.pairedSharing ?? pairedSharing({ observe: true, control: true }).authorizer }),
    ...(options.pairing === undefined ? {} : { pairing: options.pairing }),
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.controllerCommandPort === undefined
      ? {}
      : { controller: { commandPort: options.controllerCommandPort, receiptStore: receiptStore! } }),
  });
  servers.push(server);
  return { timeline, store, server };
}

function createReceiptStore(): TailnetControllerReceiptStore {
  const directory = mkdtempSync(join(tmpdir(), "ave-tailnet-surface-receipts-"));
  receiptDirs.push(directory);
  return new TailnetControllerReceiptStore({ filePath: join(directory, "command-receipts.json") });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observerHeaders(role = "observer"): Record<string, string> {
  return {
    "Tailscale-User-Login": "owner@example.com",
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: [{ role }],
    }),
  };
}

function controllerHeaders(): Record<string, string> {
  return {
    "Tailscale-User-Login": "owner@example.com",
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: [{ role: "controller" }],
    }),
  };
}
const PAIRED_ACTOR_ID: `tailnet:${string}` = `tailnet:${"e".repeat(64)}`;
const PAIRED_SHARE = Object.freeze({
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingEpoch: 1,
  shareId: "22222222-2222-4222-8222-222222222222",
  shareEpoch: 1,
  scope: "33333333-3333-4333-8333-333333333333",
});

function pairedSharing(options: Readonly<{ observe: boolean; control: boolean; expiresAt?: number }>) {
  let active = true;
  const listeners = new Set<() => void>();
  const pairedShareGuard = {
    isCurrent(binding: typeof PAIRED_SHARE): boolean {
      return active
        && binding.pairingId === PAIRED_SHARE.pairingId
        && binding.pairingEpoch === PAIRED_SHARE.pairingEpoch
        && binding.shareId === PAIRED_SHARE.shareId
        && binding.shareEpoch === PAIRED_SHARE.shareEpoch
        && binding.scope === PAIRED_SHARE.scope;
    },
    async refreshCurrent(binding: typeof PAIRED_SHARE): Promise<boolean> {
      return pairedShareGuard.isCurrent(binding);
    },
  };
  const authorizer: TailnetPairedShareAuthorizer = {
    probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => "owner@example.com", ownerIdentityError: () => null, actorIdFor: (login) => login === "owner@example.com" ? PAIRED_ACTOR_ID : null,
    authorize(login, conversationId, required) {
      if (
        !active
        || login !== "owner@example.com"
        || conversationId !== CONVERSATION_ID
        || (required === "observe" && !options.observe)
        || (required === "control" && !options.control)
      ) {
        return null;
      }
      return {
        actorId: PAIRED_ACTOR_ID,
        pairedShare: PAIRED_SHARE,
        pairedShareGuard,
        permission: options.control ? "control" : "observe",
        expiresAt: options.expiresAt ?? Number.MAX_SAFE_INTEGER,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    authorizer,
    revoke: () => {
      active = false;
      for (const listener of [...listeners]) listener();
    },
  };
}



function url(server: TailnetSurfaceServer, path: string): string {
  return "http://127.0.0.1:" + server.port + path;
}
function tailnetRoleHeaders(
  roles: readonly ("observer" | "controller" | "pairing" | "work-decision")[],
  login = "owner@example.com",
): Record<string, string> {
  return {
    "Tailscale-User-Login": login,
    "Tailscale-App-Capabilities": JSON.stringify({
      [CAPABILITY]: roles.map((role) => ({ role })),
    }),
  };
}

function webSessionHeaders(
  cookieToken: string,
  csrfToken: string,
  roles: readonly ("observer" | "controller" | "pairing" | "work-decision")[] = ["observer"],
  login = "owner@example.com",
): Record<string, string> {
  return {
    ...tailnetRoleHeaders(roles, login),
    Cookie: "__Host-ave-tailnet-v2=" + cookieToken,
    Origin: WEB_ORIGIN,
    Referer: WEB_ORIGIN + "/tailnet/v2/web",
    "Sec-Fetch-Site": "same-origin",
    "X-Ave-Tailnet-Csrf": csrfToken,
  };
}

interface RawWebDocumentResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

function responseHeader(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : value?.join("; ") ?? "";
}

async function requestTailnetGet(
  server: TailnetSurfaceServer,
  path: string,
  headers: Record<string, string>,
  agent?: HttpAgent,
): Promise<RawWebDocumentResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url(server, path), { method: "GET", headers, agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers as RawWebDocumentResponse["headers"],
        body,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
async function requestWebDocument(
  server: TailnetSurfaceServer,
  headers: Record<string, string>,
): Promise<RawWebDocumentResponse> {
  return requestTailnetGet(server, "/tailnet/v2/web", headers);
}

async function openWebSession(
  server: TailnetSurfaceServer,
  headers: Record<string, string> = observerHeaders(),
): Promise<Readonly<{ html: string; cookieToken: string; csrfToken: string; setCookie: string; csp: string }>> {
  const response = await requestWebDocument(
    server,
    {
      ...headers,
      "Sec-Fetch-Site": headers["Sec-Fetch-Site"] ?? "none",
      "Sec-Fetch-Mode": headers["Sec-Fetch-Mode"] ?? "navigate",
      "Sec-Fetch-Dest": headers["Sec-Fetch-Dest"] ?? "document",
    },
  );
  const html = response.body;
  const setCookie = responseHeader(response.headers["set-cookie"]);
  const csp = responseHeader(response.headers["content-security-policy"]);
  const cookieToken = /__Host-ave-tailnet-v2=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  const csrfToken = /"csrfToken":"([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  if (response.status !== 200 || cookieToken === undefined || csrfToken === undefined) {
    throw new Error("could not open Tailnet Web session");
  }
  return Object.freeze({ html, cookieToken, csrfToken, setCookie, csp });
}


async function reservePort(): Promise<number> {
  const probe = createNetServer();
  const port = await listenFetchLoopback(probe);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  includes: string,
  timeoutMs = 1_000,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("tailnet SSE read timed out")), timeoutMs);
  });
  try {
    let received = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), timeoutPromise]);
      if (chunk.done) return received;
      received += new TextDecoder().decode(chunk.value);
      if (received.includes(includes)) return received;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function dataFrames(stream: string): unknown[] {
  return [...stream.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!));
}

describe("Tailnet observer authorization", () => {
  it("requires a human identity and the exact observer app capability", () => {
    expect(isAuthorizedTailnetObserver(observerHeaders() as never, APP_CAPABILITY)).toBe(true);
    expect(isAuthorizedTailnetObserver({
      "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "observer" }] }),
    }, APP_CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver(observerHeaders("controller") as never, APP_CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "   ",
      "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "observer" }] }),
    }, APP_CAPABILITY)).toBe(false);
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "owner@example.com",
      "tailscale-app-capabilities": "{invalid",
    }, APP_CAPABILITY)).toBe(false);
  });

  it("fails closed for an oversized capability header", () => {
    expect(isAuthorizedTailnetObserver({
      "tailscale-user-login": "owner@example.com",
      "tailscale-app-capabilities": "x".repeat(16 * 1024 + 1),
    }, APP_CAPABILITY)).toBe(false);
  });

  it("requires the separately granted controller role for remote commands", () => {
    expect(isAuthorizedTailnetController(controllerHeaders() as never, APP_CAPABILITY)).toBe(true);
    expect(isAuthorizedTailnetController(observerHeaders() as never, APP_CAPABILITY)).toBe(false);
  });
});

describe("Tailnet observer HTTP boundary", () => {
  it("refuses to bind inside the effective confined-worker loopback range", async () => {
    const port = await reservePort();
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const range = vi.spyOn(sandbox, "getWindowsProxyPortRange").mockReturnValue([port, port]);
    try {
      await expect(fixture({ port })).rejects.toThrow("tailnet-observer-port-confined-worker-range");
    } finally {
      range.mockRestore();
      platform.mockRestore();
    }
  });

  it("binds only fixed literal loopback ports", async () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    stores.push(store);
    const options = {
      probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), ownerIdentityError: () => null,
      port: await reservePort(),
      authorization: APP_CAPABILITY,
      projectionStore: store,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
    };

    await expect(startTailnetSurfaceServer({ ...options, host: "localhost" })).rejects.toThrow(
      "literal 127.0.0.1",
    );
    await expect(startTailnetSurfaceServer({ ...options, port: 0 })).rejects.toThrow(
      "nonzero TCP port",
    );
    await expect(startTailnetSurfaceServer({
      ...options,
      authorization: { kind: "app-capability", capability: "__proto__" },
    })).rejects.toThrow("valid authorization boundary");
    await expect(startTailnetSurfaceServer({
      ...options,
      pairedSharing: pairedSharing({ observe: true, control: true }).authorizer,
      controller: {
        commandPort: { execute: vi.fn() } as unknown as ConversationCommandPort,
        receiptStore: createReceiptStore(),
      },
    })).rejects.toThrow("reservable conversation command port");
    const sharing = pairedSharing({ observe: true, control: false });
    await expect(startTailnetSurfaceServer({
      ...options,
      web: { origin: WEB_ORIGIN },
    })).rejects.toThrow("tailnet web requires paired sharing");
    await expect(startTailnetSurfaceServer({
      ...options,
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN + "/" },
    })).rejects.toThrow("tailnet web requires paired sharing");

  });

  it("exposes neither Local API nor A2A routes and never trusts a bearer", async () => {
    const { server } = await fixture();

    const unauthenticated = await fetch(url(server, "/tailnet/v1/status"));
    expect(unauthenticated.status).toBe(401);

    const localApi = await fetch(url(server, "/v1/health"), {
      headers: observerHeaders(),
    });
    expect(localApi.status).toBe(404);

    const a2a = await fetch(url(server, "/a2a/agent/.well-known/agent-card.json"), {
      headers: observerHeaders(),
    });
    expect(a2a.status).toBe(404);

    const mutation = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      method: "POST",
      headers: observerHeaders(),
    });
    expect(mutation.status).toBe(405);

    const bearerOnly = await fetch(url(server, "/tailnet/v1/status"), {
      headers: { Authorization: "Bearer local-api-secret" },
    });
    expect(bearerOnly.status).toBe(401);

    const disabledController = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(disabledController.status).toBe(404);
  });

  it("requires an active P2 pairing/share even after Tailscale capability authorization", async () => {
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({ pairedSharing: sharing.authorizer });

    const response = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "pairing-share-required" });
  });

  it("requires a separate P2 control share before a controller command is admitted", async () => {
    const sharing = pairedSharing({ observe: true, control: false });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    expect(status.status).toBe(200);
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;

    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        id: "paired-control-required-0001",
        type: "conversation.send",
        input: "must not be admitted",
        scope,
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "pairing-share-required" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("closes a P2 paired observer stream as soon as the local owner revokes its share", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({ pairedSharing: sharing.authorizer });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(scope)),
      { headers: observerHeaders(), signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    sharing.revoke();

    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    controller.abort();
  });


  it("issues a browser session only behind P2 sharing and blocks native browser bypass", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { timeline, server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "safe Tailnet response" },
    });
    const session = await openWebSession(server);

    expect(session.setCookie).toMatch(
      /^__Host-ave-tailnet-v2=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
    );
    expect(session.csp).toContain("default-src 'none'");
    expect(session.csp).toContain("connect-src 'self'");
    expect(session.csp).toContain("frame-ancestors 'none'");
    expect(session.html).toContain("textContent");
    expect(session.html).not.toContain(session.cookieToken);
    expect(session.html).not.toContain(CONVERSATION_ID);
    expect(session.html).not.toContain(OWNER_ONLY_SENTINEL);
    expect(session.html).not.toContain(PAIRED_ACTOR_ID);

    const nativeBrowser = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: { ...observerHeaders(), Origin: WEB_ORIGIN },
    });
    expect(nativeBrowser.status).toBe(403);
    expect(await nativeBrowser.json()).toMatchObject({ error: "browser-observer-not-ready" });

    const noCookie = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: {
        ...tailnetRoleHeaders(["observer"]),
        Origin: WEB_ORIGIN,
        Referer: WEB_ORIGIN + "/tailnet/v2/web",
        "Sec-Fetch-Site": "same-origin",
        "X-Ave-Tailnet-Csrf": session.csrfToken,
      },
    });
    expect(noCookie.status).toBe(401);

    const wrongOrigin = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: { ...webSessionHeaders(session.cookieToken, session.csrfToken), Origin: "https://wrong.ts.net" },
    });
    expect(wrongOrigin.status).toBe(403);

    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("access-control-allow-origin")).toBeNull();
    const payload = await snapshot.json() as { snapshot: Record<string, unknown> };
    expect(payload.snapshot).toMatchObject({ assistantText: "safe Tailnet response" });
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(CONVERSATION_ID);
    expect(wire).not.toContain(PAIRED_ACTOR_ID);

    const replayedByAnotherLogin = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(
        session.cookieToken,
        session.csrfToken,
        ["observer"],
        "another-owner@example.com",
      ),
    });
    expect(replayedByAnotherLogin.status).toBe(401);
    expect(replayedByAnotherLogin.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("rejects browser Fetch Metadata before consuming the native observer budget", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      maxRequestsPerWindow: 1,
    });
    const browser = await requestTailnetGet(
      server,
      "/tailnet/v1/conversation/snapshot",
      {
        ...observerHeaders(),
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "iframe",
      },
    );
    expect(browser.status).toBe(403);
    expect(JSON.parse(browser.body)).toMatchObject({ error: "browser-observer-not-ready" });

    const cli = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(cli.status).toBe(200);
  });



  it("rejects cross-site documents while keeping same-browser tabs independently usable", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const first = await openWebSession(server);
    const crossSite = await requestWebDocument(server, {
      ...observerHeaders(),
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toContain("same-origin-required");

    const second = await openWebSession(server, {
      ...observerHeaders(),
      Cookie: "__Host-ave-tailnet-v2=" + first.cookieToken,
      Origin: WEB_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(second.cookieToken).toBe(first.cookieToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(first.html).toContain("MIN_SNAPSHOT_REFRESH_MS = 1000");
    expect(first.html).toContain("function eventName(frame)");
    expect(first.html).not.toContain("frame.includes");

    const firstTab = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(firstTab.status).toBe(200);
    const secondTab = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(second.cookieToken, second.csrfToken),
    });
    expect(secondTab.status).toBe(200);
  });
  it("keeps two Web tabs within an isolated, bounded read budget", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
      maxRequestsPerWindow: 2,
      maxWebReadRequestsPerWindow: 2,
    });
    const first = await openWebSession(server);
    const second = await openWebSession(server);

    const native = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    expect(native.status).toBe(429);

    const firstSnapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(firstSnapshot.status).toBe(200);
    const secondSnapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(second.cookieToken, second.csrfToken),
    });
    expect(secondSnapshot.status).toBe(200);
    const exhausted = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(first.cookieToken, first.csrfToken),
    });
    expect(exhausted.status).toBe(429);
  });


  it("requires same-origin CSRF plus control grants before a Web command reaches the broker", async () => {

    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server, tailnetRoleHeaders(["observer", "controller"]));
    expect(session.html).toContain("\"canControl\":true");

    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const command = {
      id: "web-command-0001",
      type: "conversation.send",
      input: "remote browser message",
      scope,
    };

    const wrongCsrf = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, "x".repeat(43), ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(wrongCsrf.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const observerOnly = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["observer"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(observerOnly.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();

    const accepted = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      accepted: true,
      command: { id: command.id, scope },
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tailnet-controller",
        actorId: PAIRED_ACTOR_ID,
        pairedShare: PAIRED_SHARE,
      }),
      expect.objectContaining({
        kind: "message.send",
        payload: { input: command.input },
        publicTurn: expect.objectContaining({
          turnId: expect.stringMatching(/^tailnet-turn_[A-Za-z0-9_-]{43}$/),
          abortController: expect.any(AbortController),
        }),
      }),
    );
  });


  it("clears Web sessions and closes the Web stream as soon as the owner revokes sharing", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const controller = new AbortController();
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      {
        headers: webSessionHeaders(session.cookieToken, session.csrfToken),
        signal: controller.signal,
      },
    );
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await readUntil(reader, ": connected");

    sharing.revoke();

    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    const afterRevoke = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.headers.get("set-cookie")).toContain("Max-Age=0");
    controller.abort();
  });

  it("closes a Web SSE immediately when the browser logs out", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const controller = new AbortController();
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      { headers: webSessionHeaders(session.cookieToken, session.csrfToken), signal: controller.signal },
    );
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    await readUntil(reader, ": connected");

    const logout = await fetch(url(server, "/tailnet/v2/web/logout"), {
      method: "POST",
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(logout.status).toBe(200);
    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).toContain("event: reauthorize-required");
    const afterLogout = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    expect(afterLogout.status).toBe(401);
    controller.abort();
  });


  it("uses reconnect rather than reauthorization for Web stream lifetime expiry", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
      maxStreamLifetimeMs: 40,
    });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshot.json() as { snapshot: { scope: string } }).snapshot.scope;
    const events = await fetch(
      url(server, "/tailnet/v2/web/events?scope=" + encodeURIComponent(scope)),
      { headers: webSessionHeaders(session.cookieToken, session.csrfToken) },
    );
    expect(events.status).toBe(200);
    const stream = await readUntil(events.body!.getReader(), "reconnect-required", 2_000);
    expect(stream).toContain("event: reconnect-required");
    expect(stream).not.toContain("event: reauthorize-required");
  });

  it("redeems a one-use pairing code only with the separate pairing capability", async () => {
    const sharing = pairedSharing({ observe: false, control: false });
    const claimInvitation = vi.fn()
      .mockResolvedValueOnce({ expiresAt: 4_102_444_800_000 })
      .mockResolvedValueOnce(null);
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation },
    });
    const code = "ave-pair-v1." + "A".repeat(43);

    const observerAttempt = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(observerAttempt.status).toBe(401);

    const browserAttempt = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: {
        ...observerHeaders("pairing"),
        "content-type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ code }),
    });
    expect(browserAttempt.status).toBe(403);
    expect(claimInvitation).not.toHaveBeenCalled();

    const accepted = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders("pairing"), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      pending: true,
      expiresAt: 4_102_444_800_000,
    });
    expect(claimInvitation).toHaveBeenCalledWith(code, PAIRED_ACTOR_ID, expect.any(Function));

    const snapshot = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(snapshot.status).toBe(403);

    const duplicate = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: { ...observerHeaders("pairing"), "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "pairing-code-unavailable" });
  });


  it("bounds authenticated observer request floods per Tailnet identity", async () => {
    const { server } = await fixture({ maxRequestsPerWindow: 2, requestWindowMs: 60_000 });
    const first = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const second = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), { headers: observerHeaders() });
    const third = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "tailnet-rate-limited" });
  });

  it("does not let a rotated login header multiply tracked identities on one connection", async () => {
    // Pin rate-limit identity to the connection's first authorized login; rotating headers must not allocate more buckets.
    const { server } = await fixture({ maxRequestsPerWindow: 500, requestWindowMs: 60_000 });
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 200; i += 1) {
        const response = await requestTailnetGet(
          server,
          "/tailnet/v1/status",
          tailnetRoleHeaders(["observer"], `attacker-${i}@example.com`),
          agent,
        );
        expect(response.status).toBe(200);
      }
    } finally {
      agent.destroy();
    }

    const legitimate = await requestTailnetGet(
      server,
      "/tailnet/v1/status",
      tailnetRoleHeaders(["observer"], "genuine-owner@example.com"),
    );
    expect(legitimate.status).toBe(200);
  });

  it("keeps serving a previously-tracked identity when the identity map is at capacity", async () => {
    // At capacity, serve existing buckets and evict the oldest bucket to admit a new identity.
    const { server } = await fixture({ maxRequestsPerWindow: 500, requestWindowMs: 60_000 });
    const legitimateHeaders = tailnetRoleHeaders(["observer"], "genuine-owner@example.com");

    const first = await requestTailnetGet(server, "/tailnet/v1/status", legitimateHeaders);
    expect(first.status).toBe(200);

    for (let i = 0; i < 127; i += 1) {
      const response = await requestTailnetGet(
        server,
        "/tailnet/v1/status",
        tailnetRoleHeaders(["observer"], `flood-${i}@example.com`),
      );
      expect(response.status).toBe(200);
    }

    const second = await requestTailnetGet(server, "/tailnet/v1/status", legitimateHeaders);
    expect(second.status).toBe(200);

    const overflow = await requestTailnetGet(
      server,
      "/tailnet/v1/status",
      tailnetRoleHeaders(["observer"], "overflow-owner@example.com"),
    );
    expect(overflow.status).toBe(200);
  });

  it("accepts only a controller-gated, idempotent narrow message.send command", async () => {
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = {
      execute: vi.fn(),
      submit,
    } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };
    const command = {
      id: "controller-send-0001",
      type: "conversation.send",
      input: "remote surface message",
      scope: conversation.scope,
    };

    const observerAttempt = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...observerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(observerAttempt.status).toBe(401);

    const accepted = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      accepted: true,
      command: { id: command.id, scope: command.scope },
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tailnet-controller",
        actorId: expect.stringMatching(/^tailnet:[a-f0-9]{64}$/),
      }),
      expect.objectContaining({ kind: "message.send", payload: { input: command.input }, publicTurn: expect.objectContaining({ turnId: expect.stringMatching(/^tailnet-turn_/) }) }),
    );

    const duplicate = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(submit).toHaveBeenCalledOnce();

    const conflict = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, input: "different request" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency-conflict" });

    const browserAttempt = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: {
        ...controllerHeaders(),
        "content-type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ ...command, id: "controller-send-0002" }),
    });
    expect(browserAttempt.status).toBe(403);
    expect(await browserAttempt.json()).toMatchObject({ error: "browser-controller-not-ready" });

    const elevatedWirePayload = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, id: "controller-send-0003", inputOrigin: "user-keyboard" }),
    });
    expect(elevatedWirePayload.status).toBe(400);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("keeps a completed receipt across a new public scope and requires another share after the conversation changes", async () => {
    let conversationId = CONVERSATION_ID;
    const receiptStore = createReceiptStore();
    const submit = vi.fn(() => ({ completion: Promise.resolve({
      text: "done",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    }) }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const first = await fixture({
      controllerCommandPort: commandPort,
      controllerReceiptStore: receiptStore,
      conversationId: () => conversationId,
    });
    const firstStatus = await fetch(url(first.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const firstScope = (await firstStatus.json() as { conversation: { scope: string } }).conversation.scope;
    const command = {
      id: "controller-restart-0001",
      type: "conversation.send" as const,
      input: "a durable controller command",
      scope: firstScope,
    };
    expect((await fetch(url(first.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    })).status).toBe(202);
    await Promise.resolve();
    await Promise.resolve();

    const restarted = await fixture({
      controllerCommandPort: commandPort,
      controllerReceiptStore: receiptStore,
      conversationId: () => conversationId,
    });
    const restartedStatus = await fetch(url(restarted.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const restartedScope = (await restartedStatus.json() as { conversation: { scope: string } }).conversation.scope;
    expect(restartedScope).not.toBe(firstScope);
    const duplicate = await fetch(url(restarted.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope: restartedScope }),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect(submit).toHaveBeenCalledOnce();

    conversationId = "new-private-conversation";
    const changedStatus = await fetch(url(restarted.server, "/tailnet/v1/status"), { headers: observerHeaders() });
    expect(changedStatus.status).toBe(403);
    expect(await changedStatus.json()).toMatchObject({ error: "pairing-share-required" });
    const conflict = await fetch(url(restarted.server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope: restartedScope }),
    });
    expect(conflict.status).toBe(403);
    expect(await conflict.json()).toMatchObject({ error: "pairing-share-required" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("fails closed without submit when a previous process left a reserved receipt", async () => {
    const receiptStore = createReceiptStore();
    const command = {
      id: "controller-unknown-0001",
      type: "conversation.send" as const,
      input: "do not replay this command",
    };
    const actorId = PAIRED_ACTOR_ID;
    expect(receiptStore.reserve({
      keyDigest: sha256(`${actorId}\u0000${command.id}`),
      intentDigest: sha256(JSON.stringify({ type: command.type, input: command.input, attachmentIds: [] })),
      conversationDigest: sha256(CONVERSATION_ID),
      ownerId: "00000000-0000-4000-8000-000000000099",
    })).toEqual({ kind: "reserved" });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort, controllerReceiptStore: receiptStore });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, scope }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "command-outcome-unknown" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed without submit when the durable receipt file is corrupt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-tailnet-corrupt-receipts-"));
    receiptDirs.push(directory);
    const filePath = join(directory, "command-receipts.json");
    writeFileSync(filePath, "not-json", "utf8");
    const receiptStore = new TailnetControllerReceiptStore({ filePath });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({ controllerCommandPort: commandPort, controllerReceiptStore: receiptStore });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;
    const response = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        id: "controller-corrupt-0001",
        type: "conversation.send",
        input: "must not submit",
        scope,
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "receipt-unavailable" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("stages a paired native image outside the command receipt and consumes it exactly once", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({
      completion: Promise.resolve({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      }),
    }));
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;

    const uploaded = await fetch(url(server, "/tailnet/v3/attachments"), {
      method: "POST",
      headers: {
        ...controllerHeaders(),
        "content-type": "image/png",
        "x-ave-tailnet-scope": scope,
      },
      body: PNG,
    });
    expect(uploaded.status).toBe(202);
    const uploadBody = await uploaded.json() as {
      attachment: { id: string; scope: string; expiresAt: number };
    };
    expect(uploadBody.attachment).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      scope,
    });
    expect(JSON.stringify(uploadBody)).not.toContain(PNG.toString("base64"));

    const command = {
      id: "paired-image-command-0001",
      type: "conversation.send",
      input: "describe this image",
      attachmentIds: [uploadBody.attachment.id],
      scope,
    };
    const accepted = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json() as { turn?: { id?: string } };
    expect(acceptedBody.turn?.id).toMatch(/^tailnet-turn_[A-Za-z0-9_-]{43}$/);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: PAIRED_ACTOR_ID, pairedShare: PAIRED_SHARE }),
      expect.objectContaining({
        kind: "message.send",
        payload: {
          input: command.input,
          attachments: [{
            type: "image",
            mimeType: "image/png",
            image: "data:image/png;base64,iVBORw0KGgo=",
          }],
        },
        publicTurn: expect.objectContaining({ turnId: acceptedBody.turn?.id }),
      }),
    );

    const reuse = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...controllerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ ...command, id: "paired-image-command-0002" }),
    });
    expect(reuse.status).toBe(409);
    expect(await reuse.json()).toMatchObject({ error: "attachment-unavailable" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("uses the same paired Web boundary for image staging and keeps its turn handle cancellable only through the host", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const submit = vi.fn(() => ({
      completion: Promise.resolve({
        text: "done",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      }),
    }));
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "turn-not-found" })
      .mockResolvedValueOnce({ ok: true, cancelled: true });
    const commandPort = { execute, submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server, tailnetRoleHeaders(["observer", "controller"]));
    expect(session.html).toContain("stageSelectedImages");
    expect(session.html).toContain("turn.cancel-own");
    expect(session.html).toContain("/tailnet/v3/web/attachments");

    const snapshotResponse = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const scope = (await snapshotResponse.json() as { snapshot: { scope: string } }).snapshot.scope;
    const uploaded = await fetch(url(server, "/tailnet/v3/web/attachments"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "image/png",
        "x-ave-tailnet-scope": scope,
      },
      body: PNG,
    });
    expect(uploaded.status).toBe(202);
    const attachmentId = (await uploaded.json() as { attachment: { id: string } }).attachment.id;

    const sent = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-image-command-0001",
        type: "conversation.send",
        input: "remote image",
        attachmentIds: [attachmentId],
        scope,
      }),
    });
    expect(sent.status).toBe(202);
    const turnId = (await sent.json() as { turn: { id: string } }).turn.id;
    expect(turnId).toMatch(/^tailnet-turn_[A-Za-z0-9_-]{43}$/);

    const notFound = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-cancel-0001",
        type: "turn.cancel-own",
        turnId,
        scope,
      }),
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({ error: "turn-not-found" });

    const cancelled = await fetch(url(server, "/tailnet/v2/web/commands"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "web-paired-cancel-0002",
        type: "turn.cancel-own",
        turnId,
        scope,
      }),
    });
    expect(cancelled.status).toBe(202);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: PAIRED_ACTOR_ID, pairedShare: PAIRED_SHARE }),
      { kind: "turn.cancel-own", turnId },
    );
  });


  it("whitelists owner-safe assistant text and never serializes internal ids or owner detail", async () => {
    const { timeline, server } = await fixture();
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: {
        kind: "assistant.reasoning.delta",
        ownerDetail: { text: OWNER_ONLY_SENTINEL },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: {
        kind: "tool.started",
        tool: {
          name: "filesystem.read",
          groupId: "group-id-do-not-expose",
          toolUseId: "tool-use-id-do-not-expose",
          displayOrder: 1,
        },
        ownerDetail: { input: { path: "C:/secret/" + OWNER_ONLY_SENTINEL } },
      },
    });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      turnId: "legacy-stream-id-777",
      event: { kind: "assistant.text.delta", text: "shareable assistant answer" },
    });

    const response = await fetch(url(server, "/tailnet/v1/conversation/snapshot"), {
      headers: observerHeaders(),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; snapshot: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.snapshot).toMatchObject({
      assistantText: "shareable assistant answer",
      cursor: 2,
      scope: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(CONVERSATION_ID);
    expect(wire).not.toContain("legacy-stream-id-777");
    expect(wire).not.toContain(OWNER_ONLY_SENTINEL);
    expect(wire).not.toContain("group-id-do-not-expose");
    expect(wire).not.toContain("tool-use-id-do-not-expose");
  });

  it("uses Last-Event-ID plus the public scope for replay, and requires a snapshot without the scope", async () => {
    const { timeline, server } = await fixture();
    const first = timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "first" },
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const statusPayload = await status.json() as { conversation: { scope: string } };
    const scope = statusPayload.conversation.scope;
    const second = timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "second" },
    });

    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(scope)),
      {
        headers: { ...observerHeaders(), "Last-Event-ID": String(first.cursor) },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    const stream = await readUntil(response.body!.getReader(), "second");
    const events = dataFrames(stream) as Array<{ cursor: number; event: { kind: string; text?: string } }>;
    expect(events).toEqual([
      expect.objectContaining({
        cursor: second.cursor,
        scope,
        event: { kind: "assistant.text.delta", text: "second" },
      }),
    ]);
    controller.abort();

    const missingScope = await fetch(url(server, "/tailnet/v1/conversation/events"), {
      headers: { ...observerHeaders(), "Last-Event-ID": String(first.cursor) },
    });
    expect(missingScope.status).toBe(409);
    expect(await missingScope.json()).toMatchObject({
      ok: false,
      error: "snapshot-required",
      scope,
    });
  });

  it("forces a resync rather than following a previous main conversation after a switch", async () => {
    let currentConversation = CONVERSATION_ID;
    const { timeline, server } = await fixture({
      conversationId: () => currentConversation,
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };

    const controller = new AbortController();
    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope)),
      { headers: observerHeaders(), signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");

    currentConversation = "new-owner-session-do-not-expose";
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "stale event must not be shared" },
    });

    const stream = await readUntil(reader, "resync-required");
    expect(stream).toContain("event: resync-required");
    expect(stream).not.toContain("stale event must not be shared");
    controller.abort();
  });

  it("returns a snapshot-required response for a replay gap", async () => {
    const { timeline, server } = await fixture({ replayLimitPerConversation: 1 });
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "old" },
    });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };
    timeline.publish({
      conversationId: CONVERSATION_ID,
      event: { kind: "assistant.text.delta", text: "new" },
    });

    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope) + "&afterCursor=0"),
      { headers: observerHeaders() },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "snapshot-required",
      scope: conversation.scope,
    });
  });

  it("ends a bounded stream with a reauthorization control event", async () => {
    const { server } = await fixture({ maxStreamLifetimeMs: 40 });
    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
    const { conversation } = await status.json() as { conversation: { scope: string } };

    const response = await fetch(
      url(server, "/tailnet/v1/conversation/events?scope=" + encodeURIComponent(conversation.scope)),
      { headers: observerHeaders() },
    );
    expect(response.status).toBe(200);
    const stream = await readUntil(response.body!.getReader(), "reauthorize-required", 2_000);
    expect(stream).toContain("event: reauthorize-required");
  });
});

const NAVIGATION_HEADERS = Object.freeze({
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
});

describe("Tailnet identity authorization", () => {
  const IDENTITY: TailnetAuthorization = { kind: "tailnet-identity" };
  const IDENTITY_HEADERS = Object.freeze({ "Tailscale-User-Login": "owner@example.com" });

  it("accepts a Serve identity with no tailnet policy grant at all", () => {
    expect(isAuthorizedTailnetObserver(IDENTITY_HEADERS as never, IDENTITY)).toBe(true);
    expect(isAuthorizedTailnetController(IDENTITY_HEADERS as never, IDENTITY)).toBe(true);
    expect(isAuthorizedTailnetObserver({}, IDENTITY)).toBe(false);
    expect(isAuthorizedTailnetObserver({ "tailscale-user-login": "   " }, IDENTITY)).toBe(false);
  });

  it("leaves observe-versus-control entirely to the Ave share permission", async () => {
    const sharing = pairedSharing({ observe: true, control: false });
    const submit = vi.fn();
    const commandPort = { execute: vi.fn(), submit } as unknown as ConversationCommandPort;
    const { server } = await fixture({
      authorization: IDENTITY,
      pairedSharing: sharing.authorizer,
      controllerCommandPort: commandPort,
    });

    const status = await fetch(url(server, "/tailnet/v1/status"), { headers: IDENTITY_HEADERS });
    expect(status.status).toBe(200);
    const scope = (await status.json() as { conversation: { scope: string } }).conversation.scope;

    const command = await fetch(url(server, "/tailnet/v1/commands"), {
      method: "POST",
      headers: { ...IDENTITY_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        id: "identity-control-required-01",
        type: "conversation.send",
        input: "must not be admitted",
        scope,
      }),
    });
    expect(command.status).toBe(403);
    expect(await command.json()).toMatchObject({ error: "pairing-share-required" });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("Tailnet Web root and browser pairing", () => {
  const CODE = "ave-pair-v1." + "A".repeat(43);

  it("serves the Web document at the tailnet root a person is actually given", async () => {
    const sharing = pairedSharing({ observe: true, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });

    const document = await requestTailnetGet(server, "/", {
      ...observerHeaders(),
      ...NAVIGATION_HEADERS,
    });
    expect(document.status).toBe(200);
    expect(responseHeader(document.headers["content-type"])).toContain("text/html");
    expect(document.body).toContain("csrfToken");
  });

  it("leaves the root unrouted when no Web surface is configured", async () => {
    const { server } = await fixture();

    const document = await requestTailnetGet(server, "/", {
      ...observerHeaders(),
      ...NAVIGATION_HEADERS,
    });
    expect(document.status).toBe(404);
  });

  it("renders a code entry page instead of raw JSON and redeems it same-origin", async () => {
    const claimInvitation = vi.fn(async () => ({ expiresAt: 4_102_444_800_000 }));
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation },
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/", {
      ...observerHeaders(),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(200);
    expect(responseHeader(page.headers["content-type"])).toContain("text/html");
    expect(page.body).toContain("/tailnet/v2/web/pairing/claim");
    const cookieToken = /__Host-ave-tailnet-v2=([A-Za-z0-9_-]{43})/
      .exec(responseHeader(page.headers["set-cookie"]))?.[1];
    const csrfToken = /"csrfToken":"([A-Za-z0-9_-]{43})"/.exec(page.body)?.[1];
    expect(cookieToken).toBeTypeOf("string");
    expect(csrfToken).toBeTypeOf("string");

    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(cookieToken!, csrfToken!),
    });
    expect(snapshot.status).toBe(401);

    const crossSite = await fetch(url(server, "/tailnet/v2/web/pairing/claim"), {
      method: "POST",
      headers: {
        ...tailnetRoleHeaders(["pairing"]),
        "content-type": "application/json",
        Cookie: "__Host-ave-tailnet-v2=" + cookieToken,
        Origin: "https://attacker.example.ts.net",
        "Sec-Fetch-Site": "cross-site",
        "X-Ave-Tailnet-Csrf": csrfToken!,
      },
      body: JSON.stringify({ code: CODE }),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: "same-origin-required" });

    const withoutCsrf = await fetch(url(server, "/tailnet/v2/web/pairing/claim"), {
      method: "POST",
      headers: {
        ...tailnetRoleHeaders(["pairing"]),
        "content-type": "application/json",
        Cookie: "__Host-ave-tailnet-v2=" + cookieToken,
        Origin: WEB_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ code: CODE }),
    });
    expect(withoutCsrf.status).toBe(403);
    expect(await withoutCsrf.json()).toMatchObject({ error: "csrf-required" });
    expect(claimInvitation).not.toHaveBeenCalled();

    const accepted = await fetch(url(server, "/tailnet/v2/web/pairing/claim"), {
      method: "POST",
      headers: {
        ...webSessionHeaders(cookieToken!, csrfToken!, ["pairing"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: CODE }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ ok: true, pending: true });
    expect(claimInvitation).toHaveBeenCalledWith(CODE, PAIRED_ACTOR_ID, expect.any(Function));

    const nativeFromBrowser = await fetch(url(server, "/tailnet/v2/pairing/claim"), {
      method: "POST",
      headers: {
        ...observerHeaders("pairing"),
        "content-type": "application/json",
        Origin: WEB_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ code: CODE }),
    });
    expect(nativeFromBrowser.status).toBe(403);
    expect(await nativeFromBrowser.json()).toMatchObject({ error: "browser-pairing-not-ready" });
  });

  it("skips the code for the desktop's own device and still waits for its approval", async () => {
    const claimInvitation = vi.fn(async () => ({ expiresAt: 4_102_444_800_000 }));
    const deviceStatus = vi.fn(async () => ({ pairing: "pending" as const, ownDevice: true }));
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation, deviceStatus },
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/", {
      ...tailnetRoleHeaders(["observer", "pairing"]),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(200);
    expect(deviceStatus).toHaveBeenCalledWith("owner@example.com", PAIRED_ACTOR_ID, expect.any(Function));
    expect(claimInvitation).not.toHaveBeenCalled();
    expect(page.body).toContain("데스크톱에서 승인을 기다리는 중");
    expect(page.body).not.toContain("<form");
    expect(page.body).not.toContain("/tailnet/v2/web/pairing/claim");

    const cookieToken = /__Host-ave-tailnet-v2=([A-Za-z0-9_-]{43})/
      .exec(responseHeader(page.headers["set-cookie"]))?.[1];
    expect(cookieToken).toBeTypeOf("string");
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: {
        ...tailnetRoleHeaders(["observer"]),
        Cookie: "__Host-ave-tailnet-v2=" + cookieToken,
        Origin: WEB_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(snapshot.status).toBe(401);
  });

  it("tells an admitted own device what it is actually waiting for", async () => {
    const claimInvitation = vi.fn(async () => ({ expiresAt: 4_102_444_800_000 }));
    const deviceStatus = vi.fn(async () => ({ pairing: "active" as const, ownDevice: true }));
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation, deviceStatus },
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/", {
      ...tailnetRoleHeaders(["observer", "pairing"]),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("대화를 공유하기를 기다리는 중");
    expect(page.body).not.toContain("승인을 기다리는 중");
    expect(page.body).toContain("같은 Tailscale 계정으로 확인되었습니다");
    expect(page.body).not.toContain("<form");
  });

  it("does not ask a device that already redeemed a code for a second one", async () => {
    const GUEST_ACTOR: `tailnet:${string}` = `tailnet:${"e".repeat(64)}`;
    const sharing = pairedSharing({ observe: false, control: false });
    for (const [state, sentence] of [
      ["pending", "승인을 기다리는 중"],
      ["active", "대화를 공유하기를 기다리는 중"],
    ] as const) {
      const { server } = await fixture({
        pairedSharing: { ...sharing.authorizer, probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => "owner@example.com", ownerIdentityError: () => null, actorIdFor: () => GUEST_ACTOR },
        pairing: {
          claimInvitation: vi.fn(async () => null),
          deviceStatus: vi.fn(async () => ({ pairing: state, ownDevice: false })),
        },
        web: { origin: WEB_ORIGIN },
      });

      const page = await requestTailnetGet(server, "/", {
        ...tailnetRoleHeaders(["observer", "pairing"], "guest@example.com"),
        ...NAVIGATION_HEADERS,
      });
      expect(page.status).toBe(200);
      expect(page.body).toContain(sentence);
      expect(page.body).not.toContain("<form");
      expect(page.body).not.toContain("같은 Tailscale 계정으로 확인되었습니다");
      expect(page.body).toContain("이 데스크톱에 연결되어 있습니다");
    }
  });

  it("still asks a different tailnet login for a code", async () => {
    const GUEST_ACTOR_ID: `tailnet:${string}` = `tailnet:${"f".repeat(64)}`;
    const deviceStatus = vi.fn(async (login: string) => (
      login === "owner@example.com"
        ? { pairing: "pending" as const, ownDevice: true }
        : { pairing: "none" as const, ownDevice: false }
    ));
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: {
        ...sharing.authorizer,
        probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => "owner@example.com", ownerIdentityError: () => null, actorIdFor: (login) => login === "owner@example.com" ? PAIRED_ACTOR_ID : GUEST_ACTOR_ID,
      },
      pairing: { claimInvitation: vi.fn(async () => null), deviceStatus },
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/", {
      ...tailnetRoleHeaders(["observer", "pairing"], "guest@example.com"),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(200);
    expect(deviceStatus).toHaveBeenCalledWith("guest@example.com", GUEST_ACTOR_ID, expect.any(Function));
    expect(page.body).toContain("/tailnet/v2/web/pairing/claim");
    expect(page.body).toContain("<form");
  });

  it("asks for a code when the desktop cannot say whose device this is", async () => {
    const deviceStatus = vi.fn(async () => ({ pairing: "none" as const, ownDevice: false }));
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      pairing: { claimInvitation: vi.fn(async () => null), deviceStatus },
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/", {
      ...tailnetRoleHeaders(["observer", "pairing"]),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(200);
    expect(deviceStatus).toHaveBeenCalledOnce();
    expect(page.body).toContain("/tailnet/v2/web/pairing/claim");
  });

  it("names the unredeemable state rather than drawing a form that cannot work", async () => {
    const sharing = pairedSharing({ observe: false, control: false });
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN },
    });

    const page = await requestTailnetGet(server, "/tailnet/v2/web", {
      ...observerHeaders(),
      ...NAVIGATION_HEADERS,
    });
    expect(page.status).toBe(403);
    expect(JSON.parse(page.body)).toMatchObject({ error: "pairing-share-required" });
  });
});

describe("local owner identity boundary", () => {
  it.each(["tailnet-owner-identity-unavailable", "tailnet-owner-identity-mismatch"] as const)("denies authenticated native and browser requests with %s", async error => {
    const sharing = pairedSharing({ observe: true, control: true });
    const ownerIdentityError = vi.fn(() => error);
    const { server } = await fixture({ pairedSharing: sharing.authorizer, web: { origin: WEB_ORIGIN }, ownerIdentityError });
    for (const path of ["/tailnet/v1/status", "/tailnet/v2/web"]) {
      const response = await fetch(url(server, path), { headers: observerHeaders() });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ ok: false, error, message: expect.any(String) });
    }
    expect(ownerIdentityError).toHaveBeenCalledWith("owner@example.com", expect.objectContaining({ revision: 1, ownerLogin: "owner@example.com" }));
  });

  it("validates peer authorization before consulting local owner identity", async () => {
    const ownerIdentityError = vi.fn(() => null);
    const { server } = await fixture({ ownerIdentityError });
    const response = await fetch(url(server, "/tailnet/v1/status"), { headers: { "Tailscale-User-Login": "spoofed@example.test" } });
    expect(response.status).toBe(401);
    expect(ownerIdentityError).not.toHaveBeenCalled();
  });

  it("refuses a controller configuration without pairing or an absent owner identity policy", async () => {
    const timeline = createPlatformConversationTimeline();
    const store = createSharedConversationProjectionStore(timeline);
    stores.push(store);
    const options = { port: await reservePort(), authorization: APP_CAPABILITY, projectionStore: store, getCurrentConversationId: () => CONVERSATION_ID, isConversationBusy: () => false, probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), ownerIdentityError: () => null };
    await expect(startTailnetSurfaceServer({ ...options, controller: { commandPort: { submit: vi.fn(), execute: vi.fn() } as unknown as ConversationCommandPort, receiptStore: createReceiptStore() } })).rejects.toThrow("tailnet-controller-owner-pairing-required");
    await expect(startTailnetSurfaceServer({ ...options, ownerIdentityError: undefined as never })).rejects.toThrow("tailnet-owner-identity-policy-unavailable");
    await expect(startTailnetSurfaceServer({ ...options, pairedSharing: { ...pairedSharing({ observe: true, control: true }).authorizer, ownerIdentityError: undefined as never } })).rejects.toThrow("tailnet-owner-identity-policy-unavailable");
  });
});

describe("request-scoped asynchronous owner identity", () => {
  it("consumes the request budget before any probe and uses one probe for one admitted request", async () => {
    const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
    const { server } = await fixture({ probeOwnerIdentity, maxRequestsPerWindow: 1 });
    expect((await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() })).status).toBe(200);
    expect(probeOwnerIdentity).toHaveBeenCalledOnce();
    expect((await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() })).status).toBe(429);
    expect(probeOwnerIdentity).toHaveBeenCalledOnce();
  });

  it("streams assistant deltas without probing or rechecking paired authority per event, and closes on subscription revocation", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const guard = sharing.authorizer.authorize("owner@example.com", CONVERSATION_ID, "observe", await sharing.authorizer.probeOwnerIdentity())!.pairedShareGuard;
    const isCurrent = vi.spyOn(guard, "isCurrent");
    const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
    const { server, timeline } = await fixture({ probeOwnerIdentity, pairedSharing: sharing.authorizer });
    const response = await fetch(url(server, "/tailnet/v1/conversation/events"), { headers: observerHeaders() });
    const reader = response.body!.getReader();
    await readUntil(reader, ": connected");
    const callsBefore = isCurrent.mock.calls.length;
    for (let index = 0; index < 25; index += 1) timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "assistant.text.delta", text: `owner-delta-${index}` } });
    await readUntil(reader, "owner-delta-24");
    expect(probeOwnerIdentity).toHaveBeenCalledOnce();
    expect(isCurrent).toHaveBeenCalledTimes(callsBefore);
    sharing.revoke();
    await readUntil(reader, "reauthorize-required");
    expect(isCurrent.mock.calls.length).toBeGreaterThan(callsBefore);
    await reader.cancel();
  });

  it("refreshes the owner only from the existing stream scope interval and closes when the refresh is unavailable", async () => {
    const sharing = pairedSharing({ observe: true, control: true });
    const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
    let unavailable = false;
    const { server } = await fixture({ probeOwnerIdentity, pairedSharing: sharing.authorizer, ownerIdentityError: () => unavailable ? "tailnet-owner-identity-unavailable" : null });
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const response = await fetch(url(server, "/tailnet/v1/conversation/events"), { headers: observerHeaders() });
      const reader = response.body!.getReader();
      await readUntil(reader, ": connected");
      expect(probeOwnerIdentity).toHaveBeenCalledOnce();
      unavailable = true;
      const scopeCheck = intervals.mock.calls.at(-1)?.[0] as () => void;
      expect(scopeCheck).toBeTypeOf("function");
      scopeCheck();
      await readUntil(reader, "reauthorize-required");
      expect(probeOwnerIdentity).toHaveBeenCalledTimes(2);
      await reader.cancel();
    } finally { intervals.mockRestore(); }
  });
});

it("rejects a pairing body whose request evidence was suspended and replaced during body reading", async () => {
  const { createTailnetOwnerIdentityPolicy } = await import("../../main/tailnet-owner-policy.js");
  let login: string | null = "owner@example.com";
  const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin: async () => login });
  const admitted = deferred<void>();
  const probeOwnerIdentity = vi.fn(policy.probeOwnerIdentity);
  const ownerIdentityError: NonNullable<FixtureOptions["ownerIdentityError"]> = (login, evidence) => {
    const error = policy.ownerIdentityError(login, evidence);
    if (error === null) admitted.resolve();
    return error;
  };
  const sharing = pairedSharing({ observe: true, control: true });
  const claimInvitation = vi.fn(async () => ({ expiresAt: Date.now() + 1_000 }));
  const { server } = await fixture({ probeOwnerIdentity, ownerIdentityError, pairedSharing: sharing.authorizer, pairing: { claimInvitation } });
  let finish!: () => void;
  const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/tailnet/v2/pairing/claim", method: "POST", headers: { ...observerHeaders("pairing"), "content-type": "application/json" } }, response => {
      let body = "";
      response.on("data", chunk => { body += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    req.on("error", reject);
    req.flushHeaders();
    finish = () => req.end(JSON.stringify({ code: "ave-pair-v1." + "a".repeat(43) }));
  });
  await admitted.promise;
  expect(probeOwnerIdentity).toHaveBeenCalledOnce();
  login = null;
  await policy.probeOwnerIdentity();
  login = "owner@example.com";
  await policy.probeOwnerIdentity();
  finish();
  const response = await completed;
  expect(response.status).toBe(403);
  expect(JSON.parse(response.body)).toMatchObject({ error: "tailnet-owner-identity-unavailable" });
  expect(claimInvitation).not.toHaveBeenCalled();
});


it.each(["native", "web"] as const)("preserves an accepted %s command result when authority is revoked during submission", async (transport) => {
  const sharing = pairedSharing({ observe: true, control: true });
  const submit = vi.fn(() => {
    sharing.revoke();
    return { completion: Promise.resolve({ text: "", toolCalls: [], route: "default", stopReason: "end_turn" }) };
  });
  const { server } = await fixture({ pairedSharing: sharing.authorizer, controllerCommandPort: { submit, execute: vi.fn() } as unknown as ConversationCommandPort, ...(transport === "web" ? { web: { origin: WEB_ORIGIN } } : {}) });
  const session = transport === "web" ? await openWebSession(server, tailnetRoleHeaders(["observer", "controller"])) : undefined;
  const snapshot = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
  const scope = (await snapshot.json() as { conversation: { scope: string } }).conversation.scope;
  const path = transport === "web" ? "/tailnet/v2/web/commands" : "/tailnet/v1/commands";
  const headers = { ...(session ? webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]) : controllerHeaders()), "content-type": "application/json" };
  const body = JSON.stringify({ id: "accepted-before-revocation-0001", type: "conversation.send", input: "perform work", scope });
  const response = await fetch(url(server, path), { method: "POST", headers, body });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: true, turn: { denied: true, error: "remote-controller-authority-revoked" } });
  expect((await fetch(url(server, path), { method: "POST", headers, body })).status).toBe(transport === "web" ? 401 : 403);
  expect(submit).toHaveBeenCalledOnce();
});

it.each([
  ["unavailable", null, "remote-controller-authority-suspended"],
  ["recovered to the same owner", "owner@example.com", "remote-controller-authority-suspended"],
  ["changed to another owner", "next-owner@example.com", "remote-controller-authority-revoked"],
] as const)("reports an accepted command as %s with its distinct authority code", async (_state, ownerAfter, code) => {
  const sharing = pairedSharing({ observe: true, control: true });
  let identityChanged = false;
  const submit = vi.fn(() => {
    identityChanged = true;
    return { completion: Promise.resolve({ text: "", toolCalls: [], route: "default", stopReason: "end_turn" }) };
  });
  const { server } = await fixture({
    pairedSharing: { ...sharing.authorizer, currentOwnerLogin: () => identityChanged ? ownerAfter : "owner@example.com" },
    // The request's evidence is superseded once the identity changes, whatever the new state is.
    ownerIdentityError: () => identityChanged ? "tailnet-owner-identity-unavailable" : null,
    controllerCommandPort: { submit, execute: vi.fn() } as unknown as ConversationCommandPort,
  });
  const snapshot = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
  const scope = (await snapshot.json() as { conversation: { scope: string } }).conversation.scope;
  const body = JSON.stringify({ id: "accepted-before-suspension-0001", type: "conversation.send", input: "perform work", scope });
  const response = await fetch(url(server, "/tailnet/v1/commands"), { method: "POST", headers: { ...controllerHeaders(), "content-type": "application/json" }, body });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: true, turn: { denied: true, error: code } });
  expect(submit).toHaveBeenCalledOnce();
});

it("closes an expired share before delivering the next delta without an identity probe or interval", async () => {
  const expiresAt = Date.now() + 60_000;
  const sharing = pairedSharing({ observe: true, control: true, expiresAt });
  const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
  const { server, timeline } = await fixture({ pairedSharing: sharing.authorizer, probeOwnerIdentity });
  const response = await fetch(url(server, "/tailnet/v1/conversation/events"), { headers: observerHeaders() });
  const reader = response.body!.getReader();
  await readUntil(reader, ": connected");
  const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt);
  try {
    timeline.publish({ conversationId: CONVERSATION_ID, event: { kind: "assistant.text.delta", text: "expired-private-delta" } });
    const stream = await readUntil(reader, "reauthorize-required");
    expect(stream).not.toContain("expired-private-delta");
    expect(probeOwnerIdentity).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); await reader.cancel(); }
});

it("checks owner identity for controller-only web attachment uploads", async () => {
  const sharing = pairedSharing({ observe: true, control: true });
  const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
  const { server } = await fixture({ pairedSharing: sharing.authorizer, probeOwnerIdentity, controllerCommandPort: { submit: vi.fn(), execute: vi.fn() } as unknown as ConversationCommandPort, web: { origin: WEB_ORIGIN } });
  const session = await openWebSession(server, tailnetRoleHeaders(["observer", "controller"]));
  const snapshot = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
  const scope = (await snapshot.json() as { conversation: { scope: string } }).conversation.scope;
  probeOwnerIdentity.mockClear();
  const uploaded = await fetch(url(server, "/tailnet/v3/web/attachments"), { method: "POST", headers: { ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller"]), "content-type": "image/png", "x-ave-tailnet-scope": scope }, body: PNG });
  expect(uploaded.status).toBe(202);
  expect(probeOwnerIdentity).toHaveBeenCalledOnce();
});

it("checks request identity before submitting a command after asynchronous body reading", async () => {
  let unavailable = false;
  const submit = vi.fn();
  const probeOwnerIdentity = vi.fn(async () => ({ revision: 1, ownerLogin: "owner@example.com" }));
  const ownerIdentityError = vi.fn<NonNullable<FixtureOptions["ownerIdentityError"]>>(() => unavailable ? "tailnet-owner-identity-unavailable" : null);
  const { server } = await fixture({ probeOwnerIdentity, ownerIdentityError, controllerCommandPort: { submit, execute: vi.fn() } as unknown as ConversationCommandPort });
  const snapshot = await fetch(url(server, "/tailnet/v1/status"), { headers: observerHeaders() });
  const scope = (await snapshot.json() as { conversation: { scope: string } }).conversation.scope;
  probeOwnerIdentity.mockClear();
  const admitted = deferred<void>();
  ownerIdentityError.mockImplementationOnce(() => {
    admitted.resolve();
    return null;
  });
  let finish!: () => void;
  const completed = new Promise<number>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/tailnet/v1/commands", method: "POST", headers: { ...controllerHeaders(), "content-type": "application/json" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    });
    req.on("error", reject);
    req.flushHeaders();
    finish = () => req.end(JSON.stringify({ id: "denied-before-submission-0001", type: "conversation.send", input: "must not submit", scope }));
  });
  await admitted.promise;
  expect(probeOwnerIdentity).toHaveBeenCalledOnce();
  unavailable = true;
  finish();
  expect(await completed).toBe(403);
  expect(submit).not.toHaveBeenCalled();
});

describe("remote work decisions", () => {
  const path = "/tailnet/v2/web/work-decisions";
  const receiptId = "8fe084f3-931b-4414-8e6a-b6101905e344";
  const workRoles = ["observer", "controller", "work-decision"] as const;

  it.each([
    ["controller capability", 403, "tailnet-role-required"],
    ["work-only capability", 403, "tailnet-role-required"],
    ["session cookie", 401, "web-session-required"],
    ["Serve target", 403, "work-decision-serve-required"],
    ["origin", 403, "same-origin-required"],
    ["CSRF", 403, "csrf-required"],
    ["stale conversation scope", 409, "work-decision-scope-mismatch"],
    ["work identity", 400, "invalid-work-decision"],
    ["accepted and replayed", 200, undefined],
  ] as const)("checks %s before routing", async (condition, status, error) => {
    const decide = vi.fn(async () => ({ ok: true as const, kind: "plan" as const, status: "approved" as const }));
    const sharing = pairedSharing({ observe: true, control: true });
    const web = {
      origin: WEB_ORIGIN,
      workDecisions: {
        decide,
        verifyServeTarget: async () => condition !== "Serve target",
        receipts: createReceiptStore(),
      },
    };
    const { server } = await fixture({ web, pairedSharing: sharing.authorizer });
    const session = await openWebSession(server);
    const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
      headers: webSessionHeaders(session.cookieToken, session.csrfToken),
    });
    const { scope } = (await snapshot.json() as { snapshot: { scope: string } }).snapshot;
    const headers: Record<string, string> = {
      ...webSessionHeaders(session.cookieToken, session.csrfToken, condition === "controller capability" ? ["observer", "controller"] : condition === "work-only capability" ? ["work-decision"] : workRoles),
      "Content-Type": "application/json",
    };
    if (condition === "origin") headers.Origin = "https://other.ts.net";
    if (condition === "session cookie") delete headers.Cookie;
    if (condition === "CSRF") delete headers["X-Ave-Tailnet-Csrf"];
    const request = {
      id: receiptId, scope: condition === "stale conversation scope" ? PAIRED_SHARE.scope : scope,
      kind: "plan", itemId: condition === "work identity" ? 0 : 1,
      input: { runId: "run", planHash: "a".repeat(64), decision: "approve", note: OWNER_ONLY_SENTINEL },
    };
    const submit = () => fetch(url(server, path), { method: "POST", headers, body: JSON.stringify(request) });
    const response = await submit();
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).not.toContain(OWNER_ONLY_SENTINEL);
    if (error) {
      expect(JSON.parse(body)).toMatchObject({ ok: false, error });
      expect(decide).not.toHaveBeenCalled();
      return;
    }
    expect(JSON.parse(body)).toEqual({ ok: true, kind: "plan", status: "approved" });
    expect(decide).toHaveBeenCalledOnce();
    const replay = await submit();
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ ok: false, error: "work-decision-replayed" });
    expect(decide).toHaveBeenCalledOnce();
  });
});

it("blocks a duplicate work request in flight and notices a paired share revoked after admission", async () => {
  const dispatch = deferred<void>();
  const release = deferred<void>();
  const path = "/tailnet/v2/web/work-decisions";
  const sharing = pairedSharing({ observe: true, control: true });
  const { server } = await fixture({
    pairedSharing: sharing.authorizer,
    web: { origin: WEB_ORIGIN, workDecisions: {
      verifyServeTarget: async () => true,
      receipts: createReceiptStore(),
      async decide(_request, { authority }) {
        dispatch.resolve();
        await release.promise;
        expect(authority.isCurrent()).toBe(false);
        return await authority.refreshCurrent()
          ? { ok: true, kind: "plan", status: "approved" }
          : { ok: false, error: "remote-controller-authority-revoked" };
      },
    } },
  });
  const session = await openWebSession(server);
  const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), {
    headers: webSessionHeaders(session.cookieToken, session.csrfToken),
  });
  const { scope } = (await snapshot.json() as { snapshot: { scope: string } }).snapshot;
  const headers = { ...webSessionHeaders(session.cookieToken, session.csrfToken, ["controller", "work-decision"]), "Content-Type": "application/json" };
  const body = JSON.stringify({
    id: "d5bdac87-cda7-42b5-9290-4d31ae6014e3", scope, kind: "plan", itemId: 1,
    input: { runId: "run", planHash: "a".repeat(64), decision: "approve" },
  });
  const submit = () => fetch(url(server, path), { method: "POST", headers, body });
  const first = submit();
  try {
    await dispatch.promise;
    const duplicate = await submit();
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ ok: false, error: "work-decision-replayed" });
    sharing.revoke();
    release.resolve();
    const refused = await first;
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ ok: false, error: "remote-controller-authority-revoked" });
  } finally {
    release.resolve();
  }
});

it("keeps identity-only Web reads and requires a work-decision capability for mutations", async () => {
  const decide = vi.fn(async () => ({ ok: true as const, kind: "join" as const }));
  const { server } = await fixture({
    authorization: { kind: "tailnet-identity" },
    pairedSharing: pairedSharing({ observe: true, control: true }).authorizer,
    web: { origin: WEB_ORIGIN, workDecisions: { decide, verifyServeTarget: async () => true, receipts: createReceiptStore() } },
  });
  const session = await openWebSession(server);
  const headers = webSessionHeaders(session.cookieToken, session.csrfToken, ["observer", "controller", "work-decision"]);
  const snapshot = await fetch(url(server, "/tailnet/v2/web/snapshot"), { headers });
  expect(snapshot.status).toBe(200);
  const { scope } = (await snapshot.json()).snapshot;
  const result = await fetch(url(server, "/tailnet/v2/web/work-decisions"), {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), scope, kind: "plan", itemId: 1,
      input: { runId: "run", planHash: "a".repeat(64), decision: "approve" } }),
  });
  expect(result.status).toBe(403);
  expect(await result.json()).toMatchObject({ error: "work-decision-capability-required" });
  expect(decide).not.toHaveBeenCalled();
});

it("refuses the live listener through an agent egress relay while the paired Web path succeeds", async () => {
  const { server } = await fixture({
    pairedSharing: pairedSharing({ observe: true, control: true }).authorizer,
    web: { origin: WEB_ORIGIN },
  });
  const session = await openWebSession(server);
  const headers = webSessionHeaders(session.cookieToken, session.csrfToken);
  const target = url(server, "/tailnet/v2/web/snapshot");
  expect((await fetch(target, { headers })).status).toBe(200);

  startEgressRelayService({ ask: async () => true, allow: [`127.0.0.1:${server.port}`] });
  const invocation = openEgressInvocation({
    kind: "shell", toolName: "bash", toolUseId: undefined,
    context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" },
  });
  try {
    const relay = await openEgressRelay(invocation.token);
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: relay.port, path: target,
        headers: { ...headers, "Proxy-Authorization": relay.proxyAuthorization },
      }, result => {
        let body = "";
        result.setEncoding("utf8").on("data", chunk => { body += chunk; });
        result.on("end", () => resolve({ status: result.statusCode, body }));
      });
      request.on("error", reject).end();
    });
    expect(response).toMatchObject({ status: 403, body: expect.stringContaining("tailnet-loopback-destination") });
  } finally {
    invocation.release();
    await stopEgressRelayService();
  }
});

async function pairedWorkFixture(h: Awaited<ReturnType<typeof stageRunHarness>>) {
  const sharing = pairedSharing({ observe: true, control: true });
  const routines = new RoutinesStore(join(h.dir, "routines.json"));
  routines.bindTemplateAttachments(h.templates);
  const log = vi.fn();
  const runtime = createTailnetWorkDecisions({
    workBoardStore: h.board, workBoardEngine: h.engine, workflowTemplateStore: h.templates, routinesStore: routines,
    settingsService: { get: key => DEFAULT_SETTINGS[key] }, auditLogger: { log },
  });
  if (!runtime) throw new Error("Work decision runtime unavailable");
  const list = vi.fn(runtime.list);
  const { server } = await fixture({
    pairedSharing: sharing.authorizer,
    web: { origin: WEB_ORIGIN, workDecisions: { decide: runtime.decide, list, verifyServeTarget: async () => true, receipts: createReceiptStore() } },
  });
  const snapshot = url(server, "/tailnet/v2/web/snapshot");
  const session = await openWebSession(server);
  const headers = webSessionHeaders(session.cookieToken, session.csrfToken, ["observer", "controller", "work-decision"]);
  async function readReviews(): Promise<TailnetWorkReviewSnapshot> {
    const read = await fetch(snapshot, { headers });
    expect(read.status).toBe(200);
    return (await read.json()).snapshot;
  }
  function postDecision(request: TailnetWorkDecisionRequest): Promise<Response> {
    return fetch(url(server, "/tailnet/v2/web/work-decisions"), {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
  }
  return { sharing, snapshot, session, headers, list, log, readReviews, postDecision };
}

it("posts a real plan binding from the paired snapshot and withholds reviews after revocation", async () => {
  const h = await stageRunHarness();
  await h.runThenEnd(async () => {
    const { sharing, snapshot, session, headers, list, log, readReviews, postDecision } = await pairedWorkFixture(h);
    const plan = "Current review";
    const created = await h.board.create({ title: "Work" });
    if (created.status !== "created") throw new Error("Work item not created");
    const { itemId } = created;
    const runId = "plan-run";
    await h.board.beginRun(itemId, runId, "2026-11-27T00:00:00Z");
    await h.board.setPlanAwaitingApproval(itemId, { runId, plan, runSessionId: "plan-session", revision: 1, itemDigest: itemDigestOf(created.item) });

    const unpaired = await fetch(snapshot, { headers: { ...headers, Cookie: "" } });
    expect(unpaired.status).toBe(401);
    expect(await unpaired.text()).not.toContain(plan);
    expect(list).not.toHaveBeenCalled();

    const observer = await fetch(snapshot, { headers: webSessionHeaders(session.cookieToken, session.csrfToken) });
    expect(observer.status).toBe(200);
    expect(await observer.text()).not.toContain(plan);
    expect(list).not.toHaveBeenCalled();

    const { scope, workReviews } = await readReviews();
    const offered = workReviews?.find(review => review.kind === "plan");
    if (!offered) throw new Error("Missing plan review");
    expect(offered.review.plan).toBe(plan);
    const { kind, binding } = offered;
    const response = await postDecision({ id: crypto.randomUUID(), scope, kind, ...binding, input: { ...binding.input, decision: "reject" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, kind, status: "rejected" });
    expect((await h.item(itemId)).planApproval).toMatchObject({ status: "rejected" });
    expect(log).toHaveBeenCalledOnce();

    sharing.revoke();
    const revoked = await fetch(snapshot, { headers });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(plan);
    expect(list).toHaveBeenCalledOnce();
  });
});

it.each(["revocation", "prepare failure", "prepare failure with a desktop edit"] as const)(
  "rolls back Create and run after pre-launch %s", async failure => {
    const entered = deferred<{ itemId: number; runId: string }>();
    const release = deferred<void>();
    const spawn = vi.fn();
    const h: Awaited<ReturnType<typeof stageRunHarness>> = await stageRunHarness({
      observeRunWork: true,
      onSpawn: spawn,
      workspace: {
        async prepare(ref, stage) {
          entered.resolve(ref);
          await release.promise;
          if (failure !== "revocation") return { ok: false, code: "workspace-unavailable" };
          return { ok: true, workspace: { kind: "folder", root: join(h.dir, "runs", ref.runId, stage.id) } };
        },
      },
    });
    await h.runThenEnd(async () => {
      await h.confirm([stageOf("a")]);
      const { sharing, log, readReviews, postDecision } = await pairedWorkFixture(h);
      const { scope, workReviews } = await readReviews();
      const offered = workReviews?.find(review => review.kind === "create-and-run");
      if (!offered) throw new Error("Missing start review");

      const pending = postDecision({ id: crypto.randomUUID(), scope, kind: offered.kind, ...offered.binding });
      let allocated: { itemId: number; runId: string };
      try {
        allocated = await Promise.race([entered.promise, pending.then(response => {
          if (!response.ok) throw new Error(`Start refused before preparation: ${response.status}`);
          return entered.promise;
        })]);
        expect((await h.runOf(allocated.runId))?.stageRuns).toMatchObject([{ stageId: "a", status: "running", attempt: 1 }]);
        if (failure === "revocation") sharing.revoke();
        if (failure === "prepare failure with a desktop edit") {
          expect(await h.board.update(allocated.itemId, { title: "Desktop edit", priority: "high" })).toMatchObject({ status: "updated" });
        }
      } finally {
        release.resolve();
      }

      const response = await pending;
      const result = await response.json();
      if (result.ok) (await h.untilSpawned(1))[0].finish();
      if (failure === "revocation") {
        expect.soft(response.status).toBe(403);
        expect.soft(result).toEqual({ ok: false, error: "remote-controller-authority-revoked" });
      } else {
        expect.soft(response.ok).toBe(false);
        expect.soft(result).toMatchObject({ ok: false });
      }
      const { items } = JSON.parse(readFileSync(h.boardPath, "utf8"));
      if (failure === "prepare failure with a desktop edit") {
        expect.soft(items).toEqual([expect.objectContaining({ id: allocated.itemId, title: "Desktop edit", priority: "high" })]);
        expect.soft(items[0]).not.toHaveProperty("runId");
        expect.soft(items[0]).not.toHaveProperty("runHistory");
      } else {
        expect.soft(items).toEqual([]);
      }
      expect.soft(await h.runOf(allocated.runId)).toBeNull();
      await expect(h.engine.retryStage(allocated.itemId, { runId: allocated.runId, stageId: "a", attempt: 1 })).resolves.toMatchObject({ ok: false });
      expect.soft(log).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });
  },
);

it("retracts an unaccepted item after restart during workspace opening", async () => {
  const entered = deferred<{ itemId: number; runId: string }>();
  const release = deferred<void>();
  const spawn = vi.fn();
  const h = await stageRunHarness({ onSpawn: spawn, workspace: {
    async open(ref) {
      entered.resolve(ref);
      await release.promise;
      return { ok: false, code: "workspace-unavailable" };
    },
  } });
  await h.runThenEnd(async () => {
    await h.confirm([stageOf("a")]);
    const { sharing, log, readReviews, postDecision } = await pairedWorkFixture(h);
    const { scope, workReviews } = await readReviews();
    const offered = workReviews?.find(review => review.kind === "create-and-run");
    if (!offered) throw new Error("Missing start review");
    const pending = postDecision({ id: crypto.randomUUID(), scope, kind: offered.kind, ...offered.binding });
    try {
      const { itemId, runId } = await Promise.race([entered.promise, pending.then(response => {
        throw new Error(`Start completed before workspace opening: ${response.status}`);
      })]);
      expect.soft(JSON.parse(readFileSync(h.boardPath, "utf8")).items[0]).toHaveProperty("remoteProvisional");
      expect.soft(await h.board.list()).toMatchObject({ items: [] });
      sharing.revoke();
      const recovered = h.makeEngine();
      await recovered.adoptParkedTemplateRuns();
      expect.soft(JSON.parse(readFileSync(h.boardPath, "utf8")).items).toEqual([]);
      expect.soft(await h.runOf(runId)).toBeNull();
      expect.soft(await recovered.continueRun(itemId, { runId })).toMatchObject({ ok: false });
      expect.soft(await recovered.retryStage(itemId, { runId, stageId: "a", attempt: 1 })).toMatchObject({ ok: false });
      expect.soft(spawn).not.toHaveBeenCalled();
      expect.soft(log).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  });
});

it.each(["controller", "pairing", "web"] as const)("applies a saved %s reduction to the paired forced-on listener", async reduction => {
  const env = { AVE_TAILNET_OBSERVER: "1" };
  const port = await reservePort();
  let saved: TailnetObserverConfigFile = {
    enabled: true, authorization: APP_CAPABILITY, port, controllerEnabled: true, pairedSharingEnabled: true, webEnabled: true, webOrigin: WEB_ORIGIN,
  };
  const readConfigFile = async () => saved;
  const projection = createSharedConversationProjectionStore(createPlatformConversationTimeline());
  stores.push(projection);
  const sharing = pairedSharing({ observe: true, control: true });
  const invoked = vi.fn(async () => ({ ok: false, error: "not_pending" } as const));
  const submit = vi.fn<NonNullable<ConversationCommandPort["submit"]>>(() => ({ completion: Promise.resolve({
    text: "done", toolCalls: [], route: "default", stopReason: "end_turn",
  }) }));
  const startServer = vi.fn(startTailnetSurfaceServer);
  const admission = vi.spyOn(tailnetListenerPolicy, "assertTailnetListenerPortAllowed");
  try {
    await maybeStartTailnetObserverServer({
      env,
      encryption: unavailableSecretEncryption,
      conversationSurfaceRuntime: { sharedProjection: projection } as ConversationSurfaceRuntime,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
      conversationCommandPort: { submit, execute: vi.fn() },
      tailnetPairedSharingRuntime: { authorizer: sharing.authorizer } as TailnetPairedSharingRuntime,
      tailnetControllerReceiptStore: createReceiptStore(),
      workDecisions: { decide: invoked, list: async () => [] },
      dependencies: { readConfigFile, startServer },
    });
    const server = await startServer.mock.results[0].value;
    const roles = tailnetRoleHeaders(["observer", "controller", "work-decision"]);
    const session = await openWebSession(server, roles);
    const headers = webSessionHeaders(session.cookieToken, session.csrfToken, ["observer", "controller", "work-decision"]);
    const snapshot = () => fetch(url(server, "/tailnet/v2/web/snapshot"), { headers });
    const { snapshot: { scope } } = await (await snapshot()).json();
    const command = (browser = true) => fetch(url(server, browser ? "/tailnet/v2/web/commands" : "/tailnet/v1/commands"), {
      method: "POST", headers: { ...(browser ? headers : controllerHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), type: "conversation.send", scope, input: "Remote message" }),
    });
    const work = () => fetch(url(server, "/tailnet/v2/web/work-decisions"), {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
    });
    expect((await command()).status).toBe(202);
    expect(submit).toHaveBeenCalledOnce();
    const actor = submit.mock.calls[0][0];
    if (!("pairedShareGuard" in actor) || !actor.pairedShareGuard || !actor.pairedShare) throw new Error("Controller was unpaired");
    expect(actor.pairedShareGuard.isCurrent(actor.pairedShare)).toBe(true);
    admission.mockClear();
    admission.mockRejectedValue(new Error("Listener admission must not run during reduction"));
    expect((await work()).status).toBe(400);
    const service = createTailnetObserverConfigService({
      env, readConfigFile,
      writeConfigFile: async file => { saved = file; },
      pairedSharingBootstrapFailed: () => false,
      readOwnDeviceAdmission: async () => false,
      probeEnvironment: async () => ({
        state: "ready", cliPath: null, login: "owner@example.com", dnsName: new URL(WEB_ORIGIN).hostname,
        tailnetName: null, serveConfigured: true, serveTargetPort: port, detail: null,
      }),
    });
    const before = (await service.snapshot()).saved;
    await service.apply({
      ...before, enabled: false,
      controllerEnabled: reduction === "web",
      pairedSharingEnabled: reduction !== "pairing",
      webEnabled: reduction === "controller",
    });
    expect.soft((await command()).status).toBe(404);
    expect.soft((await work()).status).toBe(404);
    expect.soft((await service.snapshot()).listeningPort).toBe(port);
    expect.soft(startServer).toHaveBeenCalledOnce();
    expect.soft(admission).not.toHaveBeenCalled();
    expect.soft(actor.pairedShareGuard.isCurrent(actor.pairedShare)).toBe(false);
    expect.soft(submit).toHaveBeenCalledOnce();
    if (reduction === "controller") expect((await snapshot()).status).toBe(200);
    expect((await command(false)).status).toBe(reduction === "web" ? 202 : 404);
  } finally {
    admission.mockRestore();
    await stopTailnetObserverServer();
    resetTailnetObserverServerForTests();
  }
});

it.each([false, true])("retracts an unlaunched remote run after restart (desktop edit: %s)", async edited => {
  const entered = deferred<{ itemId: number; runId: string }>();
  const release = deferred<void>();
  const spawn = vi.fn();
  let restarted = false;
  const h: Awaited<ReturnType<typeof stageRunHarness>> = await stageRunHarness({
    observeRunWork: true,
    onSpawn: spawn,
    workspace: {
      async prepare(ref, stage) {
        if (!restarted) {
          entered.resolve(ref);
          await release.promise;
        }
        return { ok: true, workspace: { kind: "folder", root: join(h.dir, "runs", ref.runId, stage.id) } };
      },
    },
  });
  await h.runThenEnd(async () => {
    await h.confirm([stageOf("a")]);
    const { sharing, log, readReviews, postDecision } = await pairedWorkFixture(h);
    const { scope, workReviews } = await readReviews();
    const offered = workReviews?.find(review => review.kind === "create-and-run");
    if (!offered) throw new Error("Missing start review");
    const pending = postDecision({ id: crypto.randomUUID(), scope, kind: offered.kind, ...offered.binding });
    try {
      const { itemId, runId } = await Promise.race([entered.promise, pending.then(response => {
        throw new Error(`Start completed before preparation: ${response.status}`);
      })]);
      expect(await h.runOf(runId)).toMatchObject({
        stageRuns: [{ stageId: "a", status: "running", attempt: 1 }],
      });
      expect((await h.item(itemId)).remoteProvisional).toMatchObject({ mutationRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
      if (edited) {
        expect(await h.board.update(itemId, { title: "Desktop edit", priority: "high" })).toMatchObject({ status: "updated" });
      }
      sharing.revoke();

      // The replacement reads the same files while the first process is still
      // frozen at preparation, so its request cleanup cannot repair the disk first.
      restarted = true;
      const recovered = h.makeEngine();
      await recovered.adoptParkedTemplateRuns();
      const { items } = JSON.parse(readFileSync(h.boardPath, "utf8"));
      expect.soft(items).toEqual(edited
        ? [expect.objectContaining({ id: itemId, title: "Desktop edit", priority: "high" })] : []);
      expect.soft(items[0]?.runId).toBeUndefined();
      expect.soft(items[0]?.runHistory).toBeUndefined();
      expect.soft(await h.runOf(runId)).toBeNull();
      expect.soft(h.sweeps.at(-1)).not.toContain(runId);
      const continued = await recovered.continueRun(itemId, { runId });
      expect.soft(continued.ok).toBe(false);
      const retry = await recovered.retryStage(itemId, { runId, stageId: "a", attempt: 1 });
      expect.soft(retry.ok).toBe(false);
      if (continued.ok || retry.ok) (await h.untilSpawned(1))[0].finish();
      expect.soft(spawn).not.toHaveBeenCalled();
      expect.soft(log).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  });
});

it("drops review payload when the paired share is revoked while projection is pending", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const sharing = pairedSharing({ observe: true, control: true });
  const list = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return [];
  });
  const { server } = await fixture({
    pairedSharing: sharing.authorizer,
    web: { origin: WEB_ORIGIN, workDecisions: {
      decide: async () => ({ ok: false, error: "not_pending" }),
      list, verifyServeTarget: async () => true, receipts: createReceiptStore(),
    } },
  });
  const session = await openWebSession(server);
  const headers = webSessionHeaders(session.cookieToken, session.csrfToken, ["observer", "controller", "work-decision"]);
  const request = fetch(url(server, "/tailnet/v2/web/snapshot"), { headers });
  try {
    await entered.promise;
    sharing.revoke();
    release.resolve();
    const response = await request;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "web-session-revoked" });
  } finally {
    release.resolve();
  }
});

it.runIf((process.platform === "darwin" || process.platform === "linux") && !shouldSkipNativeSandboxTests())("blocks the active listener from a confined shell both directly and through its proxy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tailnet-shell-"));
  try {
    await initializeRequiredSandbox({ allowedDomains: [], strictAllowlist: false }, async () => true);
    const { server } = await fixture({
      pairedSharing: pairedSharing({ observe: true, control: true }).authorizer,
      web: { origin: WEB_ORIGIN },
    });
    const session = await openWebSession(server);
    const headers = webSessionHeaders(session.cookieToken, session.csrfToken);
    const target = url(server, "/tailnet/v2/web/snapshot");
    expect((await fetch(target, { headers })).status).toBe(200);

    const curl = (bypass: string) => [
      "/usr/bin/curl", "-sS", "-w", "%{http_code}", "--noproxy", bypass, target,
    ].map(quoteSandboxWrappedWord).join(" ");
    const command = `${curl("127.0.0.1")}; printf '\\n'; ${curl("")}`;
    const result = await spawnWithSandbox(command, cwd, [cwd], 10, prepareSandboxFixture(command, cwd, { toolUseId: "tailnet-shell" }));
    expect(result.output).toMatch(/000/u);
    expect(result.output).toContain("tailnet-loopback-destination");
    expect(result.output).toMatch(/403/u);
  } finally {
    await sandbox.resetAsrtSandbox();
    await cleanupTmpDir(cwd);
  }
});
