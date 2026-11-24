import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
useConfigurationOwner();
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPermissionSettings, setReviewerSettingsPersist, writePermissionSettings } from "../permission-settings-store.js";
import { dispatchPermissionDirCommand, dispatchPermissionReviewerCommand, dispatchPermissionReviewerCommandWithRewire } from "../permission-slash.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(async () => { await resources.cleanup(); });

describe("reviewer mode validation", () => {
  it.each(["strict", "rule", "unknown", 42, null, true])("reports a stored invalid mode %j without losing readable settings or rewriting policy", async mode => {
    const directory = resources.makeTmpDir("reviewer-modes-");
    const path = join(directory, "settings.json");
    const original = JSON.stringify({ permissions: { additionalDirectories: [directory], reviewer: { mode, fallbackOnError: "rule" } }, unrelated: true });
    writeFileSync(path, original);
    const read = readPermissionSettings(path);
    expect(read.fault).toEqual({ kind: "reviewer-mode-invalid", filePath: path, detail: "Permission reviewer mode must be llm or disabled." });
    expect(read.permissions.additionalDirectories).toEqual([directory]);
    expect(read.permissions.reviewer).toEqual({ mode: "disabled", fallbackOnError: "rule" });
    expect(await dispatchPermissionReviewerCommand({ verb: "show", value: "" }, path)).toMatchObject({ ok: true, fault: { kind: "reviewer-mode-invalid" } });
    expect(await dispatchPermissionDirCommand({ verb: "list", path: "", session: false, acknowledgeWarnings: false }, path)).toMatchObject({ ok: true, userAdditions: [directory] });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["disabled", "llm"] as const)("repairs the fault only after an explicit supported %s choice", async mode => {
    const directory = resources.makeTmpDir("reviewer-modes-");
    const path = join(directory, "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { additionalDirectories: [directory], reviewer: { mode: "retired", fallbackOnError: "rule" } }, unrelated: true }));
    await setReviewerSettingsPersist({ mode }, path);
    expect(readPermissionSettings(path).fault).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ permissions: { additionalDirectories: [directory], reviewer: { mode, fallbackOnError: "rule" } }, unrelated: true });
  });

  it("preserves an invalid reviewer value through unrelated directory saves", async () => {
    const directory = resources.makeTmpDir("reviewer-modes-");
    const path = join(directory, "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { reviewer: { mode: "strict", fallbackOnError: "deny" } }, unrelated: true }));
    await writePermissionSettings({ additionalDirectories: [directory] }, path);
    expect(readPermissionSettings(path).fault?.kind).toBe("reviewer-mode-invalid");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ permissions: { additionalDirectories: [directory], reviewer: { mode: "strict" } }, unrelated: true });
    await expect(setReviewerSettingsPersist({ fallbackOnError: "rule" }, path)).rejects.toThrow("Choose llm or disabled");
  });

  it("does not persist an unrequested mode rollback when explicit recovery cannot rewire", async () => {
    const path = join(resources.makeTmpDir("reviewer-modes-"), "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { reviewer: { mode: "strict", fallbackOnError: "deny" } }, unrelated: true }));
    const result = await dispatchPermissionReviewerCommandWithRewire({ verb: "mode", value: "llm" }, () => { throw new Error("Review remains unavailable"); }, path);
    expect(result).toEqual({ ok: false, error: "reviewer-rewire-failed: Review remains unavailable" });
    expect(readPermissionSettings(path).fault).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ permissions: { reviewer: { mode: "llm" } }, unrelated: true });
  });

  it.each(["strict", "rule", "unknown"])("rejects saving the unsupported %s mode", async mode => {
    const path = join(resources.makeTmpDir("reviewer-modes-"), "settings.json");
    await expect(setReviewerSettingsPersist({ mode } as never, path)).rejects.toThrow("permissions.reviewer.mode invalid");
  });
});
