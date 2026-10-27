/** Hold the generated client to published schemas and recorded host frames. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL_VERSION,
  createHostClient,
  isHostNotification,
  type HostClientTransport,
} from "../../../../schemas/plugin-host-protocol/4/protocol-client.js";
import {
  generateHostProtocolClient,
  renderHostProtocolClient,
} from "../../../../scripts/lib/plugin-host-protocol-client.js";
import { goldenFiles } from "./host-protocol-golden-files.js";

type Frame = Record<string, unknown>;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCHEMA_PATH = join(REPO_ROOT, "schemas/plugin-host-protocol/4/protocol.schema.json");
const CLIENT_PATH = join(REPO_ROOT, "schemas/plugin-host-protocol/4/protocol-client.ts");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as {
  $id: string;
  description: string;
  $defs: { methods: Record<string, unknown>; notifications: Record<string, unknown> };
};
const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/4/", import.meta.url));
const HOST_METHODS = Object.keys(SCHEMA.$defs.methods)
  .filter((method) => method.startsWith("ave/host/"))
  .sort();

function recordingTransport(reply: (method: string) => unknown = () => null): {
  transport: HostClientTransport;
  sent: Array<{ method: string; params: unknown }>;
} {
  const sent: Array<{ method: string; params: unknown }> = [];
  return {
    sent,
    transport: {
      request: async (method, params) => {
        sent.push({ method, params });
        return reply(method);
      },
      notify: (method) => {
        throw new Error(`the client sent the notification ${method}, which no stub sends`);
      },
    },
  };
}

function stubPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "function") return [prefix];
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, member]) =>
    stubPaths(member, prefix ? `${prefix}.${key}` : key));
}

function stubFor(client: unknown, method: string): ((params: unknown) => Promise<unknown>) | undefined {
  let node: unknown = client;
  for (const segment of method.slice("ave/host/".length).split("/")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "function" ? (node as (params: unknown) => Promise<unknown>) : undefined;
}

describe("the client is the schema's projection, byte for byte", () => {
  it("regenerates to the committed file on this platform", async () => {
    const { path, text } = await generateHostProtocolClient();
    expect(path).toBe("schemas/plugin-host-protocol/4/protocol-client.ts");
    expect(text).toBe(readFileSync(CLIENT_PATH, "utf-8"));
  }, 60_000);

  it("carries no app version: a schema tagged for another app release projects to the same bytes", async () => {
    const committed = readFileSync(CLIENT_PATH, "utf-8");
    const appVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as { version: string })
      .version;
    // The schema includes the app version; generated client bytes must not.
    expect(SCHEMA.$id).toContain(`/v${appVersion}/`);
    expect(SCHEMA.description).toContain(appVersion);
    const retagged = {
      ...SCHEMA,
      $id: SCHEMA.$id.replace(`/v${appVersion}/`, "/v99.98.97/"),
      description: SCHEMA.description.replaceAll(appVersion, "99.98.97"),
    };
    expect(await renderHostProtocolClient("4", retagged)).toBe(committed);
    expect(committed).not.toContain(SCHEMA.$id);
    expect(HOST_PROTOCOL_VERSION).toBe("4");
  }, 60_000);
});

describe("createHostClient has one stub per ave/host method, and nothing else", () => {
  it("exposes exactly the schema's ave/host methods, by path", () => {
    const { transport } = recordingTransport();
    const paths = stubPaths(createHostClient(transport)).sort();
    expect(HOST_METHODS.length).toBeGreaterThan(0);
    expect(paths).toEqual(HOST_METHODS.map((method) => method.slice("ave/host/".length).replaceAll("/", ".")).sort());
  });
});

describe("every golden ave/host recording is what its stub sends", () => {
  it("sends the golden method and params, and answers the transport's reply", async () => {
    const files = goldenFiles(join(GOLDEN_ROOT, "methods")).filter((file) => !file.startsWith("errors/"));
    const golden = files
      .map((file) => ({
        file,
        ...(JSON.parse(readFileSync(join(GOLDEN_ROOT, "methods", file), "utf-8")) as {
          request: Frame;
          response: Frame;
        }),
      }))
      .filter(({ request }) => String(request.method).startsWith("ave/host/"));
    expect(golden.map(({ request }) => request.method).sort()).toEqual(HOST_METHODS);

    for (const { file, request, response } of golden) {
      const method = request.method as string;
      const { transport, sent } = recordingTransport(() => response.result);
      const stub = stubFor(createHostClient(transport), method);
      expect(stub, `${file}: no stub at the path of ${method}`).toBeTypeOf("function");
      await expect(stub!(request.params), file).resolves.toEqual(response.result);
      expect(sent, file).toEqual([{ method, params: request.params }]);
    }
  });
});

describe("isHostNotification", () => {
  it("accepts every golden notification frame and refuses requests, replies and foreign methods", () => {
    const files = goldenFiles(join(GOLDEN_ROOT, "notifications"));
    expect(files).toHaveLength(Object.keys(SCHEMA.$defs.notifications).length);
    for (const file of files) {
      const { frame } = JSON.parse(readFileSync(join(GOLDEN_ROOT, "notifications", file), "utf-8")) as {
        frame: Frame;
      };
      expect(isHostNotification(frame), file).toBe(true);
    }
    const { request, response } = JSON.parse(
      readFileSync(join(GOLDEN_ROOT, "methods/ave/host/storage/read.json"), "utf-8"),
    ) as { request: Frame; response: Frame };
    expect(isHostNotification(request)).toBe(false);
    expect(isHostNotification(response)).toBe(false);
    expect(isHostNotification({ jsonrpc: "2.0", method: "notifications/progress", params: {} })).toBe(false);
    expect(isHostNotification({ jsonrpc: "2.0", id: 1, method: "notifications/cancelled", params: {} })).toBe(false);
    expect(isHostNotification(null)).toBe(false);
  });
});
