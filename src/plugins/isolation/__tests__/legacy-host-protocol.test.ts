// Protocol 3 is served as legacy: it activates, but authRedirect is refused; protocol 4 keeps host-owned state.
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import { AuthRedirectCatchers } from "../../../main/auth-redirect-catcher.js";
import { servePluginChild } from "../plugin-child-main.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { hostApiMethodOf, IncompatibleHostProtocolError } from "../host-api-wire.js";
import { openValidationSession } from "../../validate/validation-session.js";
import type { ValidationHostOverrides } from "../../validate/validation-host.js";
import { createRecordingHost } from "./host-protocol-recording-host.js";
import { settle } from "./stream-turns.js";

const ENTRY = fileURLToPath(new URL("./fixtures/legacy-host-protocol/entry.mjs", import.meta.url));
const AUTH_REDIRECT_METHODS = ["open", "wait", "close"].map((member) => `ave/host/authRedirect/${member}`);

function manifest(hostProtocol: string): PluginManifest {
  return {
    id: `legacy-v${hostProtocol}`,
    name: `Legacy v${hostProtocol}`,
    version: "1.0.0",
    entry: "entry.mjs",
    requires: { hostProtocol },
    description: "reports how authRedirect settles for its declared host protocol",
    tools: ["ping", "open", "wait", "close"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  };
}

interface Opened {
  readonly instance: RuntimePlugin;
  readonly capabilities: readonly string[];
  readonly calls: string[];
}

const live: RuntimePlugin[] = [];

afterEach(async () => {
  for (const instance of live.splice(0)) await instance.stop?.();
  await settle();
});

async function open(hostProtocol: string, overrides: ValidationHostOverrides = {}): Promise<Opened> {
  const calls: string[] = [];
  const record = (path: string, real: (...args: never[]) => unknown) => (...args: never[]) => {
    calls.push(path);
    return real(...args);
  };
  const host = createRecordingHost(overrides);
  const redirect = host.api.authRedirect as unknown as Record<"open" | "wait" | "close", (...args: never[]) => unknown>;
  for (const member of ["open", "wait", "close"] as const) {
    redirect[member] = record(`authRedirect.${member}`, redirect[member].bind(redirect));
  }
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  const link: ChildLink = {
    input: childToHost,
    output: hostToChild,
    terminate: () => service.hostGone(),
    onGone: () => undefined,
    onFault: () => undefined,
  };
  const session = await openValidationSession({
    manifest: manifest(hostProtocol),
    host,
    link,
    entryPath: ENTRY,
    pluginRoot: `/plugins/legacy-v${hostProtocol}`,
    pluginDataDir: `/plugins/legacy-v${hostProtocol}/data`,
  });
  live.push(session.instance);
  await settle();
  return { instance: session.instance, capabilities: session.capabilities, calls };
}

type Settled = { result?: Record<string, string>; error?: { code: string; name: string; message: string; detail?: Record<string, unknown> } };

function hit(redirectUri: string, query: string): Promise<number> {
  const url = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: Number(url.port), path: `${url.pathname}${query}`, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("host protocol 3, served as legacy", () => {
  it("activates a protocol-3 plugin and serves its other members", async () => {
    const { instance, capabilities } = await open("3");
    await expect(instance.handlers.ping!({})).resolves.toEqual({ pong: true });
    expect(capabilities).toContain(hostApiMethodOf("storage.read"));
  });

  it("does not advertise authRedirect to a protocol-3 connection", async () => {
    const { capabilities } = await open("3");
    for (const method of AUTH_REDIRECT_METHODS) expect(capabilities).not.toContain(method);
  });

  it.each(["open", "wait", "close"] as const)(
    "refuses authRedirect.%s with a typed error that never reaches the host",
    async (member) => {
      const { instance, calls } = await open("3");
      const outcome = (await instance.handlers[member]!({ handle: "redirect-1" })) as Settled;
      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toMatchObject({
        code: "path-not-implemented",
        detail: { path: `authRedirect.${member}`, hostProtocol: "3", requiredHostProtocol: "4" },
      });
      expect(outcome.error!.message).toContain("authRedirect requires host protocol 4 — migrate this extension");
      expect(calls).toEqual([]);
    },
  );
});

describe("host protocol 4", () => {
  it("advertises authRedirect and returns host-issued state", async () => {
    const { instance, capabilities, calls } = await open("4");
    for (const method of AUTH_REDIRECT_METHODS) expect(capabilities).toContain(method);
    const outcome = (await instance.handlers.open!({})) as Settled;
    expect(outcome.result).toMatchObject({ handle: "redirect-1", state: "the-state" });
    expect(calls).toEqual(["authRedirect.open"]);
  });

  it("completes only a callback that carries the host-issued state", async () => {
    const catchers = new AuthRedirectCatchers();
    const owner = "legacy-v4";
    const { instance } = await open("4", {
      "authRedirect.open": async () => await catchers.open(owner),
      "authRedirect.wait": async (options: { handle: string; timeoutMs?: number }) =>
        await catchers.wait(owner, options.handle, options.timeoutMs),
      "authRedirect.close": (options: { handle: string }) => catchers.close(owner, options.handle),
    });
    const opened = (await instance.handlers.open!({})) as Settled;
    const { handle, redirectUri, state } = opened.result!;
    try {
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await hit(redirectUri!, "?code=c")).toBe(404);
      expect(await hit(redirectUri!, "?code=c&state=forged")).toBe(404);
      expect(await hit(redirectUri!, `?code=c&state=${state}`)).toBe(303);
      const waited = (await instance.handlers.wait!({ handle })) as Settled;
      expect(waited.result).toEqual({ code: "c", state });
    } finally {
      await instance.handlers.close!({ handle });
    }
  });
});

describe("unserved host protocols", () => {
  it("still refuses a protocol-2 plugin before its child connects", async () => {
    const written: unknown[] = [];
    const link: ChildLink = {
      input: new PassThrough(),
      output: new Writable({
        write(chunk, _encoding, callback) {
          written.push(chunk);
          callback(new Error("a frame was written to an unserved child"));
        },
      }),
      terminate: () => undefined,
      onGone: () => undefined,
      onFault: () => undefined,
    };
    const refused = openValidationSession({
      manifest: manifest("2"),
      host: createRecordingHost(),
      link,
      entryPath: ENTRY,
      pluginRoot: "/plugins/legacy-v2",
      pluginDataDir: "/plugins/legacy-v2/data",
    });
    await expect(refused).rejects.toBeInstanceOf(IncompatibleHostProtocolError);
    await expect(refused).rejects.toThrow(/speaks host protocol 2; this app serves 3, 4/);
    expect(written).toEqual([]);
  });
});
