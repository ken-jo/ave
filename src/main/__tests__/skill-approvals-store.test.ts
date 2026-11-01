import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
// Approval is bound to the body hash; replacing an approved file must require approval again.
import { describe, it, expect } from "vitest";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SkillApprovalsStore, hashSkillMaterial } from "../skill-approvals-store.js";
import { useTempPaths } from "../../__tests__/test-helpers.js";
import { observeFileHandleSyncs } from "../../__tests__/support/fsync-observer.js";

const tmpFile = useTempPaths("ave-skill-approvals-", "skill-approvals.json");

describe("SkillApprovalsStore — R2-CR-3 hash-binding", () => {
  it("approve(name, body) → isApproved(name, body) returns true for the same body", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v1")).toBe(true);
  });

  it("isApproved returns FALSE when the body has been swapped post-approval", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    // Same name, different body — TOCTOU bypass scenario. Must re-prompt.
    expect(await store.isApproved("report-writing", "body-v2-malicious")).toBe(
      false,
    );
  });

  it("re-approve after body swap rebinds the hash so subsequent isApproved succeeds", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v2")).toBe(false);
    await store.approve("report-writing", "body-v2");
    expect(await store.isApproved("report-writing", "body-v2")).toBe(true);
    // The previous body is no longer approved.
    expect(await store.isApproved("report-writing", "body-v1")).toBe(false);
  });

  it("treats v1-format files (string array) as un-approved (force re-prompt on migration)", async () => {
    const file = tmpFile();
    // Synthesize a v1 record on disk.
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        approvedSkills: ["report-writing"],
        approvedAt: { "report-writing": "2026-01-01T00:00:00.000Z" },
      }),
      "utf-8",
    );
    const store = new SkillApprovalsStore(file);
    // v1 records have no sha256 → must force re-prompt regardless of body.
    expect(await store.isApproved("report-writing", "anything")).toBe(false);
  });

  it("treats v2 records missing sha256 as un-approved (defense in depth)", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        approvedSkills: [
          { name: "report-writing", approvedAt: "2026-01-01T00:00:00.000Z" },
          // Note: no sha256 field.
        ],
      }),
      "utf-8",
    );
    const store = new SkillApprovalsStore(file);
    expect(await store.isApproved("report-writing", "anything")).toBe(false);
  });

  it("persists v2 schema with sha256 and approvedAt on approve()", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "hello body");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as {
      version: number;
      approvedSkills: Array<{ name: string; sha256: string; approvedAt: string }>;
    };
    expect(onDisk.version).toBe(2);
    expect(onDisk.approvedSkills).toHaveLength(1);
    expect(onDisk.approvedSkills[0].name).toBe("report-writing");
    expect(onDisk.approvedSkills[0].sha256).toBe(hashSkillMaterial("hello body"));
    expect(typeof onDisk.approvedSkills[0].approvedAt).toBe("string");
  });
});

describe("SkillApprovalsStore — atomic-write convergence (feature-namespace authority)", () => {
  it.skipIf(!canCreateSymlinks())("does not write through a symlink planted at the predictable ${file}.tmp staging path", async () => {
    // Random O_EXCL staging must ignore an attacker-planted fixed .tmp symlink.
    const file = tmpFile();
    const outside = join(join(file, ".."), "attacker-owned.json");
    writeFileSync(outside, "");
    symlinkSync(outside, `${file}.tmp`);

    const store = new SkillApprovalsStore(file);
    await store.approve("report-writing", "body-v1");

    // Assert the outside target stays empty and the live file contains the record; these reads detect redirected writes without lstat/read races.
    expect(readFileSync(outside, "utf-8")).toBe("");
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as {
      approvedSkills: Array<{ name: string; sha256: string }>;
    };
    expect(onDisk.approvedSkills[0].name).toBe("report-writing");
    expect(onDisk.approvedSkills[0].sha256).toBe(hashSkillMaterial("body-v1"));
  });

  it("fsyncs the staged bytes before commit (durability the store's comment claims)", async () => {
    // Assert staging-file sync before rename: rename alone does not make bytes crash-durable.
    const file = tmpFile();
    const observer = observeFileHandleSyncs();
    try {
      const store = new SkillApprovalsStore(file);
      await store.approve("report-writing", "body-v1");
    } finally {
      observer.restore();
    }
    expect(existsSync(file)).toBe(true);
    expect(observer.calls()).toBeGreaterThanOrEqual(1);
  });
});

describe("SkillApprovalsStore — corrupt file recovery", () => {
  it("preserves existing grants when a final commit guard rejects a new approval", async () => {
    const file = tmpFile();
    const store = new SkillApprovalsStore(file);
    await store.approve("previous", "body");
    await expect(store.approve("new-skill", "body", () => false)).rejects.toThrow("Skill approval authority is unavailable");
    const reloaded = new SkillApprovalsStore(file);
    expect(await reloaded.isApproved("previous", "body")).toBe(true);
    expect(await reloaded.isApproved("new-skill", "body")).toBe(false);
  });
  it("backs up corrupt JSON as .corrupt-<ts>-<random>.bak and starts empty", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ this is not json", "utf-8");
    const store = new SkillApprovalsStore(file);

    expect(await store.isApproved("report-writing", "body-v1")).toBe(false);
    await store.approve("report-writing", "body-v1");
    expect(await store.isApproved("report-writing", "body-v1")).toBe(true);

    const backups = readdirSync(dirname(file)).filter((f) => /\.corrupt-\d+-[0-9a-f]{8}\.bak$/.test(f));
    expect(backups).toHaveLength(1);
  });
});
