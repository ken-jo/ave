import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as homeTrust from "../../shared/ave-home-trust.js";
import * as rewrite from "../storage/rewrite-keeping-bytes.js";
import { WorkflowRunStore } from "../workflow-run-store.js";

let dir: string;
let store: WorkflowRunStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "unknown-run-")); store = new WorkflowRunStore(join(dir, "runs.json")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const first = { itemId: 1, runId: "first-run" };
const second = { itemId: 2, runId: "second-run" };
async function memoryOnly(intent = first): Promise<void> {
  const write = vi.spyOn(rewrite, "rewriteKeepingBytes").mockRejectedValue(new Error("write refused"));
  await store.markUnknown(intent);
  write.mockRestore();
}

it.each(["initial read", "readback"] as const)("keeps memory unknowns after a failed %s until a confirmed resolution", async failure => {
  await memoryOnly();
  const write = vi.spyOn(rewrite, "rewriteKeepingBytes").mockRejectedValue(new Error("write refused"));
  const read = homeTrust.readAveHomeInput;
  let calls = 0;
  const spy = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
    calls += 1;
    if (calls === (failure === "initial read" ? 1 : 2)) throw Object.assign(new Error("read refused"), { code: "EIO" });
    return read(path);
  });
  const landed = vi.fn(() => true);
  await store.resolveUnknown(landed);
  expect(await store.hasUnknown()).toBe(true);
  if (failure === "initial read") expect(landed).not.toHaveBeenCalled();
  spy.mockRestore();
  write.mockRestore();
  await store.resolveUnknown(() => true);
  expect(await store.hasUnknown()).toBe(false);
});

it("keeps a memory unknown added after the resolution snapshot", async () => {
  await memoryOnly();
  const write = vi.spyOn(rewrite, "rewriteKeepingBytes").mockRejectedValue(new Error("write refused"));
  let added: Promise<void> | undefined;
  await store.resolveUnknown(() => { added = store.markUnknown(second); return true; });
  await added;
  write.mockRestore();
  const facts = await store.runFacts();
  expect(facts?.of(first)).toMatchObject({ readable: true, unknown: false });
  expect(facts?.of(second)).toMatchObject({ readable: true, unknown: true });
  await store.resolveUnknown(() => true);
  expect(await store.hasUnknown()).toBe(false);
});

it("keeps a reopened durable marker in memory until its resolution readback succeeds", async () => {
  const pin = { templateId: "template", version: 1, graphHash: "a".repeat(64) };
  await store.put({ ...first, pin, runStartedBy: { kind: "local-create-and-run", pin }, startedAt: "2026-01-01T00:00:00.000Z", stageRuns: [] });
  await store.markUnknown(first);
  store = new WorkflowRunStore(join(dir, "runs.json"));
  const read = homeTrust.readAveHomeInput;
  const write = rewrite.rewriteKeepingBytes;
  let failReadback = false;
  const writing = vi.spyOn(rewrite, "rewriteKeepingBytes").mockImplementation(async (...args) => {
    const result = await write(...args);
    failReadback = true;
    return result;
  });
  const reading = vi.spyOn(homeTrust, "readAveHomeInput").mockImplementation(async path => {
    if (failReadback) { failReadback = false; throw Object.assign(new Error("readback refused"), { code: "EIO" }); }
    return read(path);
  });
  await store.resolveUnknown(() => true);
  expect(await store.hasUnknown()).toBe(true);
  writing.mockRestore();
  reading.mockRestore();
  await store.resolveUnknown(() => true);
  expect(await store.hasUnknown()).toBe(false);
});
