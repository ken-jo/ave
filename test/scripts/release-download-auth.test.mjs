import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { fetchBytesWithRetry } from "../../scripts/lib/fetch-with-retry.mjs";

const options = { httpError: (response) => `HTTP ${response.status}` };

for (const host of ["github.com", "api.github.com"]) {
  test(`authenticates the allowed host ${host}`, async () => {
    for (const env of [{ GITHUB_TOKEN: "primary", GH_TOKEN: "secondary" }, { GH_TOKEN: "primary" }]) {
      let received;
      const bytes = await fetchBytesWithRetry(`https://${host}/asset`, {
        ...options, env,
        fetchImpl: async (...args) => { received = args; return new Response("archive"); },
      });
      assert.equal(bytes.toString(), "archive");
      assert.deepEqual(received, [`https://${host}/asset`, { headers: { Authorization: "Bearer primary" } }]);
    }
  });
}

for (const url of ["https://objects.githubusercontent.com/asset", "https://registry.npmjs.org/asset",
  "https://github.com.example.org/asset", "https://api.github.com.example.org/asset", "http://github.com/asset"]) {
  test(`keeps credentials off ${url}`, async () => {
    let received;
    await fetchBytesWithRetry(url, { ...options, env: { GITHUB_TOKEN: "secret" },
      fetchImpl: async (...args) => { received = args; return new Response("archive"); } });
    assert.deepEqual(received, [url]);
  });
}

test("keeps the original request shape without a token", async () => {
  let received;
  await fetchBytesWithRetry("https://github.com/asset", { ...options, env: {},
    fetchImpl: async (...args) => { received = args; return new Response("archive"); } });
  assert.deepEqual(received, ["https://github.com/asset"]);
});

test("native fetch strips authorization on a cross-host redirect", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/start") {
      response.writeHead(302, { Location: `http://localhost:${server.address().port}/asset` });
      response.end();
    } else response.end("archive");
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const bytes = await fetchBytesWithRetry("https://github.com/asset", {
      ...options, env: { GITHUB_TOKEN: "fixture-token" },
      // Route the initial transport locally while retaining the production request options.
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/start`, init),
    });
    assert.equal(bytes.toString(), "archive");
    assert.deepEqual(requests, [
      { path: "/start", authorization: "Bearer fixture-token" },
      { path: "/asset", authorization: undefined },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
