/**
 * Receipt schema v4 — git installs (design §6.2). A git install has no
 * signer and no admission; it records the pinned or tree hash and the plan
 * (source, the two bound commits, every rung outcome). Signed and local
 * installs keep writing v3.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGitInstallReceipt,
  buildInstallReceipt,
  gitInstallRecordProblem,
  restoreInstallReceiptRaw,
  verifyInstallReceiptRaw,
  type GitInstallRecord,
} from "../plugin-install-receipt.js";
import { verifyPluginIntegrity } from "../runtime/index.js";
import { canonicalJSON } from "../secret-access/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

const SNAPSHOT = "a".repeat(40);
const VERSION_COMMIT = "b".repeat(40);
const DIGEST = "c".repeat(64);

const record = (patch: Partial<GitInstallRecord> = {}): GitInstallRecord => ({
  sourceId: "acme",
  sourceOrigin: "custom",
  snapshotCommit: SNAPSHOT,
  versionCommit: VERSION_COMMIT,
  packagePath: "plugins/alpha",
  rung: "archive",
  rungs: [
    { rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE", message: "HTTP 404" },
    { rung: "archive", outcome: "used" },
  ],
  ...patch,
});

describe("git install receipts (schema v4)", () => {
  let root: string;
  let pluginRoot: string;
  let cacheRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ave-git-receipt-"));
    pluginRoot = join(root, "plugins", "alpha");
    cacheRoot = join(root, "cache");
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    await writeFile(join(pluginRoot, "plugin.json"), "{}\n");
    await writeFile(join(pluginRoot, "dist", "index.js"), "export {};\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function built(git = record()) {
    return buildGitInstallReceipt(pluginRoot, { pluginId: "alpha", version: "1.0.0", artifactSha256: DIGEST, git, files: ["plugin.json", "dist/index.js"] });
  }

  it("round-trips through verification and reaches the load gate as a git install", async () => {
    const { receipt, raw } = await built();
    expect(receipt.reviewedAppVersion).toBeUndefined();
    expect(receipt).toMatchObject({ schemaVersion: 4, installSource: "git", signerKeyId: null, admission: null, artifactSha256: DIGEST, git: record() });
    await expect(verifyInstallReceiptRaw(raw, "alpha", pluginRoot)).resolves.toEqual({ ok: true, receipt });

    await restoreInstallReceiptRaw(cacheRoot, "alpha", raw);
    await expect(verifyPluginIntegrity(cacheRoot, "alpha", pluginRoot)).resolves.toEqual({
      ok: true,
      verified: { installSource: "git", artifactSha256: DIGEST, signerKeyId: null, rung: "archive" },
    });
  });

  it("binds the reviewed filesystem authority to a running git manifest", async () => {
    const authority = { capabilities: [], sandbox: { write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }] } };
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
      name: "alpha",
      extensions: { "ai.agent-connector.ave": authority },
    }));
    const digest = sha256Hex(canonicalJSON(authority));
    const { raw } = await built(record({ authoritySha256: digest }));
    await restoreInstallReceiptRaw(cacheRoot, "alpha", raw);
    await expect(verifyPluginIntegrity(cacheRoot, "alpha", pluginRoot)).resolves.toMatchObject({ ok: true });

    const { raw: mismatched } = await built(record({ authoritySha256: "d".repeat(64) }));
    await restoreInstallReceiptRaw(cacheRoot, "alpha", mismatched);
    await expect(verifyPluginIntegrity(cacheRoot, "alpha", pluginRoot)).resolves.toEqual({
      ok: false,
      reason: "plugin authority differs from install review",
    });

    const { raw: unreviewed } = await built();
    await restoreInstallReceiptRaw(cacheRoot, "alpha", unreviewed);
    await expect(verifyPluginIntegrity(cacheRoot, "alpha", pluginRoot)).resolves.toEqual({
      ok: false,
      reason: "sandbox authority has no install review evidence",
    });
  });

  it("records the reviewed app version only when the caller supplies consent evidence", async () => {
    const { receipt, raw } = await buildGitInstallReceipt(pluginRoot, {
      pluginId: "alpha", version: "1.0.0", artifactSha256: DIGEST,
      git: record(), files: ["plugin.json", "dist/index.js"], reviewedAppVersion: "0.12.0",
    });
    expect(receipt.reviewedAppVersion).toBe("0.12.0");
    await expect(verifyInstallReceiptRaw(raw, "alpha", pluginRoot)).resolves.toEqual({ ok: true, receipt });
  });

  it("rejects malformed review versions in a receipt", async () => {
    const { raw } = await built();
    const receipt = JSON.parse(raw) as Record<string, unknown>;
    receipt.reviewedAppVersion = "0.12.0 forged";
    await expect(verifyInstallReceiptRaw(JSON.stringify(receipt), "alpha", pluginRoot))
      .resolves.toMatchObject({ ok: false, reason: "invalid reviewed app version in install receipt" });
  });

  it("still writes v3 for signed and local installs", async () => {
    const { receipt } = await buildInstallReceipt(pluginRoot, {
      pluginId: "alpha",
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: DIGEST,
      signerKeyId: "key-1",
      files: ["plugin.json"],
    });
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt).not.toHaveProperty("git");
  });

  it.each([
    ["a signer", (value: Record<string, unknown>) => ({ ...value, signerKeyId: "key-1" }), "must not carry a signer"],
    ["an admission", (value: Record<string, unknown>) => ({ ...value, admission: { issuedAt: "x", documentSha256: DIGEST, publisher: "p" } }), "must not carry a signer"],
    ["another install source", (value: Record<string, unknown>) => ({ ...value, installSource: "marketplace" }), "invalid receipt installSource"],
    ["a short digest", (value: Record<string, unknown>) => ({ ...value, artifactSha256: "abc" }), "invalid artifactSha256"],
    ["no git record", (value: Record<string, unknown>) => ({ ...value, git: undefined }), "git record is not an object"],
  ])("refuses a v4 receipt with %s", async (_label, mutate, reason) => {
    const { raw } = await built();
    const tampered = JSON.stringify(mutate(JSON.parse(raw) as Record<string, unknown>));
    const result = await verifyInstallReceiptRaw(tampered, "alpha", pluginRoot);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain(reason);
  });

  it.each([
    ["rungs out of ladder order", record({ rungs: [{ rung: "archive", outcome: "used" }] }), "out of ladder order"],
    ["a used rung other than the recorded one", record({ rung: "release" }), "used rung is invalid"],
    ["a rung after the used one", record({ rung: "release", rungs: [{ rung: "release", outcome: "used" }, { rung: "archive", outcome: "skipped", reason: "NOT_DECLARED" }] }), "used rung is invalid"],
    ["no used rung", record({ rungs: [{ rung: "release", outcome: "skipped", reason: "NOT_DECLARED" }] }), "must end with the used rung"],
    ["an unknown skip reason", record({ rungs: [{ rung: "release", outcome: "skipped", reason: "LATER" as "NOT_DECLARED" }, { rung: "archive", outcome: "used" }] }), "skipped rung is invalid"],
    ["an unknown origin", record({ sourceOrigin: "admin" as "custom" }), "sourceOrigin is invalid"],
    ["a short commit", record({ versionCommit: "abc" }), "versionCommit is invalid"],
    ["an extra field", { ...record(), extra: 1 } as GitInstallRecord, "unknown fields"],
  ])("refuses a git record with %s", async (_label, git, problem) => {
    expect(gitInstallRecordProblem(git)).toContain(problem);
    await expect(built(git)).rejects.toThrow(problem);
  });
});
