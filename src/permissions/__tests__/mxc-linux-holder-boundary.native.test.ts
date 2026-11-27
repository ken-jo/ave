import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { collectStream as collect } from "../../__tests__/support/collect-stream.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import seccompPins from "../mxc-linux-seccomp-pins.json" with { type: "json" };
import { requireMxcLinuxShellPrograms } from "../mxc-linux.js";
import { establishLinuxCaptureFolder, linuxHolderReplay, translateLinuxHolderRequest } from "../mxc-linux-holder-launch.js";

const NATIVE = process.env.AVE_RUN_MXC_LINUX_BOUNDARY === "1";
const BWRAP = "/usr/bin/bwrap";


describe.runIf(NATIVE)("native Linux holder translation", () => {
  const resources = { resourcePath: resolve("resources"), isPackaged: false };
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  let root: string;
  let work: string;
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync("/tmp/ave-linux-holder-"));
    work = join(root, "work");
    mkdirSync(work);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // A product-shaped holder request: no proxy URL and no timeout, so the launcher uses its isolated network mode.
  function stage(commandLine: string, env: readonly string[] = []) {
    const request = {
      version: "0.9.0-alpha", containment: "bubblewrap",
      process: { commandLine, cwd: work, inheritDefaultEnv: false, env: [...env] },
      filesystem: { readwritePaths: [work], readonlyPaths: ["/usr", "/etc", "/bin", "/lib"], deniedPaths: [join(work, ".ave")] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    };
    const requestPath = join(root, `request-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    return { request, requestPath, logPath: `${requestPath}.log` };
  }

  async function translate(commandLine: string, env: readonly string[] = [], launcher?: string) {
    const programs = await requireMxcLinuxShellPrograms(resources);
    const captureFolder = establishLinuxCaptureFolder(root, programs.helper, pin);
    const staged = stage(commandLine, env);
    return translateLinuxHolderRequest({ launcher: launcher ?? programs.launcher, env: programs.env, captureFolder, helperSha256: pin,
      bwrap: BWRAP, ...staged });
  }

  it("records the pinned launcher's call through the helper on an inherited socket, with the measured option sequence", async () => {
    const call = await translate("/bin/echo holder");
    const names = call.options.filter(word => word.startsWith("--"));
    // Golden: a pin update that changes this sequence fails here, where a person reads the new shape.
    expect([...new Set(names)]).toEqual([
      "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--unshare-net",
      "--symlink", "--ro-bind-try", "--dev", "--proc", "--tmpfs", "--dir", "--file", "--remount-ro", "--ro-bind", "--bind",
      "--chdir", "--clearenv", "--seccomp",
    ]);
    expect(call.command).toEqual(["sh", "-c", "/bin/echo holder"]);
    expect(call.seccomp.length).toBeGreaterThan(0);
  });

  it("replays the call with the options on a descriptor: the holder gets its environment, no command line holds it", async () => {
    const marker = `marker-${Math.random().toString(16).slice(2)}`;
    const call = await translate('printf "%s" "$AVE_HOLDER_MARKER"; sleep 1', [`AVE_HOLDER_MARKER=${marker}`]);
    expect(call.options).toContain(marker);
    const replay = linuxHolderReplay(call);
    const stdio: ("pipe" | "ignore")[] = ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe", "pipe", "pipe"];
    const child = spawn(BWRAP, replay.argv, { stdio });
    for (const [fd, bytes] of replay.descriptors) (child.stdio[fd] as Writable).end(bytes);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    await new Promise(done => setTimeout(done, 300));
    const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
    const code = await new Promise<number | null>(done => child.once("close", done));
    expect({ code, stdout: await stdout }, await stderr).toEqual({ code: 0, stdout: marker });
    expect(cmdline).not.toContain(marker);
    expect(cmdline.split("\0").slice(1, 3)).toEqual(["--args", "7"]);
  });

  // N21: a launcher whose call differs from the measured shape. The stand-in runs `bwrap` from its PATH, which is
  // the capture, with the words it is given.
  it.each([
    ["an extra option", ["--cap-add", "ALL"], "outside the allowlist: --cap-add"],
    ["an overlay option", ["--overlay-src", "/usr", "--ro-overlay", "/usr"], "outside the allowlist: --overlay-src"],
    ["a third descriptor kind", ["--userns", "3"], "--userns takes a descriptor the capture cannot replay"],
  ] as const)("refuses a launcher call with %s and runs nothing", async (_name, extra, reason) => {
    const ran = join(work, "ran");
    const command = `/usr/bin/touch ${ran}`;
    const real = await translate(command);
    const words = [...real.options.slice(0, 7), ...extra, ...real.options.slice(7)].map(word => word === "5" ? "3" : word);
    const launcher = join(root, "stand-in-launcher");
    const quoted = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
    writeFileSync(launcher, `#!/bin/sh\nbwrap --version > /dev/null || exit 70\nexec 3< /dev/null 6< /dev/null\n`
      + `exec bwrap ${[...words, "--", "sh", "-c", command].map(quoted).join(" ")}\n`, { mode: 0o755 });
    await expect(translate(command, [], launcher)).rejects.toThrow(reason);
    expect(() => readFileSync(ran)).toThrow();
  });
});
