import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const HELPER = resolve("resources", "linux-shell-seccomp", process.arch, "apply-seccomp");

function collect(stream: Readable | null | undefined): Promise<string> {
  const chunks: Buffer[] = [];
  stream?.on("data", (chunk: Buffer) => chunks.push(chunk));
  return new Promise(done => { stream?.once("close", () => done(Buffer.concat(chunks).toString("utf8"))); });
}

describe.runIf(NATIVE)("native Linux filter helper options", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ave-filter-helper-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // Descriptors 3 to 7: 3 a file, 4 the ready pipe, 5 a pipe, 6 and 7 files.
  async function run(args: readonly string[]) {
    const files = [openSync(join(root, "a"), "w"), openSync(join(root, "b"), "w"), openSync(join(root, "c"), "w")];
    try {
      const child = spawn(HELPER, args, { stdio: ["ignore", "pipe", "pipe", files[0], "pipe", "pipe", files[1], files[2]] });
      const [stdout, stderr, ready, code] = await Promise.all([
        collect(child.stdout), collect(child.stderr), collect(child.stdio[4] as Readable),
        new Promise<number | null>(done => child.once("close", done)),
      ]);
      return { stdout, stderr, ready, code };
    } finally {
      for (const fd of files) closeSync(fd);
    }
  }

  it("leaves the command only 0, 1, 2 and the kept descriptor", async () => {
    const result = await run(["--close-other-fds", "--keep-fd", "7", "--", "/bin/sh", "-c", "ls -1 /proc/$$/fd"]);
    expect(result).toMatchObject({ code: 0, ready: "" });
    expect(result.stdout.trim().split("\n").map(Number).toSorted((a, b) => a - b)).toEqual([0, 1, 2, 7]);
    // Control: without the option, the inherited descriptors reach the command.
    const control = await run(["--", "/bin/sh", "-c", "ls -1 /proc/$$/fd"]);
    expect(control.stdout.trim().split("\n").map(Number)).toEqual(expect.arrayContaining([3, 4, 5, 6, 7]));
  });

  it("writes one ready byte on the named descriptor once the filter is on, then closes it before the command", async () => {
    const result = await run(["--ready-fd", "4", "--close-other-fds", "--",
      "/bin/sh", "-c", "if (printf x >&4) 2>/dev/null; then echo open; else echo closed; fi; ls -1 /proc/$$/fd"]);
    expect(result).toMatchObject({ code: 0, ready: "\n" });
    expect(result.stdout.split("\n")[0]).toBe("closed");
    expect(result.stdout.trim().split("\n").slice(1).map(Number).toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
    // The filter is on when the byte arrives: the command cannot create a Unix socket.
    const filtered = await run(["--ready-fd", "4", "--", HELPER, "--check-unix-socket", join(root, "s")]);
    expect(filtered).toMatchObject({ code: 0, ready: "\n" });
  });

  it("sets each --env variable for the command, keeping later equals signs in the value", async () => {
    const result = await run(["--env", "AVE_ONE=a=b", "--env", "AVE_TWO=", "--", "/bin/sh", "-c", `printf "%s|%s|%s" "$AVE_ONE" "\${AVE_TWO-unset}" "\${AVE_THREE-unset}"`]);
    expect(result).toMatchObject({ code: 0, stdout: "a=b||unset" });
  });

  it("refuses an unknown option, options without --, a closed or low descriptor and an --env without a name", async () => {
    for (const args of [
      ["--unknown", "--", "/bin/true"], ["--close-other-fds", "/bin/true"], ["--ready-fd", "9", "--", "/bin/true"],
      ["--ready-fd", "2", "--", "/bin/true"], ["--keep-fd", "x", "--", "/bin/true"], ["--env", "=x", "--", "/bin/true"],
      ["--env", "NOEQUALS", "--", "/bin/true"], ["--ready-fd", "4", "--ready-fd", "5", "--", "/bin/true"],
    ]) {
      const result = await run(args);
      expect({ args, code: result.code, ready: result.ready }).toEqual({ args, code: 126, ready: "" });
      expect(result.stderr).toContain("Cannot establish the shell filter");
    }
  });

  it("keeps the option-free form: the first word is the command", async () => {
    await expect(run(["/bin/echo", "--close-other-fds"])).resolves.toMatchObject({ code: 0, stdout: "--close-other-fds\n" });
  });
});
