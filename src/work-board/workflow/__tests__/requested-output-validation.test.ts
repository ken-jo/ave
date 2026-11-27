import { expect, it } from "vitest";
import type { RequestedOutput, RequestedOutputDecl, StageEnvelope } from "../../../shared/workflow-template-types.js";
import { LOCAL_BRANCH_OUTPUT } from "../../../shared/workflow-template-output.js";
import { collectRequestedOutputs, requestedOutputsMatchStage } from "../requested-output.js";
import { stageOf } from "./stage-fixtures.js";

const PLUGIN = { owner: "plugin", ownerId: "delivery", toolName: "deliver" } as const;
const SERVER = { owner: "server", ownerId: "posting", toolName: "publish" } as const;
const UPLOAD = { ...PLUGIN, kind: "upload" } as const;
const SEND = { ...PLUGIN, toolName: "send", kind: "send-message" } as const;
const POST = { ...SERVER, kind: "publish-post" } as const;
const WRITE = { ...SERVER, toolName: "write", kind: "external-write" } as const;
const OTHER = { ...PLUGIN, toolName: "other", kind: "other" } as const;
const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], commands: [], network: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["branch", "upload", "send-message", "publish-post", "external-write", "other"],
  budget: { rounds: 5, minutes: 1, costUsd: 0 },
};
const STAGE = stageOf("review", { envelope: ENVELOPE, requestedOutputs: [UPLOAD, SEND, POST, WRITE, OTHER] });
const request = (decl: RequestedOutput["decl"], args: object, id = "result") => ({ id, ...decl, args, summary: "Ready" });
const collect = (entries: unknown[]) => collectRequestedOutputs(STAGE, "run-one", JSON.stringify({ result: "Summary", requestedOutputs: entries }));

it.each([
  [UPLOAD, { destination: "reports", path: "drafts/report.md" }],
  [SEND, { recipient: "Team", text: "Draft ready\nSee the report." }],
  [POST, { destination: "Project updates", text: "New version available" }],
  [WRITE, { target: "Release notes", data: "Version 1" }],
] as const)("collects the exact payload and owner for a $kind request", (decl: RequestedOutputDecl, args: object) => {
  const result = collect([request(decl, args)]);
  expect(result).toMatchObject({ ok: true, output: "Summary", requestedOutputs: [{ decl }] });
  if (!result.ok || !result.requestedOutputs) throw new Error("Requested output was refused");
  expect(JSON.parse(result.requestedOutputs[0].args)).toEqual(args);
  expect(requestedOutputsMatchStage(STAGE, "run-one", result.requestedOutputs)).toBe(true);
});

it("derives the branch from the run and stage without accepting a supplied ref or commit", () => {
  expect(collect([request(LOCAL_BRANCH_OUTPUT, {})])).toMatchObject({
    ok: true, requestedOutputs: [{ args: '{"branch":"ave/run-run-one/review"}' }],
  });
  expect(collect([request(LOCAL_BRANCH_OUTPUT, { branch: "main" })])).toEqual({ ok: false });
  expect(collect([request(LOCAL_BRANCH_OUTPUT, { commit: "HEAD" })])).toEqual({ ok: false });
});

it("refuses unknown effects, alternate owners, malformed kinds and duplicate requests", () => {
  for (const bad of [
    request(OTHER, {}),
    request({ ...UPLOAD, ownerId: "other" }, { destination: "reports", path: "report.md" }),
    request(UPLOAD, { destination: "reports", path: "../report.md" }),
    request(UPLOAD, { destination: "reports", path: "drafts\\report.md" }),
    request(UPLOAD, { destination: "reports", path: "report.md", overwrite: true }),
    request(SEND, { recipient: "Team" }),
    request(SEND, { recipient: "Team\nAdmin", text: "Draft ready" }),
    request(POST, { destination: "Posts", text: { nested: "body" } }),
    request(WRITE, { target: "Notes", data: "x".repeat(32 * 1024) }),
  ]) {
    expect(collect([bad])).toEqual({ ok: false });
  }
  expect(collect([request(LOCAL_BRANCH_OUTPUT, {}, "first"), request(LOCAL_BRANCH_OUTPUT, {}, "second")])).toEqual({ ok: false });
  expect(collect([request(LOCAL_BRANCH_OUTPUT, {}), request(UPLOAD, { destination: "reports", path: "report.md" })])).toEqual({ ok: false });
  expect(collectRequestedOutputs({ ...STAGE, envelope: { ...ENVELOPE, outputs: [] } }, "run-one", JSON.stringify({
    result: "Result", requestedOutputs: [request(SEND, { recipient: "Team", text: "Draft ready" })],
  }))).toEqual({ ok: false });
});
