import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { outputHashOf, resultHashOf } from "../workflow-template-output.js";
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

it("pins the stored stage output hash as UTF-8 bytes", () => {
  expect(resultHashOf("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(resultHashOf("완료\n")).toBe(createHash("sha256").update("완료\n", "utf8").digest("hex"));
});
it("separates the stage result binding from the requested-output binding", () => {
  expect(resultHashOf("result")).not.toBe(outputHashOf("result", []));
  expect(resultHashOf("result\n")).not.toBe(resultHashOf("result"));
});
