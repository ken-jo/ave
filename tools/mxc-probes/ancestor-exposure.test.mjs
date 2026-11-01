import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAncestorExposure } from "./ancestor-exposure-results.mjs";

const HOST = { observations: { siblingContent: { contents: "host-only-marker" }, descendantContent: { contents: "descendant-marker" } } };
const MEASURED = { marker: "ancestor-exposure", observations: { profile: { names: ["Documents", "Temp"] },
  descendant: { names: ["descendant-name.txt"] }, siblingContent: { error: "EACCES" }, descendantContent: { error: "EPERM" } } };

test("recursive name visibility remains disclosed while content is denied", () => {
  assert.deepEqual(evaluateAncestorExposure(HOST, MEASURED, true), {
    contentDenied: true, profileNameExposure: true, descendantEnumeration: "visible", accepted: true,
  });
});

test("missing controls, content escape and changed descriptors cannot pass", () => {
  assert.equal(evaluateAncestorExposure({}, MEASURED, true).accepted, false);
  assert.equal(evaluateAncestorExposure(HOST, MEASURED, false).accepted, false);
  assert.equal(evaluateAncestorExposure(HOST, {}, true).accepted, false);
  assert.equal(evaluateAncestorExposure(HOST, { ...MEASURED, observations: { ...MEASURED.observations,
    descendant: undefined } }, true).accepted, false);
  assert.equal(evaluateAncestorExposure(HOST, { ...MEASURED, observations: { ...MEASURED.observations,
    siblingContent: { contents: "host-only-marker" } } }, true).accepted, false);
});

test("a denied descendant enumeration remains a measured scope observation", () => {
  const result = evaluateAncestorExposure(HOST, { ...MEASURED,
    observations: { ...MEASURED.observations, descendant: { error: "EPERM" } } }, true);
  assert.equal(result.descendantEnumeration, "EPERM");
  assert.equal(result.accepted, true);
});
