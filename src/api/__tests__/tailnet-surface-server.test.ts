import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthorizedTailnetController,
  isAuthorizedTailnetObserver,
  startTailnetSurfaceServer,
  type TailnetPairingOptions,
  type TailnetOutputSnapshot,
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
import { initializeAveHomeFixture, protectAveHomeFixture } from "../../__tests__/support/ave-home-privacy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { untilAsserted, within } from "../../__tests__/support/signal-wait.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { unknownToolEffects } from "../../__tests__/support/tool-effect-resolver.js";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import { openEgressRelay, startEgressRelayService, stopEgressRelayService } from "../../permissions/egress-relay/relay.js";
import { openEgressInvocation } from "../../permissions/egress-invocations.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import * as allowedDirectories from "../../permissions/allowed-directories.js";
import { TAILNET_OUTPUT_CARD_HEADER, TAILNET_WORK_DECISION_PATH, type TailnetWorkDecisionRequest, type TailnetWorkDecisionResponse, type TailnetWorkReview, type TailnetWorkReviewSnapshot } from "../../shared/tailnet-work-decisions.js";
import type { TemplateGraph } from "../../shared/workflow-template-types.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import * as tailnetListenerPolicy from "../../permissions/tailnet-listener-policy.js";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { quoteSandboxWrappedWord } from "../../permissions/sandbox-wrapped-command.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { aveHome } from "../../shared/ave-home.js";
import { RoutinesStore } from "../../main/routines-store.js";
import { createTailnetObserverConfigService } from "../../main/tailnet-observer-config-service.js";
import { createTailnetOwnerIdentityPolicy } from "../../main/tailnet-owner-policy.js";
import { maybeStartTailnetObserverServer, resetTailnetObserverServerForTests, stopTailnetObserverServer, type TailnetObserverConfigFile } from "../../main/tailnet-surface-server.js";
import type { TailnetPairedSharingRuntime } from "../../main/tailnet-paired-sharing-runtime.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import { createTailnetWorkDecisions } from "../../main/tailnet-work-decisions.js";
import { ToolRegistry } from "../../tools/registry.js";
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

async function pairedWorkFixture(h: Awaited<ReturnType<typeof stageRunHarness>>, approvalGate?: ApprovalGate) {
  if (process.platform === "win32") {
    const home = aveHome();
    protectAveHomeFixture(home);
    await initializeAveHomeFixture(home);
  }
  const sharing = pairedSharing({ observe: true, control: true });
  const routines = new RoutinesStore(join(h.dir, "routines.json"));
  routines.bindTemplateAttachments(h.templates);
  const log = vi.fn();
  const runtime = createTailnetWorkDecisions({
    workBoardStore: h.board, workBoardEngine: h.engine, workflowTemplateStore: h.templates, routinesStore: routines,
    settingsService: { get: key => DEFAULT_SETTINGS[key] }, auditLogger: { log }, toolRegistry: new ToolRegistry(), approvalGate,
  });
  if (!runtime) throw new Error("Work decision runtime unavailable");
  const list = vi.fn(runtime.list);
  const { server } = await fixture({
    pairedSharing: sharing.authorizer,
    web: { origin: WEB_ORIGIN, workDecisions: { ...runtime, list, verifyServeTarget: async () => true, receipts: createReceiptStore() } },
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
  return { server, sharing, snapshot, session, headers, list, log, routines, readReviews, postDecision };
}

it.each(["project access is revoked", "the approval settles"])(
  "withholds prepared output card arguments and its handle when %s during the work list",
  async change => {
    const h = await stageRunHarness();
    await h.runThenEnd(async () => {
      const gate = new ApprovalGate(() => null);
      const allowed = vi.spyOn(allowedDirectories, "sanitizeRuntimeAllowedDirectories").mockReturnValue([h.dir]);
      const listing = deferred<void>();
      const release = deferred<void>();
      const invocation = new AbortController();
      const sessionId = "output-review-session";
      const outputId = "send";
      const toolName = "send_report";
      const requestId = crypto.randomUUID();
      const body = "Arguments visible only while this project is authorized";
      const unbind = gate.bindRequestedOutput(sessionId, {
        binding: { itemId: 1, runId: "run", stageId: "review", attempt: 1, resultHash: "result", outputHash: "outputs", outputId },
        toolName, source: "mcp", ownerId: "reports", projectRoot: h.dir, signal: invocation.signal,
        canExecute: () => true, refuseDisplay: () => { throw new Error("Expected displayable args"); }, recordWinner: () => {},
      });
      try {
        const { snapshot, headers, list } = await pairedWorkFixture(h, gate);
        const read = () => fetch(snapshot, { headers: { ...headers, [TAILNET_OUTPUT_CARD_HEADER]: "1" } });
        expect((await read()).status).toBe(200);
        const pending = gate.requestAndWait({
          id: requestId, sessionId, category: "tool", toolName, source: "mcp", args: { body },
          reason: "Send report", invocationToolUseId: outputId, abortSignal: invocation.signal, createdAt: Date.now(),
        });
        expect(gate.pendingCount).toBe(1);
        const live: TailnetWorkReviewSnapshot = (await (await read()).json()).snapshot;
        const [card] = live.outputCards ?? [];
        if (!card || !("handle" in card)) throw new Error("Expected a live execution card");
        expect(card.content.argsText).toContain(body);
        list.mockImplementationOnce(async () => {
          listing.resolve();
          await release.promise;
          return [];
        });
        const inFlight = read();
        await within(listing.promise, "work list to pause with a prepared output card");
        if (change === "project access is revoked") allowed.mockReturnValue([]);
        else {
          invocation.abort();
          await pending;
        }
        release.resolve();
        const response = await inFlight;
        expect(response.status).toBe(200);
        const payload = await response.text();
        expect(payload).not.toContain(body);
        expect(payload).not.toContain(card.handle);
      } finally {
        release.resolve();
        unbind();
        gate.disposeAll();
        allowed.mockRestore();
      }
    });
  },
);

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

it("reports the port as applied when manual enable binds a fileless observer", async () => {
  const env = {};
  const port = await reservePort();
  let file: TailnetObserverConfigFile | null = null;
  const readConfigFile = async () => file;
  const projection = createSharedConversationProjectionStore(createPlatformConversationTimeline());
  stores.push(projection);
  const service = createTailnetObserverConfigService({
    env, readConfigFile,
    writeConfigFile: async saved => { file = saved; },
    pairedSharingBootstrapFailed: () => false,
    readOwnDeviceAdmission: async () => false,
    probeEnvironment: async () => ({
      state: "ready", cliPath: null, login: null, dnsName: null,
      tailnetName: null, serveConfigured: false, serveTargetPort: null, detail: null,
    }),
  });
  try {
    await expect(maybeStartTailnetObserverServer({
      env,
      encryption: unavailableSecretEncryption,
      conversationSurfaceRuntime: { sharedProjection: projection } as ConversationSurfaceRuntime,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
      dependencies: { readConfigFile },
    })).resolves.toBeNull();
    const { saved } = await service.snapshot();
    await expect.soft(service.apply({
      ...saved, enabled: true, authorization: APP_CAPABILITY, port,
    })).resolves.toEqual({ outcome: "applied", restartNeeded: false });
    await expect(service.snapshot()).resolves.toMatchObject({ listeningPort: port, portBlock: null });
  } finally {
    await stopTailnetObserverServer();
    resetTailnetObserverServerForTests();
  }
});

it.each([
  { row: "A09", enableOverride: undefined, pinMatchesSave: true },
  { row: "A09", enableOverride: undefined, pinMatchesSave: false },
  { row: "A14", enableOverride: "1", pinMatchesSave: true },
  { row: "A14", enableOverride: "1", pinMatchesSave: false },
])("replaces the live authorization key for $row (pin matches save: $pinMatchesSave)", async ({
  enableOverride, pinMatchesSave,
}) => {
  const port = await reservePort();
  const savedPort = pinMatchesSave ? port : port === 28_173 ? 28_174 : 28_173;
  const env = { AVE_TAILNET_OBSERVER: enableOverride, AVE_TAILNET_OBSERVER_PORT: String(port) };
  const nextCapability = `${CAPABILITY}-next`;
  let file: TailnetObserverConfigFile = {
    enabled: true, authorization: APP_CAPABILITY, port: savedPort, pairedSharingEnabled: true,
  };
  const readConfigFile = async () => file;
  const projection = createSharedConversationProjectionStore(createPlatformConversationTimeline());
  stores.push(projection);
  const sharing = pairedSharing({ observe: true, control: false });
  const startServer = vi.fn(startTailnetSurfaceServer);
  const settings = createTailnetObserverConfigService({
    env, readConfigFile,
    writeConfigFile: async saved => { file = saved; },
    pairedSharingBootstrapFailed: () => false,
    readOwnDeviceAdmission: async () => false,
    probeEnvironment: async () => ({
      state: "ready", cliPath: null, login: null, dnsName: null,
      tailnetName: null, serveConfigured: false, serveTargetPort: null, detail: null,
    }),
  });
  const status = async (capability: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/tailnet/v1/status`, {
      headers: {
        ...observerHeaders(),
        Connection: "close",
        "Tailscale-App-Capabilities": JSON.stringify({ [capability]: [{ role: "observer" }] }),
      },
    });
    await response.text();
    return response.status;
  };
  try {
    await maybeStartTailnetObserverServer({
      env,
      encryption: unavailableSecretEncryption,
      conversationSurfaceRuntime: { sharedProjection: projection } as ConversationSurfaceRuntime,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
      tailnetPairedSharingRuntime: { authorizer: sharing.authorizer } as TailnetPairedSharingRuntime,
      dependencies: { readConfigFile, startServer },
    });
    expect(await status(CAPABILITY)).toBe(200);
    expect(await status(nextCapability)).toBe(401);
    const { saved } = await settings.snapshot();
    await expect(settings.apply({
      ...saved, enabled: true, authorization: { kind: "app-capability", capability: nextCapability },
    })).resolves.toEqual({ outcome: "applied", restartNeeded: false });
    expect.soft(await status(CAPABILITY)).toBe(401);
    expect.soft(await status(nextCapability)).toBe(200);
    expect.soft(startServer).toHaveBeenCalledTimes(2);
    expect(file.port).toBe(savedPort);
  } finally {
    await stopTailnetObserverServer();
    resetTailnetObserverServerForTests();
  }
});

it.each([
  { row: "A06", changesPort: false, outcome: "saved" },
  { row: "A07", changesPort: true, outcome: "restart-needed" },
])("keeps the running observer grant requirement for $row", async ({ changesPort, outcome }) => {
  const port = await reservePort();
  const proposedPort = changesPort ? (port === 28_173 ? 28_174 : 28_173) : port;
  const env = { AVE_TAILNET_OBSERVER: "1" };
  let file: TailnetObserverConfigFile = { enabled: true, port, authorization: APP_CAPABILITY };
  const readConfigFile = async () => file;
  const projection = createSharedConversationProjectionStore(createPlatformConversationTimeline());
  stores.push(projection);
  const grantedHeaders = observerHeaders();
  const identityOnlyHeaders = { "Tailscale-User-Login": grantedHeaders["Tailscale-User-Login"] };
  const ownerPolicy = createTailnetOwnerIdentityPolicy({ getOwnerLogin: () => identityOnlyHeaders["Tailscale-User-Login"] });
  const startServer = vi.fn((options: Parameters<typeof startTailnetSurfaceServer>[0]) =>
    startTailnetSurfaceServer({ ...options, ...ownerPolicy }),
  );
  const settings = createTailnetObserverConfigService({
    env, readConfigFile,
    writeConfigFile: async saved => { file = saved; },
    pairedSharingBootstrapFailed: () => false,
    readOwnDeviceAdmission: async () => false,
    probeEnvironment: async () => ({
      state: "ready", cliPath: null, login: null, dnsName: null,
      tailnetName: null, serveConfigured: false, serveTargetPort: null, detail: null,
    }),
  });
  const status = async (headers: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${port}/tailnet/v1/status`, {
      headers: { ...headers, Connection: "close" },
    });
    await response.text();
    return response.status;
  };
  try {
    await maybeStartTailnetObserverServer({
      env,
      encryption: unavailableSecretEncryption,
      conversationSurfaceRuntime: { sharedProjection: projection } as ConversationSurfaceRuntime,
      getCurrentConversationId: () => CONVERSATION_ID,
      isConversationBusy: () => false,
      dependencies: { readConfigFile, startServer },
    });
    expect(await status(identityOnlyHeaders)).toBe(401);
    expect(await status(grantedHeaders)).toBe(200);
    const { saved } = await settings.snapshot();
    await expect(settings.apply({
      ...saved, enabled: false, port: proposedPort, authorization: { kind: "tailnet-identity" },
    })).resolves.toEqual({ outcome, restartNeeded: changesPort });
    expect.soft(file).toEqual({ port: proposedPort, authorization: { kind: "tailnet-identity" } });
    expect.soft(await status(identityOnlyHeaders)).toBe(401);
    expect.soft(await status(grantedHeaders)).toBe(200);
    expect(startServer).toHaveBeenCalledOnce();
  } finally {
    await stopTailnetObserverServer();
    resetTailnetObserverServerForTests();
  }
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

describe("phone work reviews", () => {
  const pin = { templateId: "review-template", version: 2, graphHash: "b".repeat(64) };
  const runId = "review-run";
  const outputDecl = { kind: "send-message", owner: "server", ownerId: "reports", toolName: "send_report" } as const;
  const outputArgs = { to: "report-review" };
  const stageBinding = { runId, stageId: "review-stage", attempt: 2, resultHash: "c".repeat(64), outputHash: "d".repeat(64) };
  const joinBinding = { runId, joinId: "join-review", generation: 2, conflictHash: "e".repeat(64) };
  const templateScope = { kind: "all" } as const;
  const graph: TemplateGraph = {
    stages: [{ id: "review-stage", name: "Collect", goal: "Read the report", inputs: [], toolScope: "read", allowSubAgents: false, gate: { type: "human" } }],
    edges: [], setupCommands: ["prepare report"],
  };
  const schedule = { at: "2099-01-01T09:00:00.000Z", repeat: { kind: "daily" as const } };
  const views = [
    {
      kind: "plan", deny: "reject", binding: { itemId: 1, input: { runId, planHash: "a".repeat(64) } },
      review: {
        kind: "plan", key: "plan:1", scope: { type: "unscoped" }, title: "Review plan", itemId: 1, runId, planHash: "a".repeat(64),
        arrivedAt: "2026-11-27T00:00:00Z", plan: '<img src="review-content">\nA complete plan', phase: "pending",
        revision: 0, planNumber: 1, stale: false,
      },
    },
    {
      kind: "stage", deny: "reject", binding: { itemId: 2, input: stageBinding }, reviewHandle: "140922fd-aab0-44b8-8fdd-559c4ed13a21",
      review: {
        kind: "stage-gate", key: "stage:2", itemId: 2, binding: stageBinding, title: "Stage review",
        result: "The stage result", outputs: [{
          id: "output", summary: "Send the report", payload: JSON.stringify({ ...outputDecl, args: outputArgs }, null, 2),
        }],
        scope: { type: "unscoped" }, arrivedAt: null,
      },
    },
    {
      kind: "join", deny: "reject", binding: { itemId: 3, input: joinBinding },
      review: {
        kind: "join-conflict", key: "join:3", itemId: 3, binding: joinBinding, title: "Join review",
        evidence: { reason: "same-path", files: [{ path: "reports/join.txt", stageIds: ["one", "two"] }], excerpt: "Conflict excerpt" },
        scope: { type: "unscoped" }, arrivedAt: null,
      },
    },
    {
      kind: "template-confirmation", deny: "dismiss",
      binding: { templateId: pin.templateId, input: { expectedDraftRevision: "draft-revision", expectedGraphHash: pin.graphHash } },
      review: { name: "Workflow draft", scope: templateScope, description: "Draft description", ...graph },
    },
    {
      kind: "create-and-run", deny: "dismiss",
      binding: { input: { ...pin, title: "Workflow run", detail: "Run details" } },
      review: { name: "Workflow run", scope: templateScope, graph, projects: [] },
    },
    {
      kind: "schedule-attachment", deny: "dismiss", binding: { input: { ...pin, expectedScope: templateScope, scheduleId: "routine-one" } },
      review: {
        name: "Workflow run", existingPin: { ...pin, version: 1, graphHash: "f".repeat(64) },
        routine: { schedule, title: "Existing schedule", lastTemplateSkip: { code: "run-unsettled" } },
      },
    },
    {
      kind: "requested-output", deny: "reject", reviewHandle: "140922fd-aab0-44b8-8fdd-559c4ed13a21",
      binding: { input: { itemId: 2, runId, stageId: stageBinding.stageId, attempt: stageBinding.attempt, outputHash: stageBinding.outputHash } },
      review: { outputs: [{
        id: "output", decl: outputDecl,
        summary: "Send the report", files: [{ path: "reports/output.txt", sha256: "b".repeat(64), size: 43 }],
      }] },
    },
  ] satisfies [TailnetWorkReview, ...TailnetWorkReview[]];
  const roles = ["observer", "controller", "work-decision"] as const;
  type PhoneReviewBrowser = { window: Window & typeof globalThis };
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string, options: { url: string; runScripts: "outside-only" }) => PhoneReviewBrowser;
  };

  async function openPhoneReviews(
    reviews: readonly TailnetWorkReview[],
    response: (decision: TailnetWorkDecisionRequest) => TailnetWorkDecisionResponse | Promise<TailnetWorkDecisionResponse>,
    language = "en-US",
    grantedRoles: readonly ("observer" | "controller" | "work-decision")[] = roles,
    outputSnapshot?: NonNullable<TailnetWebOptions["workDecisions"]>["outputSnapshot"],
  ) {
    const sharing = pairedSharing({ observe: true, control: true });
    const received: TailnetWorkDecisionRequest[] = [];
    const decisions = new EventTarget();
    const { server } = await fixture({
      pairedSharing: sharing.authorizer,
      web: { origin: WEB_ORIGIN, workDecisions: {
        decide: async decision => {
          received.push(decision);
          decisions.dispatchEvent(new Event("decision"));
          return response(decision);
        },
        list: async () => reviews,
        outputSnapshot,
        verifyServeTarget: async () => true,
        receipts: createReceiptStore(),
      } },
    });
    const waitForDecisions = (count: number) => untilAsserted(wake => {
      decisions.addEventListener("decision", wake);
      return () => decisions.removeEventListener("decision", wake);
    }, () => expect(received).toHaveLength(count), `phone server to receive ${count} decisions`);
    return { ...await openPhoneReviewDocument(server, language, grantedRoles), received, waitForDecisions };
  }

  async function openPhoneReviewDocument(server: TailnetSurfaceServer, language = "en-US", grantedRoles: Parameters<typeof tailnetRoleHeaders>[0] = roles) {
    const requests: Array<{ path: string; method: string; csrf: string | null; credentials?: RequestCredentials }> = [];
    const session = await openWebSession(server, { ...tailnetRoleHeaders(grantedRoles), "Accept-Language": language });
    const browser = new JSDOM(session.html, { url: WEB_ORIGIN, runScripts: "outside-only" });
    const streamRequested = deferred<void>();
    try {
      const headers = webSessionHeaders(session.cookieToken, session.csrfToken, grantedRoles);
      delete headers["X-Ave-Tailnet-Csrf"];
      Object.assign(browser.window, {
        Headers,
        fetch: (path: string, init?: RequestInit) => {
          const supplied = new Headers(init?.headers);
          requests.push({
            path, method: init?.method ?? "GET", csrf: supplied.get("x-ave-tailnet-csrf"), credentials: init?.credentials,
          });
          if (path.includes("/events?")) {
            streamRequested.resolve();
            return new Response(new ReadableStream());
          }
          return fetch(url(server, path), { ...init, headers: { ...headers, ...Object.fromEntries(supplied) } });
        },
      });
      for (const script of browser.window.document.scripts) browser.window.eval(script.textContent ?? "");
      await within(streamRequested.promise, "phone page to request its scoped event stream");
      return { browser, session, requests };
    } catch (error) {
      browser.window.close();
      throw error;
    }
  }

  function waitForPhoneDom(browser: PhoneReviewBrowser, assertion: () => void) {
    return untilAsserted(wake => {
      const observer = new browser.window.MutationObserver(wake);
      observer.observe(browser.window.document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      return () => observer.disconnect();
    }, assertion, "phone review DOM update");
  }

  function nextPhoneSnapshot(browser: PhoneReviewBrowser) {
    const status = browser.window.document.getElementById("status");
    if (!status) throw new Error("Missing phone connection status");
    // The page writes this status after applying the snapshot to the review cards.
    const rendered = deferred<void>();
    const observer = new browser.window.MutationObserver(() => rendered.resolve());
    observer.observe(status, { childList: true });
    return within(rendered.promise, "phone snapshot to render").finally(() => observer.disconnect());
  }

  it.each([["en-US", "en", "Work approvals"], ["ko-KR", "ko", "업무 승인"]])(
    "renders complete phone reviews inside the nonce document for %s",
    async (language, locale, heading) => {
      const { browser, session } = await openPhoneReviews(views, () => ({ ok: true, kind: "join" }), language);
      try {
        const document = browser.window.document;
        const section = document.getElementById("work-reviews");
        expect(document.documentElement.lang).toBe(locale);
        expect(section?.hidden).toBe(false);
        expect(section?.querySelector("h2")?.textContent).toBe(heading);
        expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toContain("width=device-width");
        const style = document.querySelector("style");
        expect(style?.textContent).toContain("color-scheme: light dark");
        for (const element of [style, ...document.scripts]) expect(session.csp).toContain(`'nonce-${element?.nonce}'`);
        for (const view of views) expect(section?.querySelector(`[data-work-kind="${view.kind}"]`)).not.toBeNull();
        for (const evidence of [
          '<img src="review-content">', "A complete plan", "The stage result", stageBinding.resultHash, stageBinding.outputHash,
          "reports/join.txt", "Conflict excerpt", joinBinding.conflictHash, "draft-revision", "Draft description", "prepare report",
          pin.graphHash, "Existing schedule", "f".repeat(64), "send_report", "reports/output.txt",
        ]) expect(section?.textContent).toContain(evidence);
        expect(section?.querySelector("textarea[maxlength=\"16384\"]")).toHaveProperty("value", "Run details");
        expect(section?.querySelector("img")).toBeNull();
        expect(section?.textContent).not.toContain("report-review");
      } finally {
        browser.window.close();
      }
    },
  );

  it("keeps review data and actions hidden on a share without work decision capability", async () => {
    const { browser, requests } = await openPhoneReviews(views, () => ({ ok: true, kind: "join" }), "en", ["observer", "controller"]);
    try {
      expect(browser.window.document.getElementById("work-reviews")?.hidden).toBe(true);
      expect(browser.window.document.querySelector("[data-work-kind]")).toBeNull();
      expect(requests.filter(request => request.method === "POST")).toHaveLength(0);
    } finally {
      browser.window.close();
    }
  });

  it("shows full execution arguments as text and closes the phone card on settlement", async () => {
    const requestId = "140922fd-aab0-44b8-8fdd-559c4ed13a21";
    const handle = `${requestId}.${Date.now() + 30_000}.${"a".repeat(64)}`;
    const argsText = JSON.stringify({ body: `<img src="not-a-node"> ${"자료".repeat(500)}` }, null, 2);
    let settled = false;
    const projection = vi.fn(async (): Promise<TailnetOutputSnapshot> => () => ({ outputCards: settled
      ? [{ requestId, resolvedBy: "tailnet-surface" }]
      : [{ requestId, handle, content: { toolName: "send_report", ownerId: "reports", argsText, serviceEndpoint: "https://reports.example.test/tool" } }] }));
    const { browser, received, waitForDecisions } = await openPhoneReviews([], () => {
      settled = true;
      return { ok: true, kind: "output-execution-card" };
    }, "en", roles, projection);
    try {
      const card = browser.window.document.querySelector("#output-execution-cards article");
      expect(card?.querySelector("pre")?.textContent).toBe(argsText);
      expect(card?.querySelector("pre")?.tabIndex).toBe(0);
      expect(card?.textContent).toContain("https://reports.example.test/tool");
      expect(card?.querySelector("img")).toBeNull();
      const allow = card?.querySelector<HTMLButtonElement>("button[data-work-action=approve]");
      expect(allow?.textContent).toBe("Allow once");
      allow?.click();
      allow?.click();
      await waitForDecisions(1);
      expect(received[0]).toMatchObject({ kind: "output-execution-card", input: { handle, choice: "allow-once" } });
      expect(projection).toHaveBeenCalledWith(expect.objectContaining({ outputPage: expect.objectContaining({ id: expect.any(String) }) }));
      await waitForPhoneDom(browser, () => expect(card?.textContent).toContain("Resolved by phone"));
      expect(card?.querySelector("button, pre")).toBeNull();
    } finally { browser.window.close(); }
  });

  it("restores both choices after a refused phone POST and a fresh live offer", async () => {
    const requestId = crypto.randomUUID();
    const handle = `${requestId}.${Date.now() + 30_000}.${"a".repeat(64)}`;
    const refreshedHandle = `${requestId}.${Date.now() + 30_000}.${"b".repeat(64)}`;
    const content = { toolName: "send_report", ownerId: "reports", argsText: '{"body":"Ready"}' };
    const refusal = deferred<TailnetWorkDecisionResponse>();
    const listStarted = deferred<void>();
    const releaseList = deferred<void>();
    let currentHandle = handle;
    let settled = false;
    const projection = vi.fn(async (): Promise<TailnetOutputSnapshot> => () => ({ outputCards: settled
      ? [{ requestId, resolvedBy: "tailnet-surface" }]
      : [{ requestId, handle: currentHandle, content }] }));
    const answer = vi.fn<() => Promise<TailnetWorkDecisionResponse>>()
      .mockImplementationOnce(() => refusal.promise)
      .mockImplementationOnce(async () => {
        settled = true;
        return { ok: true, kind: "output-execution-card" };
      });
    const { browser, received, waitForDecisions } = await openPhoneReviews([], answer, "en", roles, projection);
    try {
      const card = browser.window.document.querySelector("#output-execution-cards article");
      const allow = card?.querySelector<HTMLButtonElement>("button[data-work-action=approve]");
      const deny = card?.querySelector<HTMLButtonElement>("button[data-work-action=deny]");
      if (!allow || !deny) throw new Error("Missing execution card choices");
      allow.click();
      await waitForDecisions(1);
      expect(allow.disabled && deny.disabled).toBe(true);

      projection.mockImplementationOnce(async () => {
        listStarted.resolve();
        await releaseList.promise;
        return () => ({ outputCards: [{ requestId, handle, content }] });
      });
      const staleRendered = nextPhoneSnapshot(browser);
      refreshPhoneReviews(browser);
      await within(listStarted.promise, "snapshot started while the POST was pending");
      refusal.resolve({ ok: false, error: "requested-output-card-unavailable" });
      await waitForPhoneDom(browser, () => {
        expect(card?.querySelector("[role=status]")?.textContent).toContain("The requested-output review is unavailable");
      });
      expect(allow.disabled && deny.disabled).toBe(true);
      currentHandle = refreshedHandle;
      releaseList.resolve();
      await staleRendered;
      expect(allow.disabled && deny.disabled).toBe(true);

      await nextPhoneSnapshot(browser);
      expect(allow.disabled).toBe(false);
      expect(deny.disabled).toBe(false);
      expect(received).toHaveLength(1);
      deny.click();
      await waitForDecisions(2);
      expect(received[1]).toMatchObject({ kind: "output-execution-card", input: { handle: refreshedHandle, choice: "deny-once" } });
      await waitForPhoneDom(browser, () => expect(card?.textContent).toContain("Resolved by phone"));
      expect(card?.querySelector("button, pre")).toBeNull();
    } finally {
      refusal.resolve({ ok: false, error: "requested-output-card-unavailable" });
      releaseList.resolve();
      browser.window.close();
    }
  });

  it("renders the destination template, active pin and failure from the paired schedule snapshot", async () => {
    const h = await stageRunHarness();
    await h.runThenEnd(async () => {
      const prior = h.pinOf(await h.confirm([stageOf("prior")]));
      for (const name of ["Quarterly report", "Publish digest"]) {
        const { template, draft } = await h.templates.draft(null, { name, scope: templateScope, ...graph, setupCommands: [] });
        if (!draft) throw new Error("Missing workflow draft");
        await h.templates.confirmDraft(template.id, { expectedGraphHash: draft.graphHash, expectedDraftRevision: draft.revision },
          { who: "owner", origin: "local-desktop" }, unknownToolEffects);
      }
      const { server, routines, readReviews, postDecision } = await pairedWorkFixture(h);
      const { scope } = await readReviews();
      const attached = await postDecision({ id: crypto.randomUUID(), scope, kind: "schedule-attachment",
        input: { ...prior, expectedScope: templateScope, schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } } },
      });
      const result: TailnetWorkDecisionResponse = await attached.json();
      expect(attached.status, JSON.stringify(result)).toBe(200);
      if (!result.ok || result.kind !== "schedule-attachment") throw new Error("Schedule not attached");
      const fired = await routines.markFired(result.scheduleId);
      if (!fired?.lastFiredAt) throw new Error("Schedule not fired");
      await routines.recordRunOutcome(result.scheduleId, fired.lastFiredAt, { ok: false, kind: "error", reason: "Stage failed" });
      const [desktop] = (await routines.listScheduleDisplay()).routines;
      if (!desktop?.title) throw new Error("Missing schedule title");
      const title = desktop.title;
      const { workReviews } = await readReviews();
      const offered = workReviews?.find(review => review.kind === "schedule-attachment" && review.review.name === "Quarterly report");
      expect(offered).toMatchObject({ review: { existingPin: prior, routine: { lastFailure: desktop.lastFailure } } });
      expect(desktop.lastFailure).toMatchObject({ kind: "error", reason: "Stage failed" });

      for (const [locale, failure] of [["en", "The scheduled workflow could not run."], ["ko", "예약된 워크플로를 실행하지 못했습니다."]]) {
        const { browser } = await openPhoneReviewDocument(server, locale);
        try {
          const cards = Array.from(browser.window.document.querySelectorAll('[data-work-kind="schedule-attachment"]'));
          for (const name of ["Quarterly report", "Publish digest"]) {
            const card = cards.find(node => node.querySelector("summary")?.textContent?.includes(title)
              && node.querySelector("summary")?.textContent?.includes(name));
            expect(card, name).toBeDefined();
            expect(card?.querySelector(".work-review-body")?.textContent).toContain(name);
            expect(card?.textContent).toContain(failure);
            const pinLabel = locale === "en" ? "Currently attached version" : "현재 연결된 버전";
            const activePin = Array.from(card?.querySelectorAll("h4") ?? []).find(heading => heading.textContent === pinLabel)?.nextElementSibling;
            expect(Array.from(activePin?.querySelectorAll("dd") ?? [], value => value.textContent)).toEqual([
              prior.templateId, String(prior.version), prior.graphHash,
            ]);
          }
        } finally {
          browser.window.close();
        }
      }
    });
  });

  function phoneAction(browser: PhoneReviewBrowser, kind: TailnetWorkReview["kind"], action: string, index = 0): HTMLButtonElement {
    const card = browser.window.document.querySelectorAll(`[data-work-kind="${kind}"]`)[index];
    const button = card?.querySelector<HTMLButtonElement>(`button[data-work-action="${action}"]`);
    if (!button) throw new Error("Phone action is missing");
    return button;
  }

  function reviewStatus(browser: PhoneReviewBrowser, kind: TailnetWorkReview["kind"], index = 0) {
    return browser.window.document.querySelectorAll(`[data-work-kind="${kind}"] [role="status"]`)[index]?.textContent;
  }

  function refreshPhoneReviews(browser: PhoneReviewBrowser) {
    browser.window.document.getElementById("work-review-refresh")?.click();
  }

  function recentPhoneResults(browser: PhoneReviewBrowser) {
    return browser.window.document.querySelector<HTMLElement>('#work-review-recent [role="status"]');
  }

  const refreshedStageBinding = { ...stageBinding, attempt: stageBinding.attempt + 1, resultHash: "1".repeat(64), outputHash: undefined };
  const refreshedJoinBinding = { ...joinBinding, generation: joinBinding.generation + 1, conflictHash: "2".repeat(64) };
  const refreshedPlanHash = "3".repeat(64);
  const refreshedGraphHash = "4".repeat(64);
  const refreshedOutputHash = "5".repeat(64);
  const refreshCases = [
    [views[0], { ...views[0], binding: { ...views[0].binding, input: { runId, planHash: refreshedPlanHash } },
      review: { ...views[0].review, plan: "A revised plan", planHash: refreshedPlanHash, revision: 1, planNumber: 2 } }, refreshedPlanHash, "plan_mismatch", "Decision refused (plan_mismatch)."],
    [views[1], { ...views[1], binding: { ...views[1].binding, input: refreshedStageBinding },
      review: { ...views[1].review, binding: refreshedStageBinding, outputs: [] } }, refreshedStageBinding.resultHash, "result_mismatch", "The result changed."],
    [views[2], { ...views[2], binding: { ...views[2].binding, input: refreshedJoinBinding },
      review: { ...views[2].review, binding: refreshedJoinBinding } }, refreshedJoinBinding.conflictHash, "conflict_mismatch", "The conflict changed."],
    [views[3], { ...views[3], binding: { ...views[3].binding, input: { expectedDraftRevision: "next-draft", expectedGraphHash: refreshedGraphHash } } },
      refreshedGraphHash, "graph-mismatch", "The stored template no longer matches"],
    [views[4], { ...views[4], binding: { input: { ...views[4].binding.input, version: pin.version + 1, graphHash: refreshedGraphHash } } },
      refreshedGraphHash, "pin-mismatch", "The template version differs"],
    [views[5], { ...views[5], binding: { input: { ...views[5].binding.input, version: pin.version + 1, graphHash: refreshedGraphHash } } },
      refreshedGraphHash, "pin-mismatch", "The template version differs"],
    [views[6], { ...views[6], binding: { input: { ...views[6].binding.input, attempt: stageBinding.attempt + 1, outputHash: refreshedOutputHash } } },
      refreshedOutputHash, "output_mismatch", "The requested outputs changed."],
  ] satisfies Array<[TailnetWorkReview, TailnetWorkReview, string, string, string]>;

  describe.each(refreshCases.map(([original, ...rest]) => [original.kind, original, ...rest] as const))("%s refresh orderings", (kind, original, revised, marker, error, refusal) => {
    it.each([
      "submit then refresh", "refresh then response", "two cards in flight", "revision changes between submit and response",
      "identity leaves before response", "editor opened on the new revision before the response",
    ])("%s", async ordering => {
      const result = deferred<TailnetWorkDecisionResponse>();
      const otherResult = deferred<TailnetWorkDecisionResponse>();
      const secondPlan = { ...views[0], binding: { ...views[0].binding, itemId: 42 },
        review: { ...views[0].review, key: "plan:42", itemId: 42, title: "Second plan" } };
      const other = kind === "plan" ? secondPlan : kind === "join" ? views[0] : views[2];
      const otherIndex = kind === "plan" ? 1 : 0;
      const reviews: TailnetWorkReview[] = [original];
      if (ordering === "two cards in flight") reviews.push(other);
      if (kind === "stage") reviews.push(views[6]);
      if (kind === "requested-output" && ordering === "identity leaves before response") reviews.push(views[1]);
      function isOriginal(decision: TailnetWorkDecisionRequest) {
        return decision.kind === kind && (decision.kind !== "plan" || decision.itemId !== secondPlan.binding.itemId);
      }
      const { browser, received, waitForDecisions, requests } = await openPhoneReviews(reviews, decision => isOriginal(decision) ? result.promise : otherResult.promise);
      const otherSuccess: TailnetWorkDecisionResponse = other.kind === "join"
        ? { ok: true, kind: "join" } : { ok: true, kind: "plan", status: "approved" };
      function expectActions(approve: boolean, alternative: boolean) {
        expect(phoneAction(browser, kind, "approve").disabled).toBe(!approve);
        if (original.deny === "reject") expect(phoneAction(browser, kind, "reject").disabled).toBe(!alternative);
        if (kind === "stage" || kind === "plan") expect(phoneAction(browser, kind, "request_changes").disabled).toBe(!alternative);
      }
      async function refresh() {
        reviews[0] = revised;
        if (kind === "stage") reviews.pop();
        refreshPhoneReviews(browser);
        await waitForPhoneDom(browser, () => expect(browser.window.document.querySelector(`[data-work-kind="${kind}"] .work-review-body`)?.textContent).toContain(marker));
      }
      try {
        expect(reviewStatus(browser, kind)).toBe("");
        expectActions(true, true);
        phoneAction(browser, kind, "approve").click();
        if (ordering === "two cards in flight") {
          phoneAction(browser, other.kind, "approve", otherIndex).click();
          expect(phoneAction(browser, other.kind, "approve", otherIndex).disabled).toBe(true);
          expect(reviewStatus(browser, other.kind, otherIndex)).toBe("Submitting decision…");
        }
        await waitForDecisions(ordering === "two cards in flight" ? 2 : 1);
        expect(received.find(isOriginal)).toMatchObject({ kind, ...original.binding });
        expect(reviewStatus(browser, kind)).toBe("Submitting decision…");
        expectActions(false, false);

        if (ordering === "identity leaves before response") {
          reviews.length = 0;
          refreshPhoneReviews(browser);
          await waitForPhoneDom(browser, () => expect(reviewStatus(browser, kind)).toBeUndefined());
          result.resolve({ ok: false, error });
          await waitForPhoneDom(browser, () => expect(recentPhoneResults(browser)?.textContent ?? "").toContain(refusal));
          const recent = recentPhoneResults(browser);
          if (kind === "requested-output") expect(recent?.textContent).toContain(views[1].review.title);
          expect(recent?.querySelectorAll("button")).toHaveLength(1);
          recent?.querySelector("button")?.click();
          expect(recent?.textContent).toBe("");
          expect(received).toHaveLength(1);
          return;
        }

        if (ordering === "submit then refresh") {
          result.resolve({ ok: false, error });
          await waitForPhoneDom(browser, () => expect(reviewStatus(browser, kind)).toContain(refusal));
          expectActions(false, true);
        }
        if (ordering === "two cards in flight") {
          otherResult.resolve(otherSuccess);
          await waitForPhoneDom(browser, () => expect(reviewStatus(browser, other.kind, otherIndex)).toBe("Decision submitted."));
          expect(phoneAction(browser, other.kind, "approve", otherIndex).disabled).toBe(true);
          expect(reviewStatus(browser, kind)).toBe("Submitting decision…");
          expectActions(false, false);
        }
        await refresh();
        if (ordering !== "submit then refresh") {
          expect(reviewStatus(browser, kind)).toBe("");
          expectActions(true, true);
          if (ordering === "editor opened on the new revision before the response") {
            const card = browser.window.document.querySelector<HTMLDetailsElement>(`[data-work-kind="${kind}"]`);
            card?.querySelector("summary")?.click();
            expect(card?.open).toBe(true);
            if (kind === "plan" || kind === "stage") phoneAction(browser, kind, "request_changes").click();
            if (kind === "schedule-attachment") phoneAction(browser, kind, "reopen").click();

            result.resolve({ ok: false, error });
            await waitForPhoneDom(browser, () => expect(recentPhoneResults(browser)?.textContent).toContain(refusal));
            const currentCard = browser.window.document.querySelector<HTMLDetailsElement>(`[data-work-kind="${kind}"]`);
            expect(currentCard?.open).toBe(true);
            if (kind === "plan" || kind === "stage") {
              const note = currentCard?.querySelector("textarea");
              expect(note?.parentElement?.hidden).toBe(false);
              expect(note?.disabled).toBe(false);
              expect(note?.value).toBe("");
            }
            expect(reviewStatus(browser, kind)).toBe("");
            expectActions(true, true);
            expect(received).toHaveLength(1);
            return;
          }
          if (ordering === "revision changes between submit and response") {
            const successes = {
              plan: { ok: true, kind: "plan", status: "approved" },
              stage: { ok: true, kind: "stage", status: "approved" },
              join: { ok: true, kind: "join" },
              "template-confirmation": { ok: true, kind: "template-confirmation", pin },
              "create-and-run": { ok: true, kind: "create-and-run", itemId: 1, runId },
              "schedule-attachment": { ok: true, kind: "schedule-attachment", attachmentId: "attachment", scheduleId: "routine-one" },
              "requested-output": { ok: true, kind: "requested-output" },
            } satisfies Record<TailnetWorkReview["kind"], TailnetWorkDecisionResponse>;
            const snapshotRequests = () => requests.filter(request => request.path.endsWith("/snapshot")).length;
            const before = snapshotRequests();
            const refreshed = nextPhoneSnapshot(browser);
            result.resolve(successes[kind]);
            await refreshed;
            expect(snapshotRequests()).toBeGreaterThan(before);
            expect(recentPhoneResults(browser)?.textContent).toContain("reviewHandle" in original
              ? "The gate was approved. Requested outputs may still need approval." : "Decision submitted.");
            expect(reviewStatus(browser, kind)).toBe("");
            expectActions(true, true);
            return;
          }
          result.resolve({ ok: false, error });
        }
        const recent = recentPhoneResults(browser);
        await waitForPhoneDom(browser, () => expect(recent?.textContent).toContain(refusal));
        expect(reviewStatus(browser, kind)).toBe("");
        expectActions(true, true);
        if (ordering === "two cards in flight") {
          expect(reviewStatus(browser, other.kind, otherIndex)).toBe("Decision submitted.");
          expect(phoneAction(browser, other.kind, "reject", otherIndex).disabled).toBe(true);
        }
        expect(recent?.querySelectorAll("button")).toHaveLength(1);
        recent?.querySelector("button")?.click();
        expect(recent?.textContent).toBe("");
        expectActions(true, true);
        expect(received).toHaveLength(ordering === "two cards in flight" ? 2 : 1);
      } finally {
        result.resolve({ ok: false, error });
        otherResult.resolve(otherSuccess);
        browser.window.close();
      }
    });
  });

  it.each(["changed text", "identical text"])("starts a fresh plan revision with %s after sending a change note", async text => {
    const plan = views[0];
    const planHash = text === "changed text" ? refreshedPlanHash : plan.binding.input.planHash;
    const revised = { ...plan, binding: { ...plan.binding, input: { runId, planHash } }, review: {
      ...plan.review, title: "Revised plan", revision: 1, planNumber: 2, planHash,
      plan: text === "changed text" ? "A revised plan" : plan.review.plan,
    } };
    const reviews: TailnetWorkReview[] = [plan];
    const posted = deferred<TailnetWorkDecisionResponse>();
    const { browser, received, waitForDecisions, requests } = await openPhoneReviews(reviews, () => posted.promise);
    const changes = () => phoneAction(browser, "plan", "request_changes");
    const note = () => browser.window.document.querySelector<HTMLTextAreaElement>('[data-work-kind="plan"] textarea');
    try {
      changes().click();
      const editor = note();
      if (!editor) throw new Error("Missing change note");
      editor.value = "Remove the deployment step";
      editor.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      changes().click();
      await waitForDecisions(1);
      expect(received[0]).toMatchObject({ kind: "plan", input: { note: "Remove the deployment step" } });
      reviews[0] = revised;
      posted.resolve({ ok: true, kind: "plan", status: "changes_requested" });
      await waitForPhoneDom(browser, () => expect(browser.window.document.querySelector('[data-work-kind="plan"] summary')?.textContent).toContain("Revised plan"));
      expect(phoneAction(browser, "plan", "approve").disabled).toBe(false);
      expect(phoneAction(browser, "plan", "reject").disabled).toBe(false);
      expect(changes().disabled).toBe(false);
      const posts = () => requests.filter(request => request.path === TAILNET_WORK_DECISION_PATH);
      changes().click();
      changes().click();
      expect(posts()).toHaveLength(1);
      expect(note()?.value).toBe("");
      expect(note()?.parentElement?.hidden).toBe(false);
      expect(reviewStatus(browser, "plan")).toBe("");
    } finally {
      posted.resolve({ ok: true, kind: "plan", status: "changes_requested" });
      browser.window.close();
    }
  });

  it("starts a fresh form when a submitted Create and run review advances to a new version", async () => {
    const run = views[4];
    const reviews: TailnetWorkReview[] = [run];
    const result = deferred<TailnetWorkDecisionResponse>();
    const success = { ok: true, kind: "create-and-run", itemId: 1, runId } as const;
    const { browser, received, waitForDecisions } = await openPhoneReviews(reviews, () => result.promise);
    const form = () => browser.window.document.querySelector('[data-work-kind="create-and-run"]');
    try {
      const title = form()?.querySelector<HTMLInputElement>('input[type="text"]');
      const detail = form()?.querySelector<HTMLTextAreaElement>("textarea");
      if (!title || !detail) throw new Error("Missing Create and run fields");
      title.value = "Submitted title";
      detail.value = "Submitted detail";
      for (const field of [title, detail]) field.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      phoneAction(browser, "create-and-run", "approve").click();
      await waitForDecisions(1);
      expect(received[0]).toMatchObject({ input: { title: "Submitted title", detail: "Submitted detail" } });
      reviews[0] = { ...run, binding: { input: { ...run.binding.input, version: pin.version + 1 } }, review: { ...run.review, name: "New run" } };
      result.resolve(success);
      await waitForPhoneDom(browser, () => expect(form()?.querySelector("summary")?.textContent).toContain("New run"));
      expect(form()?.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(run.binding.input.title);
      expect(form()?.querySelector("textarea")?.value).toBe(run.binding.input.detail);
      expect(phoneAction(browser, "create-and-run", "approve").disabled).toBe(false);
    } finally {
      result.resolve(success);
      browser.window.close();
    }
  });

  it.each(["dismiss", "next owner action"])("shows a departed plan's refusal until %s", async clearBy => {
    const reviews: TailnetWorkReview[] = [views[0], views[2]];
    const result = deferred<TailnetWorkDecisionResponse>();
    const { browser } = await openPhoneReviews(reviews, decision => decision.kind === "plan" ? result.promise : { ok: true, kind: "join" });
    try {
      phoneAction(browser, "plan", "approve").click();
      reviews.shift();
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "plan")).toBeUndefined());
      result.resolve({ ok: false, error: "not_pending" });
      await waitForPhoneDom(browser, () => expect(recentPhoneResults(browser)?.textContent ?? "").toContain("Decision refused (not_pending)."));
      const recent = recentPhoneResults(browser);
      expect(recent?.parentElement?.querySelector("h3")?.textContent).toBe("Recent results");
      expect(recent?.textContent).toContain("Plan approval");
      expect(recent?.textContent).toContain(views[0].review.title);
      if (clearBy === "dismiss") recent?.querySelector("button")?.click();
      else phoneAction(browser, "join", "approve").click();
      expect(recent?.textContent).toBe("");
    } finally {
      result.resolve({ ok: false, error: "not_pending" });
      browser.window.close();
    }
  });

  it.each([
    ["en", "Plan approval", "Approve", "Reject", "Revision 2", "Revision 3", "Decision refused (plan_mismatch).", "Decision submitted."],
    ["ko", "계획 승인", "승인", "거절", "리비전 2", "리비전 3", "결정이 거부되었습니다(plan_mismatch).", "결정을 제출했습니다."],
  ])("lists both plan decisions in submission order in %s", async (locale, kind, approve, reject, firstRevision, secondRevision, refusal, success) => {
    const title = 'Quarterly report <img src="review-title">';
    const first = { ...views[0], review: { ...views[0].review, title, revision: 2, planNumber: 3 } };
    const second = {
      ...first, binding: { ...first.binding, input: { runId, planHash: refreshedPlanHash } },
      review: { ...first.review, plan: "Revised plan", planHash: refreshedPlanHash, revision: 3, planNumber: 4 },
    };
    const reviews: TailnetWorkReview[] = [first];
    const approval = deferred<TailnetWorkDecisionResponse>();
    const rejection = deferred<TailnetWorkDecisionResponse>();
    const { browser, received, waitForDecisions } = await openPhoneReviews(reviews, decision => {
      if (decision.kind !== "plan") throw new Error("Expected plan decision");
      return decision.input.decision === "approve" ? approval.promise : rejection.promise;
    }, locale);
    const descriptions = () => Array.from(recentPhoneResults(browser)?.querySelectorAll("p") ?? []);
    try {
      phoneAction(browser, "plan", "approve").click();
      await waitForDecisions(1);
      reviews[0] = second;
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(phoneAction(browser, "plan", "reject").disabled).toBe(false));
      phoneAction(browser, "plan", "reject").click();
      await waitForDecisions(2);
      expect(received.map(decision => decision.input)).toEqual([
        { runId, planHash: first.review.planHash, decision: "approve" },
        { runId, planHash: refreshedPlanHash, decision: "reject" },
      ]);
      reviews.length = 0;
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "plan")).toBeUndefined());

      rejection.resolve({ ok: true, kind: "plan", status: "rejected" });
      await waitForPhoneDom(browser, () => expect(descriptions()).toHaveLength(1));
      approval.resolve({ ok: false, error: "plan_mismatch" });
      await waitForPhoneDom(browser, () => expect(descriptions()).toHaveLength(2));
      expect(descriptions().map(entry => entry.textContent)).toEqual([
        [kind, title, approve, firstRevision, refusal].join(" · "),
        [kind, title, reject, secondRevision, success].join(" · "),
      ]);
      for (const entry of descriptions()) {
        expect(Array.from(entry.childNodes, child => child.nodeType)).toEqual([browser.window.Node.TEXT_NODE]);
      }
    } finally {
      approval.resolve({ ok: false, error: "plan_mismatch" });
      rejection.resolve({ ok: true, kind: "plan", status: "rejected" });
      browser.window.close();
    }
  });

  it("shows a settled stage rejection on the matching output that appeared during submission", async () => {
    const reviews: TailnetWorkReview[] = [views[1]];
    const result = deferred<TailnetWorkDecisionResponse>();
    const unrelated = { ...views[6], binding: { input: { ...views[6].binding.input, itemId: 9 } } };
    const { browser, waitForDecisions } = await openPhoneReviews(reviews, () => result.promise);
    try {
      phoneAction(browser, "stage", "reject").click();
      await waitForDecisions(1);
      reviews.push(views[6], unrelated);
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "requested-output", 1)).toBe(""));
      expect(phoneAction(browser, "requested-output", "approve", 1).disabled).toBe(false);
      expect(phoneAction(browser, "requested-output", "reject", 1).disabled).toBe(false);
      expect(phoneAction(browser, "requested-output", "approve").disabled).toBe(true);
      const pendingStatus = reviewStatus(browser, "requested-output");
      result.resolve({ ok: true, kind: "stage", status: "rejected" });
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "requested-output")).toBe("Decision submitted."));
      expect(pendingStatus).toBe("Submitting decision…");
      expect(phoneAction(browser, "requested-output", "approve").disabled).toBe(true);
      expect(phoneAction(browser, "requested-output", "reject").disabled).toBe(true);
      expect(phoneAction(browser, "requested-output", "approve", 1).disabled).toBe(false);
    } finally {
      result.resolve({ ok: true, kind: "stage", status: "rejected" });
      browser.window.close();
    }
  });

  it.each(["reject", "request_changes"] as const)("keeps %s available after a same-binding stale plan refusal", async action => {
    const reviews: TailnetWorkReview[] = [views[0]];
    const { browser, received } = await openPhoneReviews(reviews, decision => {
      if (decision.kind !== "plan") throw new Error("Expected plan decision");
      if (decision.input.decision === "approve") return { ok: false, error: "plan_stale" };
      reviews.length = 0;
      return { ok: true, kind: "plan", status: action === "reject" ? "rejected" : "changes_requested" };
    });
    try {
      const doc = browser.window.document;
      phoneAction(browser, "plan", "approve").click();
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "plan")).toContain("The work item changed after this plan was made."));
      expect(phoneAction(browser, "plan", "approve").disabled).toBe(true);
      expect(phoneAction(browser, "plan", "reject").disabled).toBe(false);
      expect(phoneAction(browser, "plan", "request_changes").disabled).toBe(false);
      reviews[0] = { ...views[0], review: { ...views[0].review, stale: true, title: "Stale plan" } };
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(doc.querySelector('[data-work-kind="plan"] summary')?.textContent).toContain("Stale plan"));
      expect(reviewStatus(browser, "plan")).toContain("The work item changed");
      expect(phoneAction(browser, "plan", "approve").disabled).toBe(true);
      expect(phoneAction(browser, "plan", "reject").disabled).toBe(false);
      expect(phoneAction(browser, "plan", "request_changes").disabled).toBe(false);
      const button = phoneAction(browser, "plan", action);
      if (action === "request_changes") {
        button.click();
        const note = doc.querySelector<HTMLTextAreaElement>('[data-work-kind="plan"] textarea');
        if (!note) throw new Error("Missing change note");
        note.value = "Update the plan";
        note.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      }
      button.click();
      expect(reviewStatus(browser, "plan")).toBe("Submitting decision…");
      if (action === "reject") {
        expect(recentPhoneResults(browser)?.querySelector("p")?.textContent).toBe(
          "Plan approval · Review plan · Approve · Revision 0 · The work item changed after this plan was made. Request changes to plan it again.",
        );
      }
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "plan")).toBe("Decision submitted."));
      expect(phoneAction(browser, "plan", "reject").disabled).toBe(true);
      expect(received[1]).toMatchObject({ kind: "plan", input: { ...views[0].binding.input, decision: action } });
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(reviewStatus(browser, "plan")).toBeUndefined());
      expect(recentPhoneResults(browser)?.textContent).toContain("Decision submitted.");
      expect(received).toHaveLength(2);
    } finally {
      browser.window.close();
    }
  });

  it("opens a new existing-routine review after reattaching from one template to another", async () => {
    const first = views[5];
    const secondPin = { ...pin, templateId: "other-template" };
    const second = { ...first, binding: { input: { ...first.binding.input, ...secondPin } }, review: { ...first.review, name: "Other template" } };
    const reviews: TailnetWorkReview[] = [first, second];
    const { browser, received } = await openPhoneReviews(reviews, decision => {
      if (decision.kind !== "schedule-attachment") throw new Error("Expected schedule decision");
      const { templateId, version, graphHash } = decision.input;
      reviews[0] = { ...first, review: { ...first.review, existingPin: { templateId, version, graphHash } } };
      reviews[1] = { ...second, review: { ...second.review, existingPin: { templateId, version, graphHash } } };
      return { ok: true, kind: decision.kind, attachmentId: "attachment", scheduleId: first.binding.input.scheduleId };
    });
    function card(index: number) {
      return browser.window.document.querySelectorAll('[data-work-kind="schedule-attachment"]')[index];
    }
    function action(index: number, name: string) {
      return phoneAction(browser, "schedule-attachment", name, index);
    }
    function activePin() {
      return Array.from(card(0)?.querySelectorAll("h4 + dl dd") ?? [], node => node.textContent);
    }
    try {
      for (const [index, target] of [[0, pin.templateId], [1, secondPin.templateId]] as const) {
        expect(action(index, "approve").disabled).toBe(false);
        action(index, "approve").click();
        await waitForPhoneDom(browser, () => expect(activePin()).toEqual([target, String(pin.version), pin.graphHash]));
        expect(reviewStatus(browser, "schedule-attachment", index)).toBe("Decision submitted.");
        expect(action(index, "approve").disabled).toBe(true);
      }
      expect(action(0, "approve").disabled).toBe(true);
      expect(action(0, "reopen").hidden).toBe(false);
      action(0, "reopen").click();
      expect(card(0)?.querySelector('[role="status"]')?.textContent).toBe("");
      expect(action(0, "approve").disabled).toBe(false);
      action(0, "approve").click();
      await waitForPhoneDom(browser, () => expect(activePin()).toEqual([pin.templateId, String(pin.version), pin.graphHash]));
      expect(received.map(decision => decision.kind === "schedule-attachment" && decision.input.templateId))
        .toEqual([pin.templateId, secondPin.templateId, pin.templateId]);
      expect(received[2]?.id).not.toBe(received[0]?.id);
    } finally {
      browser.window.close();
    }
  });

  it("keeps unsent Create and run edits and resets only a project removed by a snapshot", async () => {
    const defaultProject = { projectRoot: "/projects/default", projectName: "Default project", isDefault: true };
    const selected = { projectRoot: "/projects/selected", projectName: "Selected project", isDefault: false };
    const extra = { projectRoot: "/projects/new", projectName: "New project", isDefault: false };
    const original = { ...views[4], binding: { input: { ...views[4].binding.input, projectRoot: defaultProject.projectRoot } } };
    const reviews: TailnetWorkReview[] = [{ ...original, review: { ...original.review, projects: [defaultProject, selected] } }];
    const { browser, received, waitForDecisions } = await openPhoneReviews(reviews, () => ({ ok: true, kind: "create-and-run", itemId: 5, runId }));
    const doc = browser.window.document;
    function field(tag: string) {
      const control = doc.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-work-kind="create-and-run"] ${tag}`);
      if (!control) throw new Error("Missing Create and run field");
      return control;
    }
    async function refresh(projects: typeof defaultProject[], name: string, version: number) {
      reviews[0] = { ...original, binding: { input: { ...original.binding.input, version } }, review: { ...original.review, projects, name } };
      refreshPhoneReviews(browser);
      await waitForPhoneDom(browser, () => expect(doc.querySelector('[data-work-kind="create-and-run"] summary')?.textContent).toContain(name));
    }
    try {
      for (const [tag, value] of [["input", "Custom title"], ["textarea", "Custom details"], ["select", selected.projectRoot]]) {
        const control = field(tag);
        control.value = value;
        control.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      }
      await refresh([defaultProject, selected, extra], "Expanded projects", pin.version);
      expect([field("input").value, field("textarea").value, field("select").value]).toEqual(["Custom title", "Custom details", selected.projectRoot]);
      expect(phoneAction(browser, "create-and-run", "approve").disabled).toBe(false);
      await refresh([defaultProject, extra], "Reduced projects", pin.version + 1);
      expect([field("input").value, field("textarea").value, field("select").value]).toEqual(["Custom title", "Custom details", defaultProject.projectRoot]);
      expect(field("select").closest(".work-review-card")?.textContent).toContain("The selected project is no longer available.");
      expect(phoneAction(browser, "create-and-run", "approve").disabled).toBe(false);
      phoneAction(browser, "create-and-run", "approve").click();
      await waitForDecisions(1);
      expect(received[0]).toMatchObject({ kind: "create-and-run", input: {
        version: pin.version + 1, title: "Custom title", detail: "Custom details", projectRoot: defaultProject.projectRoot,
      } });
    } finally {
      browser.window.close();
    }
  });

  it.each([
    [0, "approve", { decision: "approve" }], [0, "reject", { decision: "reject" }],
    [1, "approve", { decision: "approve" }], [1, "reject", { decision: "reject" }],
    [2, "approve", { decision: "retry_merge" }], [2, "reject", { decision: "reject" }],
    [3, "approve", {}], [4, "approve", {}], [5, "approve", {}],
    [6, "approve", { decision: "approve" }], [6, "reject", { decision: "reject" }],
  ] as const)("submits review %i action %s once with the exact POST binding", async (index, action, extraInput) => {
    const view = views[index];
    const { browser, session, received, waitForDecisions, requests } = await openPhoneReviews(index === 1 ? [view, views[6]] : [view], decision => {
      switch (decision.kind) {
        case "plan":
        case "stage": return { ok: true, kind: decision.kind, status: action === "reject" ? "rejected" : "approved" };
        case "join":
        case "output-execution-card":
        case "output-retry":
        case "requested-output": return { ok: true, kind: decision.kind };
        case "template-confirmation": return { ok: true, kind: decision.kind, pin };
        case "create-and-run": return { ok: true, kind: decision.kind, itemId: 5, runId };
        case "schedule-attachment": return { ok: true, kind: decision.kind, attachmentId: "attachment", scheduleId: "routine-one" };
      }
    });
    try {
      const button = phoneAction(browser, view.kind, action);
      button.click();
      button.click();
      await waitForDecisions(1);
      const streamRequest = requests.find(request => request.path.includes("/events?"));
      if (!streamRequest) throw new Error("Phone did not subscribe to the scoped stream");
      const snapshotScope = new URL(streamRequest.path, WEB_ORIGIN).searchParams.get("scope");
      expect(received[0]).toEqual({
        id: expect.stringMatching(/^[a-f0-9-]{36}$/), scope: snapshotScope, kind: view.kind,
        ...view.binding, input: { ...view.binding.input, ...extraInput },
        ...(action === "approve" && "reviewHandle" in view ? { reviewHandle: view.reviewHandle } : {}),
      });
      expect(requests.filter(request => request.method === "POST")).toEqual([{
        path: "/tailnet/v2/web/work-decisions", method: "POST", csrf: session.csrfToken, credentials: "same-origin",
      }]);
      const expected = action === "approve" && "reviewHandle" in view ? "The gate was approved. Requested outputs may still need approval." : "Decision submitted.";
      await waitForPhoneDom(browser, () => expect(button.closest(".work-review-card")?.querySelector('[role="status"]')?.textContent).toBe(expected));
      expect(button.disabled).toBe(true);
      if (index === 1) expect(phoneAction(browser, "requested-output", "approve").disabled).toBe(true);
    } finally {
      browser.window.close();
    }
  });

  it("builds a new schedule from a reviewed template pin and scope without a schedule ID", async () => {
    const { browser, received, waitForDecisions } = await openPhoneReviews([views[4]], () => ({
      ok: true, kind: "schedule-attachment", attachmentId: "attachment", scheduleId: "new-schedule",
    }));
    try {
      const date = browser.window.document.querySelector<HTMLInputElement>('input[type="datetime-local"]');
      if (!date) throw new Error("Phone schedule field is missing");
      date.value = "2099-01-01T09:00";
      date.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      phoneAction(browser, "schedule-attachment", "approve").click();
      await waitForDecisions(1);
      expect(received[0]).toMatchObject({
        kind: "schedule-attachment",
        input: { ...pin, expectedScope: templateScope, schedule: { at: new Date(date.value).toISOString(), repeat: { kind: "none" } } },
      });
      expect(received[0]?.input).not.toHaveProperty("scheduleId");
    } finally {
      browser.window.close();
    }
  });

  it.each(["create-and-run", "schedule-attachment"] as const)("opens a fresh %s decision after completion and snapshot refresh", async kind => {
    const { browser, received, waitForDecisions, requests } = await openPhoneReviews([views[4]], decision => decision.kind === "create-and-run"
      ? { ok: true, kind: decision.kind, itemId: 5, runId }
      : { ok: true, kind: "schedule-attachment", attachmentId: "attachment", scheduleId: "new-schedule" });
    try {
      const document = browser.window.document;
      const initial = kind === "create-and-run" ? views[4].binding.input.title : "";
      const first = kind === "create-and-run" ? "First report" : "2099-01-01T09:00";
      const second = kind === "create-and-run" ? "Second report" : "2099-01-02T10:00";
      function fill(value: string) {
        const field = document.querySelector<HTMLInputElement>(`[data-work-kind="${kind}"] input`);
        if (!field) throw new Error("Phone review field is missing");
        field.value = value;
        field.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      }
      fill(first);
      const approve = phoneAction(browser, kind, "approve");
      const refreshed = nextPhoneSnapshot(browser);
      approve.click();
      approve.click();
      await refreshed;
      expect(requests.filter(request => request.path.endsWith("/snapshot"))).toHaveLength(2);
      expect(approve.disabled).toBe(true);
      expect(received).toHaveLength(1);
      phoneAction(browser, kind, "reopen").click();
      expect(document.querySelector(`[data-work-kind="${kind}"] input`)).toHaveProperty("value", initial);
      expect(reviewStatus(browser, kind)).toBe("");
      const description = kind === "create-and-run"
        ? "Create and run · First report · Create and run · Revision 2 · Decision submitted."
        : "Attach a new schedule · Workflow run · Approve and attach · Revision 2 · Decision submitted.";
      expect(recentPhoneResults(browser)?.querySelector("p")?.textContent).toBe(description);
      approve.click();
      fill(second);
      phoneAction(browser, kind, "approve").click();
      await waitForDecisions(2);
      const values = received.map(decision => decision.kind === "create-and-run" ? decision.input.title
        : decision.kind === "schedule-attachment" && "schedule" in decision.input ? decision.input.schedule.at : undefined);
      expect(values).toEqual(kind === "create-and-run" ? [first, second] : [first, second].map(value => new Date(value).toISOString()));
      expect(received[0]?.id).not.toBe(received[1]?.id);
    } finally {
      browser.window.close();
    }
  });

  it("keeps each card's named refusal when concurrent decisions settle out of order", async () => {
    const stale = deferred<TailnetWorkDecisionResponse>();
    const replay = deferred<TailnetWorkDecisionResponse>();
    const success = deferred<TailnetWorkDecisionResponse>();
    const currentReviews: TailnetWorkReview[] = [views[0], views[2], views[6]];
    const { browser, waitForDecisions, requests } = await openPhoneReviews(currentReviews, decision => {
      if (decision.kind === "plan") return stale.promise;
      if (decision.kind === "join") return replay.promise;
      return success.promise;
    });
    try {
      for (const kind of ["plan", "join", "requested-output"] as const) phoneAction(browser, kind, "approve").click();
      await waitForDecisions(3);
      const document = browser.window.document;
      const status = (kind: string) => document.querySelector(`[data-work-kind="${kind}"] [role="status"]`)?.textContent;
      const staleMessage = "The work item changed after this plan was made. Request changes to plan it again.";
      stale.resolve({ ok: false, error: "plan_stale" });
      await waitForPhoneDom(browser, () => expect(status("plan")).toBe(staleMessage));
      replay.resolve({ ok: false, error: "work-decision-replayed" });
      await waitForPhoneDom(browser, () => expect(status("join")).toBe("This work decision was already submitted."));
      currentReviews[0] = { ...views[0], review: { ...views[0].review, title: "Updated plan review" } };
      success.resolve({ ok: true, kind: "requested-output" });
      await waitForPhoneDom(browser, () => expect(document.querySelector('[data-work-kind="plan"] summary')?.textContent).toContain("Updated plan review"));
      expect(status("plan")).toBe(staleMessage);
      expect(status("join")).toBe("This work decision was already submitted.");
      expect(status("requested-output")).toBe("The gate was approved. Requested outputs may still need approval.");
      expect(document.getElementById("work-review-feedback")?.textContent).toBe("");
      expect(requests.filter(request => request.method === "POST")).toHaveLength(3);
    } finally {
      stale.resolve({ ok: false, error: "plan_stale" });
      replay.resolve({ ok: false, error: "work-decision-replayed" });
      success.resolve({ ok: true, kind: "requested-output" });
      browser.window.close();
    }
  });

  it.each([3, 4, 5] as const)("dismisses review %i locally", async index => {
    const view = views[index];
    const { browser, requests } = await openPhoneReviews([view], () => ({ ok: true, kind: "join" }));
    try {
      const document = browser.window.document;
      document.querySelector<HTMLElement>(`[data-work-kind="${view.kind}"] summary`)?.click();
      phoneAction(browser, view.kind, "dismiss").click();
      const refreshed = nextPhoneSnapshot(browser);
      refreshPhoneReviews(browser);
      await refreshed;
      expect(requests.filter(request => request.path.endsWith("/snapshot"))).toHaveLength(2);
      const card = document.querySelector<HTMLDetailsElement>(`[data-work-kind="${view.kind}"]`);
      expect(card?.open).toBe(false);
      card?.querySelector("summary")?.click();
      expect(card?.open).toBe(true);
      expect(phoneAction(browser, view.kind, "approve").disabled).toBe(false);
      expect(requests.filter(request => request.method === "POST")).toHaveLength(0);
    } finally {
      browser.window.close();
    }
  });

  it.each([
    ["plan_stale", "The work item changed after this plan was made."],
    ["remote-controller-authority-revoked", "Remote control expired or was revoked."],
    ["work-decision-replayed", "This work decision was already submitted."],
  ])("shows %s without repeating a submitted decision", async (error, message) => {
    const { browser, requests } = await openPhoneReviews([views[0]], () => ({ ok: false, error }));
    try {
      const button = phoneAction(browser, "plan", "approve");
      button.click();
      const feedback = error === "remote-controller-authority-revoked"
        ? browser.window.document.getElementById("work-review-feedback")
        : button.closest(".work-review-card")?.querySelector('[role="status"]');
      await waitForPhoneDom(browser, () => expect(feedback?.textContent).toContain(message));
      button.click();
      expect(button.disabled).toBe(true);
      expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    } finally {
      browser.window.close();
    }
  });
});
