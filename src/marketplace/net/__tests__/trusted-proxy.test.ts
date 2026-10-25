/** System-configured proxies are trusted beyond their socket and resolve targets themselves.
 * This test pins that contract; changes must update its specification too. */
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { policyLoad, policySource } from "../../__tests__/fixtures/policy.js";
import { NetworkGate, type CatalogSource } from "../network-gate.js";
import { createPinnedFetch } from "../pinned-fetch.js";
import { normalizeSourceUrl } from "../source-url.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe("a PAC proxy is trusted beyond its socket (§18.2.4)", () => {
  let target: Server;
  let targetPort: number;
  let proxy: Server;
  let proxyPort: number;
  const reached: string[] = [];
  const forwarded: string[] = [];

  beforeAll(async () => {
    target = createServer((request, response) => {
      reached.push(request.url ?? "");
      response.end("loopback service");
    });
    targetPort = await listen(target);
    proxy = createServer((request, response) => {
      forwarded.push(request.url ?? "");
      const url = new URL(request.url ?? "");
      const upstream = httpRequest({ host: "127.0.0.1", port: Number(url.port), path: `${url.pathname}${url.search}`, method: request.method }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      upstream.end();
    });
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    await Promise.all([close(target), close(proxy)]);
  });

  it("checks and connects only to the proxy, and the proxy reaches a loopback target a catalog named", async () => {
    const lookups: string[] = [];
    const transport = createPinnedFetch({
      lookup: async (host) => {
        lookups.push(host);
        if (host === "proxy.test") return ["127.0.0.1"];
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      },
      resolveProxy: async () => `PROXY proxy.test:${proxyPort}`,
    });
    const gate = new NetworkGate({ policy: policySource(policyLoad()), allowLoopback: false, transport });
    const catalog: CatalogSource = { id: "acme", label: "Acme", url: normalizeSourceUrl("https://1.1.1.1/acme/market"), acknowledged: new Set() };
    const response = await gate.fetch(`http://internal.test:${targetPort}/admin`, { official: false, catalog });
    expect(await response.text()).toBe("loopback service");
    expect(lookups).toEqual(["proxy.test"]);
    expect(forwarded).toEqual([`http://internal.test:${targetPort}/admin`]);
    expect(reached).toEqual(["/admin"]);
  });
});
