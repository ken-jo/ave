import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSymlinkCapability } from "../../../__tests__/support/symlink-capability.js";
import {
  AVE_SERVICE_BASE_URL,
  ServiceClient,
  normalizeServiceBase,
  parseServiceDocument,
  readPolicyServiceBase,
  type ServiceClientOptions,
} from "../client.js";

vi.mock("../../../lib/admin-policy-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-policy-file.js")>()),
  readAdminPolicyFile: (path: string) => import("node:fs/promises").then(({ readFile }) => readFile(path)),
}));

const OLD = "https://ave.agent-connector.ai";
const NEW = "https://ave.example";

const doc = (fields: Record<string, unknown> = {}) => ({ schemaVersion: 1, announcements: "/announcements/v1.json", telemetry: null, movedTo: null, movedFrom: null, ...fields });

const announcement = (id: number) => ({
  id,
  title: `Notice ${id}`,
  body: "Body",
  level: "info",
  createdAt: "2026-09-23T00:00:00.000Z",
  actions: [{ label: { en: "Open", ko: "열기" }, target: { kind: "url", url: "https://ave.agent-connector.ai/news" } }],
});

function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) return new Response("missing", { status: 404 });
    if (route instanceof Response) return route;
    if (typeof route === "number") return new Response("", { status: route, headers: { location: "https://evil.example/" } });
    return new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("normalizeServiceBase", () => {
  it("accepts an https origin and refuses paths, plain http and credentials", () => {
    expect(normalizeServiceBase("https://ave.agent-connector.ai/")).toBe("https://ave.agent-connector.ai");
    expect(() => normalizeServiceBase("https://ave.agent-connector.ai/base")).toThrow(/origin/u);
    expect(() => normalizeServiceBase("http://ave.agent-connector.ai")).toThrow(/https/u);
    expect(() => normalizeServiceBase("https://user:pw@ave.agent-connector.ai")).toThrow(/origin/u);
    expect(() => normalizeServiceBase("http://127.0.0.1:8123")).toThrow(/https/u);
    expect(normalizeServiceBase("http://127.0.0.1:8123", { allowLoopbackHttp: true })).toBe("http://127.0.0.1:8123");
    expect(() => normalizeServiceBase("http://10.0.0.1", { allowLoopbackHttp: true })).toThrow(/https/u);
  });

  it.each(["https:ave.agent-connector.ai", " https://ave.agent-connector.ai", "https://ave.agent-connector.ai ", "https://:@ave.agent-connector.ai", "https://ave.agent-connector.ai?", "https://ave.agent-connector.ai#", "https://ave.agent-connector.ai/%2e", "https://AVE.agent-connector.ai"])(
    "refuses %j, a spelling the URL parser would repair",
    (value) => {
      expect(() => normalizeServiceBase(value)).toThrow(/origin/u);
    },
  );
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
    // The URL parser strips tabs and newlines, so these become `//evil.example`: only the origin check catches them.
    ["a path with a tab", doc({ announcements: "/\t/evil.example/a.json" })],
    ["a path with a newline", doc({ telemetry: "/\n/evil.example/t" })],
    ["a path with CRLF", doc({ announcements: "/\r\n//evil.example" })],
    ["a move to an IPv4 address", doc({ movedTo: "https://10.0.0.8" })],
    ["a move to an IPv6 address", doc({ movedTo: "https://[fd00::1]" })],
    ["a move to a single-label host", doc({ movedTo: "https://intranet" })],
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

  it("throws on an ENOTDIR policy path instead of falling back to the public base", async () => {
    const parent = join(dir, "admin");
    writeFileSync(parent, "not a directory");
    await expect(readPolicyServiceBase(join(parent, "policy.json"))).rejects.toMatchObject({ code: process.platform === "win32" ? "ENOENT" : "ENOTDIR" });
  });

  it("throws on a dangling policy symlink instead of falling back to the public base", async ({ skip }) => {
    requireSymlinkCapability(dir, "file", skip);
    const path = join(dir, "policy.json");
    symlinkSync(join(dir, "missing-target.json"), path, "file");
    await expect(readPolicyServiceBase(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["an unknown key", { service: { baseUrl: "https://ave.corp.example", mirror: "x" } }],
    ["plain http", { service: { baseUrl: "http://ave.corp.example" } }],
    ["a missing baseUrl", { service: {} }],
    ["invalid JSON", "{"],
    ["a duplicated baseUrl", '{"service":{"baseUrl":"https://ave.corp.example","baseUrl":"https://ave.agent-connector.ai"}}'],
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
    expect(AVE_SERVICE_BASE_URL).toBe("https://ave.agent-connector.ai");
  });

  it("reads announcements and the telemetry endpoint from the build base", async () => {
    const { service } = client({
      [`${OLD}/.well-known/ave-service.json`]: doc({ telemetry: "/telemetry/events" }),
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
      [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/ave-service.json`]: doc({ movedFrom: OLD }),
      [`${NEW}/announcements/v1.json`]: [announcement(2)],
    };
    const first = client(routes);
    await expect(first.service.refresh()).resolves.toMatchObject({ base: NEW, source: "moved" });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ version: 1, buildBase: OLD, movedTo: NEW, acceptedAt: "2026-09-23T00:00:00.000Z" });

    const second = client(routes);
    expect((await second.service.announcements()).map((item) => item.id)).toEqual([2]);
    expect(second.fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(`${OLD}/.well-known/ave-service.json`);
  });

  it("stays when the new base does not name the old one in movedFrom", async () => {
    const { service } = client({
      [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/ave-service.json`]: doc({ movedFrom: "https://other.example" }),
    });
    await expect(service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("follows at most one move per build constant", async () => {
    const third = "https://third.example";
    const routes = {
      [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/ave-service.json`]: doc({ movedFrom: OLD, movedTo: third }),
      [`${third}/.well-known/ave-service.json`]: doc({ movedFrom: NEW }),
    };
    await expect(client(routes).service.refresh()).resolves.toMatchObject({ base: NEW });
    await expect(client(routes).service.refresh()).resolves.toMatchObject({ base: NEW, source: "moved" });
  });

  it("drops a move made under another build constant", async () => {
    await client({
      [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/ave-service.json`]: doc({ movedFrom: OLD }),
    }).service.refresh();
    const shipped = "https://ave-next.example";
    const { service } = client({ [`${shipped}/.well-known/ave-service.json`]: doc() }, { buildBase: shipped });
    await expect(service.refresh()).resolves.toMatchObject({ base: shipped, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("drops a move record it cannot read", async () => {
    mkdirSync(join(dir, "marketplaces"), { recursive: true });
    writeFileSync(statePath, "{ not json");
    await expect(client({ [`${OLD}/.well-known/ave-service.json`]: doc() }).service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("prefers the policy base and never follows a move from it", async () => {
    const corp = "https://ave.corp.example";
    const { service, fetchImpl } = client(
      { [`${corp}/.well-known/ave-service.json`]: doc({ movedTo: NEW }) },
      { policyBase: async () => corp },
    );
    await expect(service.refresh()).resolves.toMatchObject({ base: corp, source: "policy" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([`${corp}/.well-known/ave-service.json`]);
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails closed on an invalid policy instead of reading the public base", async () => {
    const { service, fetchImpl } = client({ [`${OLD}/.well-known/ave-service.json`]: doc() }, {
      policyBase: async () => {
        throw new Error("policy service section is invalid");
      },
    });
    await expect(service.refresh()).rejects.toThrow("policy service section is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a redirect as a failure, so no request leaves the origin", async () => {
    const { service } = client({ [`${OLD}/.well-known/ave-service.json`]: 302 });
    await expect(service.refresh()).rejects.toThrow("HTTP 302");
  });

  it("refuses a document over its size cap", async () => {
    const { service } = client({ [`${OLD}/.well-known/ave-service.json`]: { ...doc(), padding: "x".repeat(70 * 1024) } });
    await expect(service.refresh()).rejects.toThrow(/larger than/u);
  });

  it("keeps the last announcements read when a later read fails, and throws with none read yet", async () => {
    const routes: Record<string, unknown> = {
      [`${OLD}/.well-known/ave-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: [announcement(3)],
    };
    const { service } = client(routes);
    await expect(service.announcements()).resolves.toHaveLength(1);
    delete routes[`${OLD}/announcements/v1.json`];
    await expect(service.announcements()).resolves.toMatchObject([{ id: 3 }]);

    const fresh = client({});
    await expect(fresh.service.announcements()).rejects.toThrow("HTTP 404");
  });

  it("keeps the last announcements through a document outage on the same base", async () => {
    const routes: Record<string, unknown> = {
      [`${OLD}/.well-known/ave-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: [announcement(4)],
    };
    const { service } = client(routes);
    await service.announcements();
    delete routes[`${OLD}/.well-known/ave-service.json`];
    await expect(service.announcements()).resolves.toMatchObject([{ id: 4 }]);
  });

  it("leaves nothing from the old base in force when the policy turns invalid during the session", async () => {
    let policy: () => Promise<string | null> = async () => null;
    const { service } = client(
      {
        [`${OLD}/.well-known/ave-service.json`]: doc({ telemetry: "/telemetry/events" }),
        [`${OLD}/announcements/v1.json`]: [announcement(5)],
      },
      { policyBase: () => policy() },
    );
    await service.announcements();
    expect(service.telemetryEndpoint()).toBe(`${OLD}/telemetry/events`);

    policy = async () => {
      throw new Error("policy service section is invalid");
    };
    await expect(service.refresh()).rejects.toThrow("policy service section is invalid");
    expect(service.telemetryEndpoint()).toBeUndefined();
    await expect(service.announcements()).rejects.toThrow("policy service section is invalid");
  });

  it("stops using the public base when the policy names a base it cannot reach", async () => {
    const corp = "https://ave.corp.example";
    let policy: string | null = null;
    const { service } = client(
      {
        [`${OLD}/.well-known/ave-service.json`]: doc({ telemetry: "/telemetry/events" }),
        [`${OLD}/announcements/v1.json`]: [announcement(6)],
      },
      { policyBase: async () => policy },
    );
    await service.announcements();
    policy = corp;
    await expect(service.announcements()).rejects.toThrow("HTTP 404");
    expect(service.telemetryEndpoint()).toBeUndefined();
  });

  it("distinguishes an endpoint not known yet from one the document does not name", async () => {
    const { service } = client({ [`${OLD}/.well-known/ave-service.json`]: doc() });
    expect(service.telemetryEndpoint()).toBeUndefined();
    await service.refresh();
    expect(service.telemetryEndpoint()).toBeNull();
  });

  it("ensureResolved reads the document once, and after a failure waits the retry interval", async () => {
    let now = new Date("2026-09-23T00:00:00.000Z");
    const routes: Record<string, unknown> = {};
    const { service, fetchImpl } = client(routes, { now: () => now });
    service.ensureResolved();
    service.ensureResolved();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    service.ensureResolved();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    routes[`${OLD}/.well-known/ave-service.json`] = doc({ telemetry: "/telemetry/events" });
    now = new Date("2026-09-23T00:10:01.000Z");
    service.ensureResolved();
    await vi.waitFor(() => expect(service.telemetryEndpoint()).toBe(`${OLD}/telemetry/events`));
    service.ensureResolved();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ensureResolved reads the document again once it is older than six hours", async () => {
    let now = new Date("2026-09-23T00:00:00.000Z");
    const routes: Record<string, unknown> = { [`${OLD}/.well-known/ave-service.json`]: doc({ telemetry: "/telemetry/events" }) };
    let policy: () => Promise<string | null> = async () => null;
    const { service, fetchImpl } = client(routes, { now: () => now, policyBase: () => policy() });
    service.ensureResolved();
    await vi.waitFor(() => expect(service.telemetryEndpoint()).toBe(`${OLD}/telemetry/events`));

    policy = async () => {
      throw new Error("policy service section is invalid");
    };
    now = new Date("2026-09-23T05:59:00.000Z");
    service.ensureResolved();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.telemetryEndpoint()).toBe(`${OLD}/telemetry/events`);
    now = new Date("2026-09-23T06:00:01.000Z");
    service.ensureResolved();
    await vi.waitFor(() => expect(service.telemetryEndpoint()).toBeUndefined());
  });

  it("does not keep the old base's announcements when a move accepted in the same refresh fails to list the new base's", async () => {
    const routes: Record<string, unknown> = {
      [`${OLD}/.well-known/ave-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: [announcement(7)],
    };
    const { service } = client(routes);
    await service.announcements();
    routes[`${OLD}/.well-known/ave-service.json`] = doc({ movedTo: NEW });
    routes[`${NEW}/.well-known/ave-service.json`] = doc({ movedFrom: OLD });
    await expect(service.announcements()).rejects.toThrow("HTTP 404");
  });

  it("keeps the build base's announcements when a move cannot be recorded and the next list read fails", async () => {
    mkdirSync(statePath, { recursive: true });
    const routes: Record<string, unknown> = {
      [`${OLD}/.well-known/ave-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: [announcement(8)],
    };
    const { service } = client(routes);
    await service.announcements();
    routes[`${OLD}/.well-known/ave-service.json`] = doc({ movedTo: NEW });
    routes[`${NEW}/.well-known/ave-service.json`] = doc({ movedFrom: OLD });
    delete routes[`${OLD}/announcements/v1.json`];
    await expect(service.announcements()).resolves.toMatchObject([{ id: 8 }]);
    await expect(service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
  });

  it("refuses a response whose declared length is over the cap before reading it", async () => {
    const response = new Response(JSON.stringify(doc()), { status: 200, headers: { "content-length": String(65 * 1024) } });
    const cancel = vi.spyOn(response.body!, "getReader");
    const { service } = client({ [`${OLD}/.well-known/ave-service.json`]: response });
    await expect(service.refresh()).rejects.toThrow(/larger than 65536 bytes/u);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("refuses an announcements list over 1 MB", async () => {
    const { service } = client({
      [`${OLD}/.well-known/ave-service.json`]: doc(),
      [`${OLD}/announcements/v1.json`]: { announcements: [], padding: "x".repeat(1024 * 1024) },
    });
    await expect(service.announcements()).rejects.toThrow(/larger than 1048576 bytes/u);
  });

  it("gives up on a request after its timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
    const service = new ServiceClient({ fetchImpl: fetchImpl as unknown as typeof fetch, buildBase: OLD, policyBase: async () => null, statePath, appVersion: "0.10.0", timeoutMs: 20 });
    await expect(service.refresh()).rejects.toThrow(/timeout|aborted/iu);
  });

  it("stays when the move target cannot be read, and ignores a move to itself", async () => {
    await expect(client({ [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }) }).service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    await expect(client({ [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: OLD }) }).service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails when an accepted move's base cannot be read, without falling back", async () => {
    await client({
      [`${OLD}/.well-known/ave-service.json`]: doc({ movedTo: NEW }),
      [`${NEW}/.well-known/ave-service.json`]: doc({ movedFrom: OLD }),
    }).service.refresh();
    const { service, fetchImpl } = client({ [`${OLD}/.well-known/ave-service.json`]: doc() });
    await expect(service.refresh()).rejects.toThrow("HTTP 404");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([`${NEW}/.well-known/ave-service.json`]);
  });

  it("ignores a move record it cannot read as a file, and keeps the service available", async () => {
    mkdirSync(statePath, { recursive: true });
    await expect(client({ [`${OLD}/.well-known/ave-service.json`]: doc() }).service.refresh()).resolves.toMatchObject({ base: OLD, source: "build" });
    expect(existsSync(statePath)).toBe(true);
  });

  it("answers no announcements when the document names none", async () => {
    const { service } = client({ [`${OLD}/.well-known/ave-service.json`]: doc({ announcements: null }) });
    await expect(service.announcements()).resolves.toEqual([]);
  });
});
