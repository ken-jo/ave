import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { prepareSandboxTargetLaunch } from "../launcher-environment.js";

describe("sandbox target environment", () => {
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
