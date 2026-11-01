import assert from "node:assert/strict";
import { test } from "node:test";
import { egressPolicyObservationPassed } from "./egress-policy-run.mjs";
const denial = { connected: false, error: "EACCES" };
const result = { ownAllowed: { status: 200 }, ownDenied: { status: 403 }, otherListener: denial, unrelatedListener: denial, directEgress: denial };
const expected = [{ owner: "actual-holder", target: "allowed" }, { owner: "actual-holder", target: "denied" }];
test("endpoint acceptance requires positive own proxy and independently attributed requests", () => {
  assert.equal(egressPolicyObservationPassed(result, expected, expected, 0), true);
  assert.equal(egressPolicyObservationPassed(result, [{ owner: "forged-holder" }], expected, 0), false);
  assert.equal(egressPolicyObservationPassed(result, expected, expected, 1), false);
});
test("timeouts, refused service and missing observations never establish endpoint isolation", () => {
  for (const error of ["ETIMEDOUT", "ECONNREFUSED", "Fixture connect deadline"]) {
    assert.equal(egressPolicyObservationPassed({ ...result, directEgress: { connected: false, error } }, expected, expected, 0), false);
  }
  assert.equal(egressPolicyObservationPassed({ ...result, otherListener: { connected: true } }, expected, expected, 0), false);
  assert.equal(egressPolicyObservationPassed({}, expected, expected, 0), false);
});
test("probe fixtures listen on loopback only, never a wildcard or non-loopback address", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL("./", import.meta.url);
  const sources = (await readdir(directory)).filter((file) => /\.(?:mjs|ts|cs)$/u.test(file) && !/\.test\.(?:mjs|ts)$/u.test(file));
  // The scan must actually reach every source kind, including the packaged TS entry and the C# kernel fixture.
  for (const kind of [".mjs", ".ts", ".cs"]) assert.ok(sources.some((file) => file.endsWith(kind)), `no ${kind} probe source scanned`);
  for (const name of sources) {
    const source = await readFile(new URL(name, directory), "utf8");
    // Every Node listener binds an explicit loopback host.
    for (const [call, host] of source.matchAll(/\.listen\(([^)]*)\)/g)) {
      const args = host.split(",").map((part) => part.trim());
      assert.ok(args.length >= 2 && args[1] === '"127.0.0.1"', `${name} listens without explicit loopback: ${call}`);
    }
    // Wildcard or any-interface binds in JavaScript, TypeScript or C# (sockets, TcpListener, HttpListener prefixes).
    assert.doesNotMatch(source, /0\.0\.0\.0|"::"|IPAddress\.(?:Any|IPv6Any)\b|\bHttpListener\b|https?:\/\/[+*]/u, `${name} must not bind a wildcard`);
    assert.doesNotMatch(source, /\bnew\s+TcpListener\((?!\s*IPAddress\.Loopback\b)/u, `${name} TcpListener must bind IPAddress.Loopback`);
  }
});
