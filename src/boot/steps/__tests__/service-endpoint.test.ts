/** Staging may allow loopback moves and must keep its accepted-move record separate from production. */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetrySettings } from "../../../data/settings-store.js";
import { AVE_SERVICE_BASE_URL } from "../../../marketplace/service/client.js";
import { consentedTelemetryEndpoint, createServiceClient } from "../service-endpoint.js";

vi.mock("../../../lib/admin-policy-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-policy-file.js")>()),
  readAdminPolicyFile: (path: string) => import("node:fs/promises").then(({ readFile }) => readFile(path)),
}));

vi.mock("../../../permissions/policy-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/policy-store.js")>()),
  getAdminPolicyPath: () => join(process.env.AVE_HOME!, "policy.json"),
}));

const STAGING = "http://127.0.0.1:8791";
const MOVED = "https://ave-staging.example";

const doc = (fields: Record<string, unknown> = {}) => ({ schemaVersion: 1, announcements: null, telemetry: null, movedTo: null, movedFrom: null, ...fields });

function fetchOver(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const route = routes[String(input)];
    return route === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(route), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("createServiceClient", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-service-home-"));
    writeFileSync(join(home, "policy.json"), "{}");
    previousHome = process.env.AVE_HOME;
    process.env.AVE_HOME = home;
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("reads a loopback staging base and records its move in its own file", async () => {
    const service = createServiceClient(
      fetchOver({
        [`${STAGING}/.well-known/ave-service.json`]: doc({ movedTo: MOVED }),
        [`${MOVED}/.well-known/ave-service.json`]: doc({ movedFrom: STAGING }),
      }),
      STAGING,
    );
    await expect(service.refresh()).resolves.toMatchObject({ base: MOVED, source: "moved" });
    expect(existsSync(join(home, "marketplaces", "service.staging.json"))).toBe(true);
    expect(existsSync(join(home, "marketplaces", "service.json"))).toBe(false);
  });

  it("uses the build constant without an override, where loopback http is not a base", async () => {
    const service = createServiceClient(fetchOver({ [`${AVE_SERVICE_BASE_URL}/.well-known/ave-service.json`]: doc({ movedTo: STAGING }) }), undefined);
    await expect(service.refresh()).rejects.toThrow(/https/u);
  });
});

describe("consentedTelemetryEndpoint", () => {
  const service = () => ({ ensureResolved: vi.fn(), telemetryEndpoint: vi.fn(() => "https://ave.agent-connector.ai/telemetry/events") });

  it("never touches the service without consent", () => {
    for (const settings of [{ enabled: false }, { enabled: true, telemetryPromptAnswered: false }, { enabled: false, telemetryPromptAnswered: true }] as TelemetrySettings[]) {
      const client = service();
      const endpoint = consentedTelemetryEndpoint(() => settings, client);
      expect(endpoint()).toBeNull();
      expect(client.ensureResolved).not.toHaveBeenCalled();
      expect(client.telemetryEndpoint).not.toHaveBeenCalled();
    }
  });

  it("reads the document at once for a user who already opted in, and on each ask after", () => {
    const client = service();
    const endpoint = consentedTelemetryEndpoint(() => ({ enabled: true, telemetryPromptAnswered: true }), client);
    expect(client.ensureResolved).toHaveBeenCalledTimes(1);
    expect(endpoint()).toBe("https://ave.agent-connector.ai/telemetry/events");
    expect(client.ensureResolved).toHaveBeenCalledTimes(2);
  });

  it("starts reading once the user opts in during the session", () => {
    const client = service();
    const settings: TelemetrySettings = { enabled: false, telemetryPromptAnswered: false };
    const endpoint = consentedTelemetryEndpoint(() => settings, client);
    expect(client.ensureResolved).not.toHaveBeenCalled();
    settings.enabled = true;
    settings.telemetryPromptAnswered = true;
    expect(endpoint()).toBe("https://ave.agent-connector.ai/telemetry/events");
    expect(client.ensureResolved).toHaveBeenCalledTimes(1);
  });
});
