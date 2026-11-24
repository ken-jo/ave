import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { prepareSandboxTargetLaunch, sandboxTargetSetupFailed } from "../launcher-environment.js";

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
    expect(target.withStdio(["pipe", "inherit", "ignore", "pipe"])).toEqual(["pipe", "inherit", "ignore", "pipe", "pipe", "pipe"]);
    expect(() => target.withStdio(["pipe", "pipe", "pipe", null, "inherit"])).toThrow("requires fds 4 and 5");
    expect(() => target.withStdio(["pipe", "pipe", "pipe", null, null, "inherit"])).toThrow("requires fds 4 and 5");

    const pipe = new PassThrough();
    target.sendEnvironment({ stdio: [null, null, null, null, pipe] } as unknown as ChildProcess);
    expect((pipe.read() as Buffer).toString()).toBe(`CANARY=${value}\0EMPTY=\0PATH=/usr/bin:/bin:/usr/sbin:/sbin\0\0`);
  });

  it("names a setup failure only from the status byte, also when the byte arrives after exit", async () => {
    const statusChild = () => {
      const status = new PassThrough();
      const child = { stdio: [null, null, null, null, new PassThrough(), status] } as unknown as ChildProcess;
      prepareSandboxTargetLaunch("/bin/sh", [], {}).sendEnvironment(child);
      return { child, status };
    };
    const failed = statusChild();
    const started = statusChild();
    setTimeout(() => failed.status.end(Buffer.from([1])), 5);
    started.status.end();
    await expect(sandboxTargetSetupFailed(failed.child)).resolves.toBe(true);
    await expect(sandboxTargetSetupFailed(started.child)).resolves.toBe(false);
    expect(sandboxTargetSetupFailed({ stdio: [] } as unknown as ChildProcess)).toBeUndefined();
  });

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "the real shell reports no setup failure for a target exit 1 and one for a refused runtime export",
    async () => {
      const run = async (env: NodeJS.ProcessEnv) => {
        const target = prepareSandboxTargetLaunch("/bin/sh", ["-c", "exit 1"], { CANARY: "fixture" });
        const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", target.command], {
          env, stdio: target.withStdio(["ignore", "pipe", "pipe"]),
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        const closed = once(child, "close");
        target.sendEnvironment(child);
        const [code] = await closed;
        return { code, stderr, failed: await sandboxTargetSetupFailed(child) };
      };
      expect(await run({})).toEqual({ code: 1, stderr: "", failed: false });
      // A readonly runtime variable makes the shim's export fail before exec.
      const refused = await run({ SHELLOPTS: "xtrace" });
      expect(refused).toMatchObject({ code: 1, failed: true });
      expect(refused.stderr).not.toContain("fixture");
    },
  );

  it("handles a pipe failure when the wrapper exits before reading", () => {
    const target = prepareSandboxTargetLaunch("/bin/sh", [], { CANARY: "fixture" });
    const pipe = new PassThrough();
    target.sendEnvironment({ stdio: [null, null, null, null, pipe] } as unknown as ChildProcess);
    expect(() => pipe.emit("error", new Error("closed before delivery"))).not.toThrow();
    expect(pipe.destroyed).toBe(true);
  });
});
