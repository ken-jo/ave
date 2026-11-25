import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { evaluateModelVerdict } from "../stage-verdict.js";

const PASS = '```json\n{"verdict":"pass","reason":"The total is verified."}\n```';

function block(value: unknown): string {
  return ["```json", JSON.stringify(value), "```"].join("\n");
}

it("passes on a single pass verdict", async () => {
  const output = `Verified total: 5.\n\n${PASS}\n`;
  expect(await evaluateModelVerdict(output)).toMatchObject({ passed: true, evidence: "The total is verified." });
});

it("fails on a fail verdict", async () => {
  const output = block({ verdict: "fail", reason: "Missing evidence: the total is unknown." });
  expect(await evaluateModelVerdict(output)).toMatchObject({ passed: false, evidence: "Missing evidence: the total is unknown." });
});

it("fails with no block", async () => {
  expect(await evaluateModelVerdict('{"verdict":"pass","reason":"Verified."}')).toMatchObject({ passed: false, evidence: "verdict-unreadable" });
});

it("fails with two blocks", async () => {
  expect(await evaluateModelVerdict(`${PASS}\n\n${PASS}`)).toMatchObject({ passed: false, evidence: "verdict-unreadable" });
});

it("fails on prose claiming OK", async () => {
  expect(await evaluateModelVerdict("OK, the check passed.")).toMatchObject({ passed: false, evidence: "verdict-unreadable" });
});

it("records judgedBy model", async () => {
  expect(await evaluateModelVerdict(PASS)).toMatchObject({ judgedBy: "model" });
});

it("reads a verdict after a long stage result", async () => {
  expect(await evaluateModelVerdict(`${"Verified. ".repeat(500)}\n\n${PASS}`)).toMatchObject({ passed: true });
});

it("allows an earlier fenced code sample in the stage result", async () => {
  const output = ["Example:", "```text", "5 + 0 = 5", "```", "", PASS].join("\n");
  expect(await evaluateModelVerdict(output)).toMatchObject({ passed: true });
});

it.each([
  ["trailing prose", `${PASS}\nThat is all.`],
  ["a nested verdict in an unfinished code sample", ["Quoted output:", "````text", PASS].join("\n")],
  ["a quoted verdict before the final verdict", `${PASS.split("\n").map(line => `> ${line}`).join("\n")}\n\n${PASS}`],
  ["an extra key", block({ verdict: "pass", reason: "Verified.", extra: true })],
  ["a missing reason", block({ verdict: "pass" })],
  ["duplicate keys", '```json\n{"verdict":"fail","verdict":"pass","reason":"Verified."}\n```'],
  ["a reason over 400 characters", block({ verdict: "pass", reason: "x".repeat(401) })],
  ["an empty reason", block({ verdict: "pass", reason: "" })],
  ["a whitespace-only reason", block({ verdict: "pass", reason: " \n " })],
  ["a NUL in the reason", block({ verdict: "pass", reason: "Verified\0." })],
])("rejects %s", async (_case, output) => {
  expect(await evaluateModelVerdict(output)).toEqual({ passed: false, evidence: "verdict-unreadable", judgedBy: "model" });
});

it("masks sensitive data in the reason after decoding JSON", async () => {
  const token = `sk-${"a".repeat(48)}`;
  const result = await evaluateModelVerdict(block({ verdict: "pass", reason: `Matched ${token}.` }));
  expect(result).toMatchObject({ passed: true, evidence: expect.stringContaining("[REDACTED") });
  expect(result.evidence).not.toContain(token);
});

it("keeps stage-verdict independent of permission and tool execution modules", () => {
  const source = readFileSync(new URL("../stage-verdict.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/["'][^"'\n]*\/permissions\//);
  expect(source).not.toMatch(/["'][^"'\n]*\/tools\//);
});
