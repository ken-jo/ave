/**
 * The service endpoint (design §11): base resolution, the one-move rule, the
 * document's same-origin paths, the policy override, and announcements.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVE_SERVICE_BASE_URL,
  ServiceClient,
  normalizeServiceBase,
  parseServiceDocument,
  readPolicyServiceBase,
  type ServiceClientOptions,
} from "../client.js";

const OLD = "https://former-site.invalid";
const NEW = "https://ave.example";

const doc = (fields: Record<string, unknown> = {}) => ({ schemaVersion: 1, announcements: "/announcements/v1.json", telemetry: null, movedTo: null, movedFrom: null, ...fields });

const announcement = (id: number) => ({
  id,
  title: `Notice ${id}`,
  body: "Body",
  level: "info",
  createdAt: "2026-09-23T00:00:00.000Z",
  actions: [{ label: { en: "Open", ko: "열기" }, target: { kind: "url", url: "https://former-site.invalid/news" } }],
});

/** A fetch over a URL → JSON map; a missing URL answers 404, a number answers that status. */
function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "number") return new Response("", { status: route, headers: { location: "https://evil.example/" } });
    return new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("normalizeServiceBase", () => {
  it("accepts an https origin and refuses paths, plain http and credentials", () => {
    expect(normalizeServiceBase("https://former-site.invalid/")).toBe("https://former-site.invalid");
    expect(() => normalizeServiceBase("https://former-site.invalid/base")).toThrow(/origin/u);
    expect(() => normalizeServiceBase("http://former-site.invalid")).toThrow(/https/u);
    expect(() => normalizeServiceBase("https://user:pw@former-site.invalid")).toThrow(/origin/u);
    expect(() => normalizeServiceBase("http://127.0.0.1:8123")).toThrow(/https/u);
    expect(normalizeServiceBase("http://127.0.0.1:8123", { allowLoopbackHttp: true })).toBe("http://127.0.0.1:8123");
    expect(() => normalizeServiceBase("http://10.0.0.1", { allowLoopbackHttp: true })).toThrow(/https/u);
  });
});

describe("parseServiceDocument", () => {
  it("resolves same-origin paths and ignores unknown keys", () => {
    expect(parseServiceDocument({ ...doc({ telemetry: "/telemetry/events" }), later: true }, OLD)).toEqual({
      announcements: `${OLD}/announcements/v1.json`,
      telemetry: `${OLD}/telemetry/events`,
      movedTo: null,
      movedFrom: null,
    });
  });

  it.each([
    ["a protocol-relative path", doc({ announcements: "//evil.example/a.json" })],
    ["an absolute URL", doc({ telemetry: "https://evil.example/t" })],
    ["a backslash", doc({ announcements: "/\\evil.example" })],
    ["another schema version", { ...doc(), schemaVersion: 2 }],
    ["a plain-http move", doc({ movedTo: "http://ave.example" })],
    ["a move with a path", doc({ movedTo: "https://ave.example/x" })],
  ])("refuses %s", (_label, value) => {
    expect(() => parseServiceDocument(value, OLD)).toThrow();
  });
});

describe("readPolicyServiceBase", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-service-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const policy = (value: unknown) => {
    const path = join(dir, "policy.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  it("reads service.baseUrl, and null without the file or the section", async () => {
    await expect(readPolicyServiceBase(join(dir, "none.json"))).resolves.toBeNull();
    await expect(readPolicyServiceBase(policy({ managed: true }))).resolves.toBeNull();
    await expect(readPolicyServiceBase(policy({ service: { baseUrl: "https://ave.corp.example/" } }))).resolves.toBe("https://ave.corp.example");
  });

  it.each([
    ["an unknown key", { service: { baseUrl: "https://ave.corp.example", mirror: "x" } }],
    ["plain http", { service: { baseUrl: "http://ave.corp.example" } }],
    ["a missing baseUrl", { service: {} }],
    ["invalid JSON", "{"],
  ])("throws on %s, so a typo does not fall back to the public base", async (_label, value) => {
    await expect(readPolicyServiceBase(policy(value))).rejects.toThrow();
  });
});

describe("ServiceClient", () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-service-"));
    statePath = join(dir, "marketplaces", "service.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const client = (routes: Record<string, unknown>, options: Partial<ServiceClientOptions> = {}) => {
    const fetchImpl = fakeFetch(routes);
    const service = new ServiceClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      buildBase: OLD,
      policyBase: async () => null,
      statePath,
      appVersion: "0.10.0",
      now: () => new Date("2026-09-23T00:00:00.000Z"),
      ...options,
    });
    return { service, fetchImpl };
  };

  it("uses the build constant by default", () => {
    expect(AVE_SERVICE_BASE_URL).toBe("https://former-site.invalid");
  });

  it("reads announcements and the telemetry endpoint from the build base", async () => {
    const { service } = client({
      [`${OLD}/.well-known/former-service.json`]: doc({ telemetry: "/telemetry/events" }),
      [`${OLD}/announcements/v1.json`]: { announcements: [announcement(1), { id: "x" }] },
    });
    expect(service.telemetryEndpoint()).toBeUndefined();
    const announcements = await service.announcements();
    expect(announcements.map((item) => item.id)).toEqual([1]);
    expect(announcements[0]!.actions[0]!.label.en).toBe("Open");
    expect(service.telemetryEndpoint()).toBe(`${OLD}/telemetry/events`);
  });

  it("follows a move the new base confirms, records it, and reads the new base from then on", async () => {
    const routes = {
      [`${OLD}/.well-known/former-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/former-service.json`]: doc({ movedFrom: OLD }),
      [`${NEW}/announcements/v1.json`]: [announcement(2)],
    };
    const first = client(routes);
    await expect(first.service.refresh()).resolves.toMatchObject({ base: NEW, source: "moved" });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ version: 1, buildBase: OLD, movedTo: NEW, acceptedAt: "2026-09-23T00:00:00.000Z" });

    const second = client(routes);
    expect((await second.service.announcements()).map((item) => item.id)).toEqual([2]);
    expect(second.fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(`${OLD}/.well-known/former-service.json`);
  });

  it("stays when the new base does not name the old one in movedFrom", async () => {
    const { service } = client({
      [`${OLD}/.well-known/former-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/former-service.json`]: doc({ movedFrom: "https://other.example" }),
    });
    await expect(service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("follows at most one move per build constant", async () => {
    const third = "https://third.example";
    const routes = {
      [`${OLD}/.well-known/former-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/former-service.json`]: doc({ movedFrom: OLD, movedTo: third }),
      [`${third}/.well-known/former-service.json`]: doc({ movedFrom: NEW }),
    };
    await expect(client(routes).service.refresh()).resolves.toMatchObject({ base: NEW });
    await expect(client(routes).service.refresh()).resolves.toMatchObject({ base: NEW, source: "moved" });
  });

  it("drops a move made under another build constant", async () => {
    await client({
      [`${OLD}/.well-known/former-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/former-service.json`]: doc({ movedFrom: OLD }),
    }).service.refresh();
    const shipped = "https://ave-next.example";
    const { service } = client({ [`${shipped}/.well-known/former-service.json`]: doc() }, { buildBase: shipped });
    await expect(service.refresh()).resolves.toMatchObject({ base: shipped, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("drops a move record it cannot read", async () => {
    mkdirSync(join(dir, "marketplaces"), { recursive: true });
    writeFileSync(statePath, "{ not json");
    await expect(client({ [`${OLD}/.well-known/former-service.json`]: doc() }).service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("prefers the policy base and never follows a move from it", async () => {
    const corp = "https://ave.corp.example";
    const { service, fetchImpl } = client(
      { [`${corp}/.well-known/former-service.json`]: doc({ movedTo: NEW }) },
      { policyBase: async () => corp },
    );
    await expect(service.refresh()).resolves.toMatchObject({ base: corp, source: "policy" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([`${corp}/.well-known/former-service.json`]);
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails closed on an invalid policy instead of reading the public base", async () => {
    const { service, fetchImpl } = client({ [`${OLD}/.well-known/former-service.json`]: doc() }, {
      policyBase: async () => {
        throw new Error("policy service section is invalid");
      },
    });
    await expect(service.refresh()).rejects.toThrow("policy service section is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a redirect as a failure, so no request leaves the origin", async () => {
    const { service } = client({ [`${OLD}/.well-known/former-service.json`]: 302 });
    await expect(service.refresh()).rejects.toThrow("HTTP 302");
  });

  it("refuses a document over its size cap", async () => {
    const { service } = client({ [`${OLD}/.well-known/former-service.json`]: { ...doc(), padding: "x".repeat(70 * 1024) } });
    await expect(service.refresh()).rejects.toThrow(/larger than/u);
  });

  it("keeps the last announcements read when a later read fails, and throws with none read yet", async () => {
    const routes: Record<string, unknown> = {
      [`${OLD}/.well-known/former-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: [announcement(3)],
    };
    const { service } = client(routes);
    await expect(service.announcements()).resolves.toHaveLength(1);
    delete routes[`${OLD}/announcements/v1.json`];
    await expect(service.announcements()).resolves.toMatchObject([{ id: 3 }]);

    const fresh = client({});
    await expect(fresh.service.announcements()).rejects.toThrow("HTTP 404");
  });

  it("answers no announcements when the document names none", async () => {
    const { service } = client({ [`${OLD}/.well-known/former-service.json`]: doc({ announcements: null }) });
    await expect(service.announcements()).resolves.toEqual([]);
  });
});
