import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { outputHashOf } from "../workflow-template-output.js";
import type { RequestedOutput } from "../workflow-template-types.js";
it("hashes the canonical output pair independent of nested key order", () => {
  const a = { id: "out", decl: { kind: "send-message", toolName: "media.send", owner: "plugin", ownerId: "media" }, args: '{"a":1,"b":2}', summary: "Summary" } as RequestedOutput;
  const b = { summary: "Summary", args: '{"a":1,"b":2}', decl: { ownerId: "media", owner: "plugin", toolName: "media.send", kind: "send-message" }, id: "out" } as RequestedOutput;
  expect(outputHashOf("result", [a])).toMatch(/^[a-f0-9]{64}$/); expect(outputHashOf("result", [a])).toBe(outputHashOf("result", [b])); expect(outputHashOf("other", [a])).not.toBe(outputHashOf("result", [a])); expect(outputHashOf("result", [])).not.toBe(outputHashOf("result", [a]));
});
it("uses SHA-256 over a canonical JSON pair and preserves output order", () => {
  const outputs = [{ id: "a", decl: { kind: "send-message", toolName: "media.send", owner: "plugin", ownerId: "media" }, args: "{}", summary: "A" }, { id: "b", decl: { kind: "send-message", toolName: "media.send", owner: "plugin", ownerId: "media" }, args: "{}", summary: "B" }] as RequestedOutput[];
  expect(outputHashOf("result", [])).toBe(createHash("sha256").update('{"output":"result","requestedOutputs":[]}').digest("hex"));
  expect(outputHashOf("result", outputs)).not.toBe(outputHashOf("result", outputs.toReversed()));
});
