/**
 * The Ave-home sensitive namespace has ONE authority
 * (`AVE_HOME_SENSITIVE_ENTRIES`) and TWO enforcement points that project it:
 * the in-process host-tool guard (`isSensitivePath`, glob form) and the OS
 * sandbox read deny floor (`getDefaultSensitiveReadDenyPaths`, literal form).
 *
 * These tests fail if a `~/.ave/…` path is secret on one surface and readable
 * on the other — the exact drift that made `~/.ave/routine/*` and
 * `~/.ave/plugins/auth-partitions.json` host-readable while the sandbox
 * denied them.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import {
  AVE_HOME_SENSITIVE_ENTRIES,
  canonicalizePathForMatch,
  caseFoldForMatch,
  isSensitivePath,
} from "../sensitive-paths.js";

const FAKE_AVE_HOME = join(tmpdir(), "ave-projection-test-home", ".ave");

function hostDenies(absPath: string): string | null {
  return isSensitivePath(caseFoldForMatch(canonicalizePathForMatch(absPath)));
}

function sandboxDenies(absPath: string): boolean {
  const folded = caseFoldForMatch(absPath);
  return getDefaultSensitiveReadDenyPaths().some((denied) => {
    const foldedDeny = caseFoldForMatch(denied);
    return folded === foldedDeny || folded.startsWith(foldedDeny + "/") ||
      folded.startsWith(foldedDeny + "\\");
  });
}

describe("Ave-home sensitive namespace — one table, two projections", () => {
  let prevAveHome: string | undefined;

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = FAKE_AVE_HOME;
  });
  afterEach(() => {
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
  });

  it("denies every table row on BOTH surfaces", () => {
    for (const entry of AVE_HOME_SENSITIVE_ENTRIES) {
      const target = entry.kind === "dir"
        ? join(FAKE_AVE_HOME, ...entry.segments, "probe-child")
        : join(FAKE_AVE_HOME, ...entry.segments);
      expect(hostDenies(target), `host guard must deny ${target}`).not.toBeNull();
      expect(sandboxDenies(target), `sandbox floor must deny ${target}`).toBe(true);
    }
  });

  // Content pin, independent of the table: deleting a row must red these.
  it.each([
    ["routine", join(FAKE_AVE_HOME, "routine", "session-1.jsonl")],
    ["auth partitions", join(FAKE_AVE_HOME, "plugins", "auth-partitions.json")],
    ["secrets", join(FAKE_AVE_HOME, "secrets", "k.key")],
    ["sessions", join(FAKE_AVE_HOME, "sessions", "abc.jsonl")],
    ["audit", join(FAKE_AVE_HOME, "audit", "today.jsonl")],
    ["audit log", join(FAKE_AVE_HOME, "audit.log")],
    ["settings", join(FAKE_AVE_HOME, "settings.json")],
    ["permissions", join(FAKE_AVE_HOME, "permissions", "cache.json")],
    ["permissions file", join(FAKE_AVE_HOME, "permissions.json")],
    ["policy", join(FAKE_AVE_HOME, "policy.json")],
    ["certs", join(FAKE_AVE_HOME, "certs", "ca.pem")],
    ["keys", join(FAKE_AVE_HOME, "keys", "sign.key")],
    ["legacy secrets file", join(FAKE_AVE_HOME, "ave-secrets.json")],
  ])("%s is secret to the host guard and to the sandbox floor", (_label, target) => {
    expect(hostDenies(target)).not.toBeNull();
    expect(sandboxDenies(target)).toBe(true);
  });

  it("still allows a non-secret Ave-home path on both surfaces", () => {
    const benign = join(FAKE_AVE_HOME, "plugins", "hello-world", "README.md");
    expect(hostDenies(benign)).toBeNull();
    expect(sandboxDenies(benign)).toBe(false);
  });
});
