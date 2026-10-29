import { describe, expect, it, vi } from "vitest";
import { RecentlyDeniedStore } from "../reviewer/recently-denied.js";
import type { FeatureNamespaceHandle } from "../../main/storage/feature-namespace.js";

function storage() {
  let saved: unknown = [];
  return {
    namespace: {
      readJson: vi.fn(async () => structuredClone(saved)),
      writeJson: vi.fn(async (_name: string, value: unknown) => { saved = structuredClone(value); }),
    } as unknown as FeatureNamespaceHandle,
    saved: () => saved,
  };
}
const SAMPLE = { toolName: "write_file", source: "builtin" as const, category: "write" as const, inputSummary: '{"password":"private-value"}', reason: "Denied" };

describe("recent denial history", () => {
  it("persists redacted display fields without replay authority", async () => {
    const fixture = storage();
    const store = new RecentlyDeniedStore(fixture.namespace);
    const execute = vi.fn(async () => undefined);
    await store.append({ ...SAMPLE, rerun: execute });
    expect(JSON.stringify(fixture.saved())).not.toContain("private-value");
    expect(fixture.saved()).toEqual([expect.objectContaining({ reason: "Denied" })]);
    expect(Object.keys((fixture.saved() as object[])[0])).not.toContain("rerun");
    expect((await store.list())[0].rerunAvailable).toBe(true);
    const restarted = new RecentlyDeniedStore(fixture.namespace);
    expect((await restarted.list())[0].rerunAvailable).toBe(false);
    expect(await restarted.rerun((await store.list())[0].id)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("consumes the live executor closure once and never stores its result", async () => {
    const fixture = storage();
    const store = new RecentlyDeniedStore(fixture.namespace);
    const execute = vi.fn(async () => ({ decision: "allow" }));
    const id = await store.append({ ...SAMPLE, rerun: execute });
    expect(await store.rerun(id)).toEqual({ ok: true });
    expect(await store.rerun(id)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.saved())).not.toContain("allow");
  });
  it("caps records, summaries and live closures together", async () => {
    const fixture = storage();
    const store = new RecentlyDeniedStore(fixture.namespace);
    const execute = vi.fn(async () => undefined);
    const first = await store.append({ ...SAMPLE, rerun: execute });
    await Promise.all(Array.from({ length: 105 }, () => store.append({ ...SAMPLE, inputSummary: "x".repeat(5000), rerun: execute })));
    const records = await store.list();
    expect(records).toHaveLength(100);
    expect(records.every((row) => row.inputSummary.length <= 2048)).toBe(true);
    expect(await store.rerun(first)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(fixture.saved()).toHaveLength(100);
  });
  it("rejects concurrent reruns and reports failed execution without restoring authority", async () => {
    const fixture = storage();
    const store = new RecentlyDeniedStore(fixture.namespace);
    let release!: () => void;
    const execute = () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error("failed")); });
    const id = await store.append({ ...SAMPLE, rerun: execute });
    const first = store.rerun(id);
    expect(await store.rerun(id)).toEqual({ ok: false, error: "rerun-in-progress" });
    release();
    expect(await first).toEqual({ ok: false, error: "rerun-failed" });
    expect((await store.list())[0].rerunAvailable).toBe(false);
  });
  it("shares hydration when a list overlaps the first append", async () => {
    const fixture = storage();
    let release!: (value: unknown) => void;
    const loaded = new Promise<unknown>((resolve) => { release = resolve; });
    const readJson = vi.fn(async () => loaded);
    const namespace = { ...fixture.namespace, readJson } as FeatureNamespaceHandle;
    const store = new RecentlyDeniedStore(namespace);
    const listing = store.list();
    const appending = store.append(SAMPLE);
    await Promise.resolve();
    release([]);
    await Promise.all([listing, appending]);
    expect(readJson).toHaveBeenCalledOnce();
    expect(await store.list()).toHaveLength(1);
    expect(fixture.saved()).toHaveLength(1);
  });
  it("ignores legacy queue records and cannot hydrate callbacks or grants", async () => {
    const namespace = { readJson: vi.fn(async () => [{ id: "old", status: "approved", grant: { path: "/" } }]) } as unknown as FeatureNamespaceHandle;
    expect(await new RecentlyDeniedStore(namespace).list()).toEqual([]);
    expect(namespace.readJson).toHaveBeenCalledWith("recently-denied.json", []);
  });
});
