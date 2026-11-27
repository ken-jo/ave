import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherPathFor } from "../mxc-launcher.js";
import { holdMxcLinuxPlaceholders, sweepMxcLinuxPlaceholders } from "../mxc-linux-placeholders.js";
import { posixPolicyLookups, rankPosixContainerRows, type PosixPolicyLookups } from "../mxc-posix.js";
import { _forgetMxcRuntimeRootForTest, currentMxcRuntimeHost, establishMxcRuntimeRoot, type MxcRuntimeHost } from "../mxc-runtime-root.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";

describe.runIf(process.platform === "linux")("Linux placeholder ownership", () => {
  let root: string;
  let work: string;
  let leaf: string;
  let host: MxcRuntimeHost;
  let lookups: PosixPolicyLookups;
  let rank: (lookups: PosixPolicyLookups) => ReturnType<typeof rankPosixContainerRows>;

  beforeEach(() => {
    // The runtime root rejects writable ancestors. The system temporary directory is sticky.
    root = mkdtempSync("/tmp/ave-placeholder-");
    work = join(root, "work");
    mkdirSync(work);
    leaf = join(work, "missing", "deep", "locked");
    host = { ...currentMxcRuntimeHost(), cacheHome: join(root, "cache"), aveHome: join(root, "state") };
    establishMxcRuntimeRoot(host);
    lookups = posixPolicyLookups(root, false);
    const model = buildPolicyModel({
      floors: [policyFloorRow(leaf, "ro", "protected-name", true)],
      launchGrants: [policyGrantRow(work, "rw", "launch-grant", true)],
      userGrants: [], extensionManifests: [],
    });
    rank = (policyLookups) => rankPosixContainerRows(model, "bubblewrap", policyLookups);
  });

  afterEach(() => {
    _forgetMxcRuntimeRootForTest(host.cacheHome);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps an absent leaf and its pinned parents until the last run leaves", async () => {
    const first = await holdMxcLinuxPlaceholders(lookups, rank, host);
    const second = await holdMxcLinuxPlaceholders(lookups, rank, host);
    expect(first.grants.pins).toEqual([dirname(leaf), join(work, "missing")]);
    expect(second.grants.denied).toEqual([leaf]);
    expect(second.grants.readonly).toEqual([]);
    await first.release();
    second.validate();
    expect(existsSync(leaf)).toBe(true);
    await second.release();
    expect(existsSync(join(work, "missing"))).toBe(false);
  });

  it("sweeps on the next acquisition only after both the owner and the launcher are gone", async () => {
    const owners = new Map([[51, "owner"], [52, "launcher"]]);
    const liveness = { processExists: (pid: number) => owners.has(pid), processStart: (pid: number) => owners.get(pid) ?? null };
    const first = await holdMxcLinuxPlaceholders(lookups, rank, { ...host, ...liveness, pid: 51 });
    await first.recordLauncher(52);
    owners.delete(51);
    await sweepMxcLinuxPlaceholders({ ...host, ...liveness });
    expect(existsSync(leaf)).toBe(true);
    owners.set(52, "reused");
    const second = await holdMxcLinuxPlaceholders(lookups, (current) => {
      expect(existsSync(join(work, "missing"))).toBe(false);
      return rank(current);
    }, { ...host, ...liveness, pid: 52 });
    second.validate();
    await second.release();
    expect(existsSync(join(work, "missing"))).toBe(false);
  });

  it("refuses a replaced ancestor and leaves the replacement untouched", async () => {
    const replaceWork = () => {
      renameSync(work, join(root, "original"));
      mkdirSync(work);
    };
    await expect(holdMxcLinuxPlaceholders(lookups, (current) => {
      const grants = rank(current);
      replaceWork();
      return grants;
    }, host)).rejects.toThrow("Container placeholder ancestor changed");
    expect(existsSync(leaf)).toBe(false);
  });

  it("cleans the protected leaf and leaves an ordinary file in a created parent", async () => {
    const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
    const sibling = join(dirname(leaf), "ordinary");
    writeFileSync(sibling, "kept");
    await hold.release();
    expect(existsSync(leaf)).toBe(false);
    expect(readFileSync(sibling, "utf8")).toBe("kept");
  });

  if (process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1") it("refuses to rename a pre-created parent and writes to its sibling natively", async () => {
    const hold = await holdMxcLinuxPlaceholders(lookups, rank, host);
    try {
      const launcher = launcherPathFor(join(process.cwd(), "resources"), process.platform, process.arch);
      if (launcher === undefined) throw new Error("Linux test launcher is unavailable");
      const config = join(root, "config.json");
      const commandLine = [
        "if mv -T missing moved; then exit 21; fi",
        "if mv -T missing/deep missing/moved; then exit 22; fi",
        "if touch missing/deep/locked/file; then exit 23; fi",
        "printf writable > missing/deep/sibling",
      ].join("\n");
      writeFileSync(config, JSON.stringify({
        version: "0.9.0-alpha", containment: "bubblewrap", process: { commandLine, cwd: work },
        filesystem: { readwritePaths: hold.grants.readwrite, readonlyPaths: [], deniedPaths: hold.grants.denied },
        network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      }));
      hold.validate();
      const result = spawnSync(launcher, ["--config", config], { encoding: "utf8", timeout: 5_000 });
      expect(result.status, String(result.error ?? result.stderr)).toBe(0);
      expect(result.stderr.match(/Device or resource busy/gu)).toHaveLength(2);
      expect(existsSync(join(work, "moved"))).toBe(false);
      expect(readFileSync(join(dirname(leaf), "sibling"), "utf8")).toBe("writable");
    } finally {
      await hold.release();
    }
    expect(existsSync(leaf)).toBe(false);
  });
});
