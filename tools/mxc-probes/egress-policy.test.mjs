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
