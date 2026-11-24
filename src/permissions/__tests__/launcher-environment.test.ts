import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { prepareSandboxTargetLaunch } from "../launcher-environment.js";

describe("sandbox target environment", () => {
  it.each([
    "UID", "EUID", "PPID", "BASH", "BASHOPTS", "SHELLOPTS", "BASHPID", "BASH_VERSINFO", "BASH_CUSTOM",
    "DIRSTACK", "FUNCNAME", "GROUPS", "PIPESTATUS", "LINENO", "RANDOM", "SRANDOM", "SECONDS", "SHLVL",
    "_", "HISTCMD", "OPTIND", "EPOCHSECONDS", "EPOCHREALTIME",
  ])("refuses %s by name before preparing a wrapped launch", name => {
    expect(() => prepareSandboxTargetLaunch("/bin/sh", [], { [name]: "fixture" })).toThrow(`Environment variable "${name}"`);
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "the real shell rejects or changes incompatible assignments and delivers ordinary names",
    async () => {
      const value = "-ordinary='quoted'\nnext=line";
      const exportProbe = 'IFS= read -r value; export -- "$1=$value" || exit 1; exec /usr/bin/printenv "$1"';
      // These parameters are special on both supported shell versions.
      for (const name of ["UID", "EUID", "PPID", "SHELLOPTS", "PIPESTATUS", "LINENO", "SHLVL"]) {
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", exportProbe, "export-probe", name], {
          env: {}, input: "fixture\n", encoding: "utf8",
        });
        expect(result.error).toBeUndefined();
        expect(result.status === 0 && result.stdout === "fixture\n", name).toBe(false);
        expect(() => prepareSandboxTargetLaunch("/bin/sh", [], { [name]: "fixture" })).toThrow(`Environment variable "${name}"`);
      }

      const target = prepareSandboxTargetLaunch("/bin/sh", ["-c", 'printf "%s\\n%s\\n" "$BASHFUL" "$uid"'], {
        BASHFUL: value, uid: "lowercase",
      });
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", target.command], {
        env: {}, stdio: target.withStdio(["ignore", "pipe", "pipe"]),
      });
      let stdout = "";
      child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      const closed = once(child, "close");
      target.sendEnvironment(child);
      await expect(closed).resolves.toEqual([0, null]);
      expect(stdout).toBe(`${value}\nlowercase\n`);
    },
  );

  it("keeps command text independent of the payload and preserves the protocol fd", () => {
    const value = "-a=b\n'quoted' \\ 한글";
    const target = prepareSandboxTargetLaunch("/bin/sh", ["A=B", "-x"], { CANARY: value, EMPTY: "" });
    expect(target.command).toBe(prepareSandboxTargetLaunch("/bin/sh", ["A=B", "-x"], {}).command);
    expect(target.withStdio(["pipe", "inherit", "ignore", "pipe"])).toEqual(["pipe", "inherit", "ignore", "pipe", "pipe"]);
    expect(() => target.withStdio(["pipe", "pipe", "pipe", null, "inherit"])).toThrow("requires fd 4");

    const pipe = new PassThrough();
    target.sendEnvironment({ stdio: [null, null, null, null, pipe] } as unknown as ChildProcess);
    expect((pipe.read() as Buffer).toString()).toBe(`CANARY=${value}\0EMPTY=\0PATH=/usr/bin:/bin:/usr/sbin:/sbin\0\0`);
  });

  it("handles a pipe failure when the wrapper exits before reading", () => {
    const target = prepareSandboxTargetLaunch("/bin/sh", [], { CANARY: "fixture" });
    const pipe = new PassThrough();
    target.sendEnvironment({ stdio: [null, null, null, null, pipe] } as unknown as ChildProcess);
    expect(() => pipe.emit("error", new Error("closed before delivery"))).not.toThrow();
    expect(pipe.destroyed).toBe(true);
  });
});
