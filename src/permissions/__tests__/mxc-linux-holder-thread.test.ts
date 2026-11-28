import { describe, expect, it, vi } from "vitest";

vi.mock("node:worker_threads", async (importOriginal) => ({ ...await importOriginal<typeof import("node:worker_threads")>(), isMainThread: false }));
const { startLinuxHolder } = await import("../mxc-linux-holder-launch.js");

describe("Linux holder start thread", () => {
  // bwrap's parent-death signal belongs to the thread that created it, so a holder started elsewhere could outlive Ave.
  it("refuses to start a holder off the main thread, before anything is spawned", async () => {
    const beforeRelease = vi.fn(async () => {});
    await expect(startLinuxHolder({ options: [], command: ["sh", "-c", "true"], seccomp: Buffer.from("x") }, {
      label: "test", bwrap: { path: "/usr/bin/bwrap", identity: "" }, cwd: "/", admittedDigest: "", currentDigest: () => "",
      assertStillValid: () => {}, beforeRelease,
    })).rejects.toThrow("main thread");
    expect(beforeRelease).not.toHaveBeenCalled();
  });
});
