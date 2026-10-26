import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFeatureNamespace } from "../../storage/feature-namespace.js";
import { isChatGptPlanHostId, loadOrCreateChatGptPlanHostId } from "../host-id.js";
import { startChatGptPlanCallbackListener } from "../loopback.js";

const roots: string[] = [];
const previousHome = process.env.AVE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "ave-chatgpt-plan-"));
  roots.push(root);
  process.env.AVE_HOME = root;
  return root;
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject).end();
  });
}

describe("plan-usage host id", () => {
  it("creates one opaque UUIDv4 URN under AVE_HOME and reuses it", async () => {
    const home = isolatedHome();
    const namespace = openFeatureNamespace("chatgpt-plan");
    const first = await loadOrCreateChatGptPlanHostId(namespace);
    expect(isChatGptPlanHostId(first)).toBe(true);
    expect(first.startsWith("urn:uuid:")).toBe(true);
    await expect(loadOrCreateChatGptPlanHostId(namespace)).resolves.toBe(first);
    expect(namespace.dir.startsWith(home)).toBe(true);
  });

  it("fails clearly instead of minting a new id over a malformed one", async () => {
    const home = isolatedHome();
    mkdirSync(join(home, "chatgpt-plan"), { recursive: true });
    writeFileSync(join(home, "chatgpt-plan", "host.json"), JSON.stringify({ extAgentHostId: "user@example.com" }));
    await expect(loadOrCreateChatGptPlanHostId(openFeatureNamespace("chatgpt-plan"))).rejects.toThrow(/host id/);
  });
});

describe("plan-usage loopback callback", () => {
  it("listens on 127.0.0.1 at /auth/callback and answers only that path, once", async () => {
    const listener = await startChatGptPlanCallbackListener("s1", 0);
    try {
      const redirect = new URL(listener.redirectUri);
      expect(redirect.hostname).toBe("127.0.0.1");
      expect(redirect.pathname).toBe("/auth/callback");
      expect((await get(`http://127.0.0.1:${redirect.port}/callback?code=x&state=s1`)).status).toBe(404);
      const answered = await get(`${listener.redirectUri}?code=c1&state=s1`);
      expect(answered.status).toBe(200);
      expect((await listener.callback).searchParams.get("code")).toBe("c1");
      expect((await get(`${listener.redirectUri}?code=c2&state=s1`)).status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it("ignores a callback with another state or host and keeps waiting for the real one", async () => {
    const listener = await startChatGptPlanCallbackListener("s1", 0);
    const port = new URL(listener.redirectUri).port;
    let settled = false;
    void listener.callback.then(() => { settled = true; }, () => { settled = true; });
    try {
      // A web page that guesses the port cannot end the attempt: no state, a wrong state, or an error without state.
      expect((await get(`${listener.redirectUri}?error=access_denied`)).status).toBe(404);
      expect((await get(`${listener.redirectUri}?code=evil&state=s2`)).status).toBe(404);
      // A rebinding host name reaches the same socket but names another host.
      expect((await get(`${listener.redirectUri}?code=evil&state=s1`, { host: `attacker.example:${port}` })).status).toBe(404);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect((await get(`${listener.redirectUri}?code=c1&state=s1`)).status).toBe(200);
      expect((await listener.callback).searchParams.get("code")).toBe("c1");
    } finally {
      listener.close();
    }
  });

  it("takes another port when the preferred one is busy", async () => {
    const busy = await startChatGptPlanCallbackListener("s1", 0);
    const port = Number(new URL(busy.redirectUri).port);
    const second = await startChatGptPlanCallbackListener("s1", port);
    try {
      expect(Number(new URL(second.redirectUri).port)).not.toBe(port);
    } finally {
      busy.close();
      second.close();
      await busy.callback.catch(() => undefined);
      await second.callback.catch(() => undefined);
    }
  });

  // The first fallback assignment reports a Fetch-blocked port; the browser could never reach it, so it must not reach the redirect URI.
  async function expectBlockedFirstPortRetried(start: () => ReturnType<typeof startChatGptPlanCallbackListener>): Promise<void> {
    const address = vi.spyOn(Server.prototype, "address")
      .mockReturnValueOnce({ address: "127.0.0.1", family: "IPv4", port: 6000 });
    const close = vi.spyOn(Server.prototype, "close");
    let listener: Awaited<ReturnType<typeof startChatGptPlanCallbackListener>> | undefined;
    try {
      listener = await start();
      expect(close).toHaveBeenCalledTimes(1);
      address.mockRestore();
      expect(Number(new URL(listener.redirectUri).port)).not.toBe(6000);
      expect((await get(`${listener.redirectUri}?code=c1&state=s1`)).status).toBe(200);
      expect((await listener.callback).searchParams.get("code")).toBe("c1");
    } finally {
      address.mockRestore();
      close.mockRestore();
      listener?.close();
    }
  }

  it("retries a Fetch-blocked fallback port when the preferred one is busy", async () => {
    const busy = await startChatGptPlanCallbackListener("s1", 0);
    const port = Number(new URL(busy.redirectUri).port);
    try {
      await expectBlockedFirstPortRetried(() => startChatGptPlanCallbackListener("s1", port));
    } finally {
      busy.close();
      await busy.callback.catch(() => undefined);
    }
  });

  it("retries a Fetch-blocked port when no preferred port is requested", async () => {
    await expectBlockedFirstPortRetried(() => startChatGptPlanCallbackListener("s1", 0));
  });
});
