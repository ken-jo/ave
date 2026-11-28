import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLinuxCaptureFolder, checkBwrapCall, establishLinuxCaptureFolder, LINUX_HOLDER_OPTIONS_FD, linuxHolderReplay, parseBwrapRecord,
  translateLinuxHolderRequest,
} from "../mxc-linux-holder-launch.js";

// The record the helper writes when it runs as `bwrap` (native/linux-shell-seccomp/src/main.rs `capture_record`).
function record(words: readonly string[], descriptors: ReadonlyArray<readonly [number, string]>): Buffer {
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const bytes = (value: Buffer) => Buffer.concat([u32(value.length), value]);
  return Buffer.concat([Buffer.from("AVEBWRAPR"), u32(words.length), ...words.map(word => bytes(Buffer.from(word))),
    u32(descriptors.length), ...descriptors.flatMap(([fd, data]) => [u32(fd), bytes(Buffer.from(data))])]);
}
function errorRecord(message: string): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(Buffer.byteLength(message));
  return Buffer.concat([Buffer.from("AVEBWRAPE"), length, Buffer.from(message)]);
}

const request = {
  process: { commandLine: "'/app/apply-seccomp' --ready-fd 4 -- '/usr/bin/node' 'server.js'" },
  filesystem: { readwritePaths: ["/work"], readonlyPaths: ["/usr", "/app"], deniedPaths: ["/work/.ave/hooks"] },
};
// The shape the pinned launcher wrote for a request like this one (logs/P1-probe-args.log), abridged.
const measured = [
  "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--unshare-net",
  "--symlink", "usr/bin", "/bin", "--ro-bind-try", "/usr/lib", "/usr/lib", "--dev", "/dev", "--proc", "/proc",
  "--tmpfs", "/tmp", "--tmpfs", "/run/systemd/resolve", "--dir", "/run/systemd/resolve",
  "--file", "11", "/run/systemd/resolve/stub-resolv.conf", "--remount-ro", "/run/systemd/resolve",
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/app", "/app", "--bind", "/work", "/work",
  "--tmpfs", "/work/.ave/hooks", "--remount-ro", "/work/.ave/hooks", "--chdir", "/work", "--clearenv",
  "--setenv", "TOKEN", "secret", "--seccomp", "10",
] as const;
const call = [...measured, "--", "sh", "-c", request.process.commandLine];
const fds = [[11, "nameserver 127.0.0.53\n"], [10, "filter-bytes"]] as const;
const replace = (words: readonly string[], index: number, ...values: string[]) => [...words.slice(0, index), ...values, ...words.slice(index + 1)];

describe("Linux holder bwrap record", () => {
  it("reads one record and renumbers its two data descriptors for the replay", () => {
    const checked = checkBwrapCall(parseBwrapRecord(record(call, fds)), request);
    expect(checked.command).toEqual(["sh", "-c", request.process.commandLine]);
    expect(checked.options.slice(checked.options.indexOf("--seccomp"))).toEqual(["--seccomp", "5"]);
    expect(checked.options[checked.options.indexOf("--file") + 1]).toBe("6");
    expect(checked.seccomp.toString()).toBe("filter-bytes");
    expect(checked.resolver?.toString()).toBe("nameserver 127.0.0.53\n");
  });

  it("puts every option on the options descriptor and only --args, -- and the command on the command line", () => {
    const replay = linuxHolderReplay(checkBwrapCall(parseBwrapRecord(record(call, fds)), request));
    expect(replay.argv).toEqual(["--args", String(LINUX_HOLDER_OPTIONS_FD), "--", "sh", "-c", request.process.commandLine]);
    expect(replay.argv.join(" ")).not.toContain("secret");
    const options = replay.descriptors.get(LINUX_HOLDER_OPTIONS_FD)?.toString().split("\0");
    expect(options?.at(-1)).toBe("");
    expect(options?.slice(0, -1)).toEqual(checkBwrapCall(parseBwrapRecord(record(call, fds)), request).options);
    expect([...replay.descriptors.keys()]).toEqual([5, 6, 7]);
  });

  it.each([
    ["two records", Buffer.concat([record(call, fds), record(call, fds)]), "more than one bwrap call"],
    ["a truncated record", record(call, fds).subarray(0, 40), "truncated"],
    ["no header", Buffer.from("not a record"), "no header"],
    ["an error record", errorRecord("--userns takes a descriptor the capture cannot replay"), "--userns takes a descriptor"],
  ] as const)("refuses %s", (_name, bytes, reason) => {
    expect(() => checkBwrapCall(parseBwrapRecord(bytes), request)).toThrow(reason);
  });

  it.each([
    ["an option outside the allowlist", [...measured.slice(0, 7), "--cap-add", "ALL", ...measured.slice(7)], "outside the allowlist: --cap-add"],
    ["an overlay option", [...measured, "--overlay-src", "/work", "--ro-overlay", "/work"], "outside the allowlist: --overlay-src"],
    ["a third descriptor kind", [...measured, "--userns", "12"], "outside the allowlist: --userns"],
    ["a missing --unshare-net", measured.filter(word => word !== "--unshare-net"), "lacks --unshare-net"],
    ["a missing --die-with-parent", measured.filter(word => word !== "--die-with-parent"), "lacks --die-with-parent"],
    ["a second --seccomp", [...measured, "--seccomp", "10"], "one --seccomp"],
    ["a bind of a path not in the request", [...measured, "--bind", "/home/user", "/home/user"], "not a path of the request"],
    ["a bind of another source", replace(measured, measured.indexOf("/work"), "/elsewhere"), "at another path"],
    ["a read-only bind of a path not in the request", [...measured, "--ro-bind", "/etc/shadow", "/etc/shadow"], "not a path of the request"],
    ["the empty device over a write grant", [...measured, "--ro-bind", "/dev/null", "/work"], "at another path"],
    ["the empty device writable over a denied file", [...measured, "--bind", "/dev/null", "/work/.ave/hooks"], "at another path"],
  ] as const)("refuses a call with %s", (_name, options, reason) => {
    expect(() => checkBwrapCall(parseBwrapRecord(record([...options, "--", "sh", "-c", request.process.commandLine], fds)), request)).toThrow(reason);
  });

  it("accepts the empty device read-only over a denied file, the launcher's file deny", () => {
    const checked = checkBwrapCall(parseBwrapRecord(record([...measured, "--ro-bind", "/dev/null", "/work/.ave/hooks", "--", "sh", "-c", request.process.commandLine], fds)), request);
    expect(checked.options.slice(-3)).toEqual(["--ro-bind", "/dev/null", "/work/.ave/hooks"]);
  });

  it.each([
    [["sh", "-c", "true"]],
    [["sh", "-c", request.process.commandLine, "extra"]],
    [["bash", "-c", request.process.commandLine]],
  ])("refuses a call whose command words are not the request's: %j", (command) => {
    expect(() => checkBwrapCall(parseBwrapRecord(record([...measured, "--", ...command], fds)), request)).toThrow("not the request's command line");
  });

  it("refuses recorded descriptors that are not the ones the call names", () => {
    expect(() => checkBwrapCall(parseBwrapRecord(record(call, [[10, "filter-bytes"]])), request)).toThrow("not the ones the call names");
    expect(() => checkBwrapCall(parseBwrapRecord(record(call, [...fds, [12, "x"]])), request)).toThrow("not the ones the call names");
  });
});

// POSIX only: the capture folder is checked by owner, mode and realpath, and the launchers here are sh scripts. The
// record parsing and structure checks above are platform-neutral and run everywhere.
describe.runIf(process.platform !== "win32")("Linux holder capture folder and translation", () => {
  let root: string;
  let helper: string;
  let pin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-holder-launch-"));
    helper = join(root, "apply-seccomp");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    pin = createHash("sha256").update(readFileSync(helper)).digest("hex");
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const canonical = () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    return realpathSync.native(runtime);
  };

  it("holds exactly the pinned helper as bwrap, and refuses a second entry, a group-writable file or other bytes", () => {
    const folder = establishLinuxCaptureFolder(canonical(), helper, pin);
    expect(() => assertLinuxCaptureFolder(folder, pin)).not.toThrow();
    writeFileSync(join(folder, "extra"), "");
    expect(() => assertLinuxCaptureFolder(folder, pin)).toThrow("not only bwrap");
    rmSync(join(folder, "extra"));
    chmodSync(join(folder, "bwrap"), 0o720);
    expect(() => assertLinuxCaptureFolder(folder, pin)).toThrow("writable by group or others");
    chmodSync(join(folder, "bwrap"), 0o500);
    expect(() => assertLinuxCaptureFolder(folder, "0".repeat(64))).toThrow("not the pinned helper");
  });

  async function translate(script: string, log = "") {
    const runtime = canonical();
    const folder = establishLinuxCaptureFolder(runtime, helper, pin);
    const launcher = join(root, "launcher");
    writeFileSync(join(root, "record"), record(call, fds));
    writeFileSync(launcher, `#!/bin/sh\nprintf %s ${JSON.stringify(log)} >> "$2"\n${script}\n`, { mode: 0o755 });
    return translateLinuxHolderRequest({
      launcher, env: { PATH: "/usr/bin:/bin" }, captureFolder: folder, helperSha256: pin, bwrap: "/usr/bin/bwrap",
      requestPath: join(root, "request.json"), logPath: join(root, "launcher.log"), request,
    });
  }

  it("returns the checked call the launcher's bwrap recorded, with the capture folder first on its PATH", async () => {
    const result = await translate(`case $PATH in */bwrap-capture:/usr/bin:/bin) ;; *) exit 9 ;; esac\n[ "$AVE_BWRAP_CAPTURE_FD" = 9 ] || exit 8\ncat ${JSON.stringify(join(root, "record"))} >&9`);
    expect(result.command).toEqual(["sh", "-c", request.process.commandLine]);
  });

  it("refuses a launcher that exits non-zero with the launcher log's reason, never stderr", async () => {
    await expect(translate("echo 'Error: forged on stderr' >&2\nexit 1", "Error: backend_error: mount information entry 29\n"))
      .rejects.toThrow("backend_error: mount information entry 29");
  });

  it("refuses a launcher that made no call", async () => {
    await expect(translate("exit 0")).rejects.toThrow("made no bwrap call");
  });
});
