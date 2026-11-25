import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildLauncherEnvironment, prepareSandboxTargetLaunch, sandboxTargetSetupFailed } from "../launcher-environment.js";
import { sandboxProcessProfileEnvironment } from "../sandbox-process-home.js";
import { srtWinConfinementStatePaths } from "../srt-win-integrity.js";

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

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "a host ~/.bashrc in the launcher shell cannot outrank a declared entry or add a locale path",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "launcher-rc-"));
      const marker = join(home, "sourced");
      try {
        // The GitHub macOS runner image's ~/.bashrc exports LC_ALL like this one.
        writeFileSync(join(home, ".bashrc"), [
          `echo "$$" >> ${JSON.stringify(marker)}`,
          "export LC_ALL=en_US.UTF-8 LOCPATH=/rc-locale-path",
        ].join("\n"));
        vi.stubEnv("LC_ALL", "en_US.UTF-8");
        const target = prepareSandboxTargetLaunch("/bin/sh", ["-c", 'printf "%s\\n" "$LC_ALL"; /usr/bin/printenv LOCPATH || echo unset'], {
          LC_ALL: "declared-locale",
        });
        // The shape a gated wrapped launch has: the process group gate execs the wrapper's `/bin/bash -c`, stdin a pipe (a socket).
        const child = spawn("/bin/sh", ["-c", 'exec "$@"', "launch-gate", "/bin/bash", "-c", target.command], {
          env: { ...buildLauncherEnvironment(), HOME: home }, stdio: target.withStdio(["pipe", "pipe", "pipe"]),
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        const closed = once(child, "close");
        target.sendEnvironment(child);
        // stdin stays open until the child ends: bash only takes a connected socket for a remote shell daemon's.
        await expect(closed).resolves.toEqual([0, null]);
        child.stdin?.end();
        expect(existsSync(marker)).toBe(false);
        expect(stdout).toBe("declared-locale\nunset\n");
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
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

describe("the Windows helper launcher's own environment", () => {
  const host = { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local", ProgramData: "C:\\ProgramData" };
  const childHome = "C:\\Users\\alice\\AppData\\Local\\Temp\\ave-sandbox-home-x";

  it("carries the host's state variables, so the ledger it opens is one the state check protects and not the child's", () => {
    const env = buildLauncherEnvironment("win32", host);
    expect(env).toMatchObject(host);
    expect(srtWinConfinementStatePaths(host, "C:\\Users\\alice")).toContain(win32.join(String(env.LOCALAPPDATA), "sandbox-runtime"));
    const child = sandboxProcessProfileEnvironment(childHome, "win32");
    expect(env.LOCALAPPDATA).not.toBe(child.LOCALAPPDATA);
    expect(Object.values(env)).not.toContain(child.LOCALAPPDATA);
  });

  it.each([
    ["LOCALAPPDATA is missing", { ProgramData: host.ProgramData }],
    ["ProgramData is missing", { LOCALAPPDATA: host.LOCALAPPDATA }],
    ["LOCALAPPDATA is not a drive path", { ...host, LOCALAPPDATA: "relative\\Local" }],
  ])("refuses a launch when %s", (_name, env) => {
    expect(() => buildLauncherEnvironment("win32", env)).toThrow(expect.objectContaining({ code: "srt-win-state-location-unresolved" }));
  });

  it("keeps the POSIX launcher environment unchanged", () => {
    expect(buildLauncherEnvironment("linux", {})).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHLVL: "1" });
  });
});
