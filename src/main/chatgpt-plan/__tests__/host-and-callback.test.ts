import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, (response) => {
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
    const listener = await startChatGptPlanCallbackListener(0);
    try {
      const redirect = new URL(listener.redirectUri);
      expect(redirect.hostname).toBe("127.0.0.1");
      expect(redirect.pathname).toBe("/auth/callback");
      expect((await get(`http://127.0.0.1:${redirect.port}/callback?code=x`)).status).toBe(404);
      const answered = await get(`${listener.redirectUri}?code=c1&state=s1`);
      expect(answered.status).toBe(200);
      expect((await listener.callback).searchParams.get("code")).toBe("c1");
      expect((await get(`${listener.redirectUri}?code=c2&state=s1`)).status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it("takes another port when the preferred one is busy", async () => {
    const busy = await startChatGptPlanCallbackListener(0);
    const port = Number(new URL(busy.redirectUri).port);
    const second = await startChatGptPlanCallbackListener(port);
    try {
      expect(Number(new URL(second.redirectUri).port)).not.toBe(port);
    } finally {
      busy.close();
      second.close();
      await busy.callback.catch(() => undefined);
      await second.callback.catch(() => undefined);
    }
  });
});
