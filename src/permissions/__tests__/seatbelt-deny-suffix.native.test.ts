import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { launcherPathFor } from "../mxc-launcher.js";
import { _runSeatbeltCanaryForTest, parseSeatbeltProfile } from "../mxc-macos.js";
import { posixPolicyLookups, rankPosixContainerRows } from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";
import { buildSeatbeltDenySuffix } from "../seatbelt-deny-suffix.js";

describe.runIf(process.platform === "darwin" && process.arch === "arm64")("native Seatbelt deny suffix", () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "seatbelt-suffix-")));
    work = join(root, "work");
    mkdirSync(work);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function launch(commandLine: string, timeout: number, suffix: string, filesystem: object) {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    const config = join(root, "launcher.json");
    const request = {
      version: "1.0.0", containment: "seatbelt",
      process: { commandLine: "/usr/bin/true", cwd: work, timeout: 5_000 },
      filesystem,
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      seatbelt: { nestedPty: false },
    };
    const run = (args: string[]) => spawnSync(launcher, [...args, "--config", config], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: buildSafeChildEnv(), timeout: 8_000,
    });
    writeFileSync(config, JSON.stringify(request), { mode: 0o600 });
    const generated = run(["--debug"]);
    expect(generated.status, generated.stderr).toBe(0);
    const profileOverride = parseSeatbeltProfile(`${generated.stdout}\n${generated.stderr}`) + suffix;
    writeFileSync(config, JSON.stringify({
      ...request, process: { ...request.process, commandLine, timeout },
      seatbelt: { ...request.seatbelt, profileOverride },
    }));
    return run([]);
  }

  it("carves around a denied sibling and refuses protected moves and new pattern matches", () => {
    const vault = join(root, "vault");
    const open = join(vault, "open");
    const secret = join(vault, "secret");
    const protectedParent = join(work, "control");
    const protectedChild = join(protectedParent, "locked");
    mkdirSync(protectedChild, { recursive: true });
    mkdirSync(open, { recursive: true });
    writeFileSync(join(open, "control"), "readable");
    writeFileSync(secret, "private fixture");
    const literalRows = [
      policyFloorRow(vault, "denied", "read-boundary", true),
      policyFloorRow(protectedChild, "ro", "protected-name", true),
    ];
    const lookups = posixPolicyLookups(root, true);
    const grants = rankPosixContainerRows(buildPolicyModel({
      floors: literalRows, userGrants: [], extensionManifests: [],
      launchGrants: [
        policyGrantRow(root, "ro", "launch-grant", true),
        policyGrantRow(work, "rw", "launch-grant", true),
        policyGrantRow(open, "ro", "launch-grant", true),
      ],
    }), "seatbelt", lookups);
    const suffix = buildSeatbeltDenySuffix({
      literals: literalRows, writeRoots: [work], lookups,
      patterns: [policyFloorRow(`${work}/**/*.locked`, "ro", "protected-name", false)],
    });
    const result = launch([
      `test "$(cat '${open}/control')" = readable || exit 11`,
      `if cat '${secret}'; then exit 12; fi`,
      "mkdir ordinary && echo ok > ordinary/good || exit 13",
      "if (echo denied > ordinary/new.locked); then exit 14; fi",
      "if mv control renamed; then exit 15; fi",
    ].join("\n"), 3_000, suffix, {
      readwritePaths: grants.readwrite, readonlyPaths: grants.readonly, deniedPaths: grants.denied,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).not.toContain("private fixture");
    expect(existsSync(protectedChild)).toBe(true);
    expect(existsSync(join(work, "ordinary", "new.locked"))).toBe(false);
    expect(readFileSync(join(work, "ordinary", "good"), "utf8").trim()).toBe("ok");
  });

  it("keeps both admitted children readable through nested carves and both denied scopes closed", () => {
    const outer = join(work, "outer");
    const project = join(outer, "project");
    const inner = join(project, "inner");
    const child = join(inner, "child");
    mkdirSync(child, { recursive: true });
    for (const dir of [outer, project, inner, child]) writeFileSync(join(dir, "file"), "fixture");

    const lookups = posixPolicyLookups(root, true);
    const grants = rankPosixContainerRows(buildPolicyModel({
      floors: [outer, inner].map(dir => policyFloorRow(dir, "denied", "read-boundary", true)),
      launchGrants: [work, project, child].map(dir => policyGrantRow(dir, "ro", "launch-grant", true)),
      userGrants: [], extensionManifests: [],
    }), "seatbelt", lookups);
    const result = launch([
      `cat '${project}/file' || exit 11`,
      `cat '${child}/file' || exit 12`,
      `if cat '${outer}/file'; then exit 13; fi`,
      `if cat '${inner}/file'; then exit 14; fi`,
    ].join("\n"), 3_000, "", {
      readwritePaths: grants.readwrite, readonlyPaths: grants.readonly, deniedPaths: grants.denied,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("reaps the shell, a background child and a setsid descendant on the backend timeout under an override", () => {
    const suffix = buildSeatbeltDenySuffix({
      literals: [], patterns: [], writeRoots: [work], lookups: posixPolicyLookups(root, true),
    });
    const result = launch([
      "echo $$ > shell.pid",
      "sleep 8 & echo $! > child.pid",
      `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() >= 0 or die $!; open(my $pid, ">", "detached.pid") or die $!; print $pid $$; close($pid); sleep 8' &`,
      "wait",
    ].join("\n"), 1_200, suffix, { readwritePaths: [work], readonlyPaths: [], deniedPaths: [] });
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(255);
    for (const name of ["shell", "child", "detached"]) {
      const pid = Number(readFileSync(join(work, `${name}.pid`), "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0), name).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });

  it("proves the boot canary against the installed launcher and cleans its staging", async () => {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    await expect(_runSeatbeltCanaryForTest(launcher, root)).resolves.toBe("available");
    expect(readdirSync(root)).toEqual(["work"]);
  });

  it("waits for the canary child to exit before tearing down on abort", async () => {
    const launcher = launcherPathFor(resolve("resources"), "darwin", "arm64");
    if (launcher === undefined) throw new Error("macOS launcher path is missing");
    const wrapper = join(work, "abort-probe");
    writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "--config" ]; then
  /usr/bin/perl -MJSON::PP -0777 -i -pe 'my $request=decode_json($_); $request->{process}{commandLine}=q{echo $$ > child.pid; /bin/sleep 1; exit 0}; $_=encode_json($request)' "$2" || exit 1
fi
exec "${launcher}" "$@"
`, { mode: 0o700 });

    const controller = new AbortController();
    const reason = new Error("Canary cancelled");
    const outcome = _runSeatbeltCanaryForTest(wrapper, root, controller.signal).catch((error: unknown) => error);
    const childPid = await vi.waitFor(() => {
      const staging = readdirSync(root).find(name => name.startsWith("shell-probe-"));
      if (staging === undefined) throw new Error("Canary staging has not started");
      const pid = Number(readFileSync(join(root, staging, "fixture", "project", "child.pid"), "utf8"));
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, { interval: 10, timeout: 3_000 });
    controller.abort(reason);
    const result = await outcome;
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(readdirSync(root)).toEqual(["work"]);
    expect(result).toBe(reason);
  });
});
