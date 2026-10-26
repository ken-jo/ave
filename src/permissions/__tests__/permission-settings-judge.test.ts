import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirFile } from "../../__tests__/test-helpers.js";
import { judgeModelCatalogFrom } from "../judge/judge-model-catalog.js";
import { readJudgeSettings, readPermissionSettings, setJudgeSettingsPersist } from "../permission-settings-store.js";

const fixture = useTempDirFile("ave-judge-settings-", "settings.json");
const readFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (readFailure.path === String(args[0])) throw Object.assign(new Error("Settings read denied"), { code: "EACCES" });
      return Reflect.apply(actual.readFileSync, undefined, args);
    },
  };
});
afterEach(() => { readFailure.path = undefined; });

describe("judge settings persistence", () => {
  it("starts disabled and defaults a configured chain to shadow", async () => {
    const { path } = fixture();
    expect(readJudgeSettings(path).settings.chain).toEqual([]);
    const { settings: configured } = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm", id: "review" }] }, path);
    expect(configured.mode).toBe("shadow");
    expect(readJudgeSettings(path).settings).toEqual(configured);
  });

  it("preserves unrelated settings and merges categories with fixed breaker thresholds", async () => {
    const { path } = fixture();
    const original = { theme: "dark", permissions: { allow: ["Read(*)"], reviewer: { model: "saved" } } };
    writeFileSync(path, JSON.stringify(original));
    await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }], mode: "active" }, path);
    const { settings: updated } = await setJudgeSettingsPersist({ categories: { network: true }, breaker: { consecutive: 3 } }, path);
    expect(updated.categories).toEqual({ shell: true, write: true, network: true });
    expect(updated.breaker).toEqual({ consecutive: 3, total: 20 });
    expect(updated.mode).toBe("active");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(original);
    const saved = readFileSync(path, "utf8");
    await expect(setJudgeSettingsPersist({ breaker: { consecutive: 4 } }, path)).rejects.toThrow("3 consecutive or 20 total");
    expect(readFileSync(path, "utf8")).toBe(saved);
  });

  it("round-trips a configured model containing slashes with the live catalog", async () => {
    const { path } = fixture();
    const catalog = judgeModelCatalogFrom({ vendors: { "openai-compatible": { model: "team/model", baseUrl: "http://localhost:8000/v1" } } });
    const { settings } = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm", model: "openai-compatible/team/model" }] }, path, catalog);
    expect(settings.chain[0]?.model).toEqual({ vendor: "openai-compatible", model: "team/model" });
    expect(readFileSync(path, "utf8")).toContain('"model": "openai-compatible/team/model"');
    expect(readJudgeSettings(path, catalog).settings).toEqual(settings);
  });

  it("persists the reviewer model and its unset state explicitly", async () => {
    const { path } = fixture();
    const catalog = judgeModelCatalogFrom({ vendors: { "openai-compatible": { model: "team/reviewer", baseUrl: "http://localhost:8000/v1" } } });
    const picked = await setJudgeSettingsPersist({ model: "openai-compatible/team/reviewer" }, path, catalog);
    expect(picked.settings.model).toEqual({ vendor: "openai-compatible", model: "team/reviewer" });
    await setJudgeSettingsPersist({ model: null }, path, catalog);
    expect(JSON.parse(readFileSync(path, "utf8")).permissions.judge.model).toBeNull();
  });

  it("keeps an unavailable reviewer model through a save that does not replace it", async () => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify({ permissions: { judge: { model: "claude/removed-model" } } }));
    expect(readJudgeSettings(path)).toMatchObject({ modelRejected: true, settings: { model: null } });
    await setJudgeSettingsPersist({ mode: "active" }, path);
    const saved = JSON.parse(readFileSync(path, "utf8")).permissions.judge;
    expect(saved).toMatchObject({ model: "claude/removed-model", mode: "active" });
    expect(readJudgeSettings(path)).toMatchObject({ modelRejected: true });
    await setJudgeSettingsPersist({ model: null }, path);
    expect(readJudgeSettings(path)).not.toHaveProperty("modelRejected");
  });

  it("keeps a rejected chain through a save that does not replace it, never turning it off", async () => {
    const { path } = fixture();
    const rejected = [{ provider: "external" }];
    writeFileSync(path, JSON.stringify({ permissions: { judge: { chain: rejected, mode: "active" } } }));
    expect(readJudgeSettings(path)).toMatchObject({ chainRejected: true });
    await setJudgeSettingsPersist({ categories: { network: true } }, path);
    const saved = JSON.parse(readFileSync(path, "utf8")).permissions.judge;
    expect(saved).toMatchObject({ chain: rejected, mode: "active", categories: { network: true } });
    expect(readJudgeSettings(path)).toMatchObject({ chainRejected: true });
    await setJudgeSettingsPersist({ chain: [] }, path);
    expect(readJudgeSettings(path)).not.toHaveProperty("chainRejected");
  });

  it("rejects invalid updates without altering bytes", async () => {
    const { path } = fixture();
    await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }] }, path);
    const before = readFileSync(path, "utf8");
    await expect(setJudgeSettingsPersist({ chain: [{ provider: "external", external: { command: ["relative"] } }] }, path)).rejects.toThrow(/absolute/);
    await expect(setJudgeSettingsPersist({ unexpected: true }, path)).rejects.toThrow(/unknown/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("reports malformed input and refuses to overwrite damaged documents", async () => {
    const { path } = fixture();
    writeFileSync(path, "{broken");
    expect(readJudgeSettings(path).issues).not.toEqual([]);
    expect(readJudgeSettings(path).settings.chain).toEqual([]);
    await expect(setJudgeSettingsPersist({ chain: [] }, path)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("{broken");
    writeFileSync(path, JSON.stringify({ permissions: { judge: { provider: "invalid" } } }));
    expect(readJudgeSettings(path).issues[0]).toContain("provider invalid");
  });

  it("serializes concurrent patches without losing a prior mutation", async () => {
    const { path } = fixture();
    await Promise.all([
      setJudgeSettingsPersist({ categories: { network: true } }, path),
      setJudgeSettingsPersist({ timeoutMs: 20_000 }, path),
    ]);
    expect(readJudgeSettings(path).settings).toMatchObject({ categories: { network: true }, timeoutMs: 20_000 });
  });

  it("carries host chain rejection without confusing explicit off or other warnings", () => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify({ permissions: { judge: { chain: [{ provider: "external" }], mode: "active" } } }));
    expect(readJudgeSettings(path)).toMatchObject({ settings: { chain: [], mode: "active" }, chainRejected: true });
    writeFileSync(path, JSON.stringify({ permissions: { judge: { chain: [], mode: "active" } } }));
    expect(readJudgeSettings(path)).not.toHaveProperty("chainRejected");
    writeFileSync(path, JSON.stringify({ permissions: { judge: { chain: [{ provider: "builtin-llm" }], timeoutMs: 1 } } }));
    expect(readJudgeSettings(path).issues).not.toEqual([]);
    expect(readJudgeSettings(path)).not.toHaveProperty("chainRejected");
  });

  it("restores an exact rejected active chain while preserving unrelated later edits", async () => {
    const { path } = fixture();
    const rejected = { mode: "active", chain: [{ provider: "external", id: "missing-transport" }], timeoutMs: 999 };
    writeFileSync(path, JSON.stringify({ appearance: "dark", permissions: { judge: rejected, allow: ["Read(*)"] } }));
    const receipt = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }] }, path);
    const latest = JSON.parse(readFileSync(path, "utf8"));
    latest.appearance = "light";
    latest.permissions.additionalDirectories = ["/workspace/added"];
    writeFileSync(path, JSON.stringify(latest));
    await receipt.rollback();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      appearance: "light", permissions: { judge: rejected, allow: ["Read(*)"], additionalDirectories: ["/workspace/added"] },
    });
    expect(readJudgeSettings(path)).toMatchObject({ settings: { mode: "active" }, chainRejected: true });
  });

  it.each([
    { permissions: { judge: { provider: "off", mode: "active" } } },
    { permissions: {} },
    { appearance: "dark" },
  ])("restores explicit off or missing subtree exactly for %j", async (original) => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify(original));
    const receipt = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }] }, path);
    await receipt.rollback();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
  });

  it("retains permission keys added after an initially missing container", async () => {
    const { path } = fixture();
    writeFileSync(path, "{}");
    const receipt = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }] }, path);
    const latest = JSON.parse(readFileSync(path, "utf8"));
    latest.permissions.additionalDirectories = ["/workspace/added"];
    writeFileSync(path, JSON.stringify(latest));
    await receipt.rollback();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permissions: { additionalDirectories: ["/workspace/added"] } });
  });

  it("refuses rollback when another writer changed the judge subtree", async () => {
    const { path } = fixture();
    const receipt = await setJudgeSettingsPersist({ chain: [{ provider: "builtin-llm" }] }, path);
    const changed = { permissions: { judge: { provider: "off" }, additionalDirectories: ["/workspace/added"] } };
    writeFileSync(path, JSON.stringify(changed));
    await expect(receipt.rollback()).rejects.toThrow("Judge settings changed before rollback");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(changed);
  });

  it.each(["", " \n\t ", "{broken", "null", "[]", '"text"', "42", "false"])("marks fatal document content as unreadable for %j", (content) => {
    const { path } = fixture();
    writeFileSync(path, content);
    const result = readJudgeSettings(path);
    expect(result).toMatchObject({ settings: { chain: [], mode: "shadow" }, unreadable: true });
    expect(result.issues).not.toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it.each([{ permissions: null }, { permissions: [] }, { permissions: "text" }, { permissions: 42 }, { permissions: false }])("marks a malformed permissions container unreadable for %j", ({ permissions }) => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify({ permissions }));
    expect(readJudgeSettings(path)).toMatchObject({ unreadable: true });
  });

  it("retains empty placeholder handling for other permission settings readers", () => {
    const { path } = fixture();
    for (const content of ["", " \n\t "]) {
      writeFileSync(path, content);
      expect(readPermissionSettings(path).permissions.additionalDirectories).toEqual([]);
      expect(readPermissionSettings(path).fault).toBeNull();
      expect(readJudgeSettings(path)).toHaveProperty("unreadable", true);
    }
  });

  it("marks a directory and a denied file read unreadable", () => {
    const { path: directory } = fixture();
    mkdirSync(directory);
    expect(readJudgeSettings(directory)).toMatchObject({ unreadable: true });
    const { path } = fixture();
    writeFileSync(path, "{}");
    readFailure.path = path;
    expect(readJudgeSettings(path)).toMatchObject({ unreadable: true });
  });

  it("keeps absent files and blocks valid off without fatal read metadata", () => {
    const { path } = fixture();
    expect(readJudgeSettings(path)).not.toHaveProperty("unreadable");
    for (const document of [{}, { permissions: {} }, { permissions: { judge: { provider: "off" } } }]) {
      writeFileSync(path, JSON.stringify(document));
      const result = readJudgeSettings(path);
      expect(result.settings.chain).toEqual([]);
      expect(result).not.toHaveProperty("unreadable");
      expect(result).not.toHaveProperty("chainRejected");
    }
  });

  it("keeps parsed-chain rejection and ordinary warnings separate from fatal reads", () => {
    const { path } = fixture();
    for (const judge of [{ chain: [{ provider: "external" }], mode: "active" }, { chain: [], mode: "active", timeoutMs: 1 }]) {
      writeFileSync(path, JSON.stringify({ permissions: { judge } }));
      const result = readJudgeSettings(path);
      expect(result.settings.mode).toBe("active");
      expect(result.issues).not.toEqual([]);
      expect(result).not.toHaveProperty("unreadable");
    }
  });
});
