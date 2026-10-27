/**
 * Publisher verification against the real platform verifiers and Anthropic's real release artifacts, with no mocks. The macOS and Linux CI jobs download
 * a pinned official release (checked against a pinned SHA-256) and set AVE_REQUIRE_PUBLISHER_FIXTURES=1, which turns a missing fixture into a failure.
 * Elsewhere each block runs only on its platform and when its fixture is supplied:
 * - macOS: AVE_CLAUDE_CODE_RELEASE_BINARY is the official darwin build, read as data and never executed.
 * - Linux: AVE_CLAUDE_CODE_RELEASE_METADATA is a directory holding the release key (claude-code.asc), manifest.json and manifest.json.sig.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateClaudeCodeExecutable, ClaudeCodeAuthenticityError, verifyClaudeCodeReleaseManifest,
} from "../claude-code-authenticity.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

const REQUIRED = process.env.AVE_REQUIRE_PUBLISHER_FIXTURES === "1";
const RELEASE_BINARY = process.env.AVE_CLAUDE_CODE_RELEASE_BINARY;
const RELEASE_METADATA = process.env.AVE_CLAUDE_CODE_RELEASE_METADATA;

if (REQUIRED && process.platform === "darwin" && !RELEASE_BINARY) {
  throw new Error("AVE_REQUIRE_PUBLISHER_FIXTURES=1 but AVE_CLAUDE_CODE_RELEASE_BINARY names no official macOS release");
}
if (REQUIRED && process.platform === "linux" && !RELEASE_METADATA) {
  throw new Error("AVE_REQUIRE_PUBLISHER_FIXTURES=1 but AVE_CLAUDE_CODE_RELEASE_METADATA names no official release metadata");
}

const roots: string[] = [];
async function privateRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "ave-publisher-native-"));
  roots.push(root);
  return root;
}
async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}
// macOS admission never fetches release metadata; any request is a failure of the contract under test.
const noNetwork = (async () => { throw new Error("macOS publisher verification made a network request"); }) as unknown as typeof fetch;

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin" && RELEASE_BINARY)("real codesign against the pinned Developer ID requirement", () => {
  async function copyOfRelease(): Promise<string> {
    const copy = join(await privateRoot(), "runtime");
    await fs.copyFile(RELEASE_BINARY!, copy);
    await fs.chmod(copy, 0o700);
    return copy;
  }

  it("admits Anthropic's genuinely Developer ID-signed release", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const copy = await copyOfRelease();
    await expect(authenticateClaudeCodeExecutable(copy, copy, await sha256(copy), "darwin", process.arch, noNetwork)).resolves.toBeUndefined();
  });

  it("refuses the same release after an ad-hoc re-signature", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const copy = await copyOfRelease();
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", copy], { stdio: "ignore", timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs });
    await expect(authenticateClaudeCodeExecutable(copy, copy, await sha256(copy), "darwin", process.arch, noNetwork))
      .rejects.toMatchObject({ name: "ClaudeCodeAuthenticityError", reason: "publisher-rejected" });
  });

  it("refuses the release with one byte changed under its intact signature", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const copy = await copyOfRelease();
    const handle = await fs.open(copy, "r+");
    try {
      // A byte inside the first code page, past the Mach-O header; strict verification hashes every page.
      const offset = 0x2000;
      const original = Buffer.alloc(1);
      await handle.read(original, 0, 1, offset);
      await handle.write(Buffer.from([original[0]! ^ 0xff]), 0, 1, offset);
    } finally { await handle.close(); }
    await expect(authenticateClaudeCodeExecutable(copy, copy, await sha256(copy), "darwin", process.arch, noNetwork))
      .rejects.toBeInstanceOf(ClaudeCodeAuthenticityError);
  });
});

describe.runIf(process.platform === "linux" && RELEASE_METADATA)("real gpg against the pinned release-key fingerprint", () => {
  const read = (name: string) => readFileSync(join(RELEASE_METADATA!, name));

  it("admits the official manifest signed by the pinned release key", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    await expect(verifyClaudeCodeReleaseManifest(await privateRoot(), read("claude-code.asc"), read("manifest.json"), read("manifest.json.sig")))
      .resolves.toBeUndefined();
  });

  it("refuses a tampered manifest under the official signature and leaves no keyring behind", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const manifest = read("manifest.json");
    const tampered = Buffer.from(manifest.toString("utf8").replace(/"checksum": *"[0-9a-f]/u, (match) => `${match.slice(0, -1)}${match.endsWith("0") ? "1" : "0"}`));
    expect(tampered.equals(manifest)).toBe(false);
    const parent = await privateRoot();
    await expect(verifyClaudeCodeReleaseManifest(parent, read("claude-code.asc"), tampered, read("manifest.json.sig")))
      .rejects.toMatchObject({ name: "ClaudeCodeAuthenticityError", reason: "publisher-rejected" });
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses a valid signature from a key other than the pinned release key", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
    const attackerHome = await privateRoot();
    await fs.chmod(attackerHome, 0o700);
    const gpg = (args: string[], input?: Buffer) => execFileSync("/usr/bin/gpg", ["--homedir", attackerHome, "--batch", "--no-tty", ...args], {
      input, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, stdio: ["pipe", "pipe", "ignore"],
    });
    gpg(["--passphrase", "", "--quick-generate-key", "Unrelated Signer <signer@example.invalid>", "ed25519", "sign", "never"]);
    const attackerKey = gpg(["--armor", "--export"]);
    const manifest = read("manifest.json");
    const attackerSignature = gpg(["--detach-sign", "--output", "-"], manifest);
    await expect(verifyClaudeCodeReleaseManifest(await privateRoot(), attackerKey, manifest, attackerSignature))
      .rejects.toMatchObject({ name: "ClaudeCodeAuthenticityError", reason: "publisher-rejected" });
  });
});
