/** Windows scanners can hold teardown handles after assertions pass; cleanup must retry transient locks. */
import { describe, expect, it, vi } from "vitest";

const rm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm,
}));

const { cleanupTmpDir } = await import("./artifact-store-test-helpers.js");

describe("cleanupTmpDir", () => {
  it("survives a transient ENOTEMPTY and retries until the directory goes", async () => {
    rm.mockReset();
    rm.mockRejectedValueOnce(Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" }));
    rm.mockResolvedValueOnce(undefined);

    await expect(cleanupTmpDir("C:/nowhere/scratch")).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(2);
  });

  it("removes the directory recursively and forcibly", async () => {
    rm.mockReset();
    rm.mockResolvedValue(undefined);

    await cleanupTmpDir("C:/nowhere/scratch");

    expect(rm).toHaveBeenCalledWith("C:/nowhere/scratch", { recursive: true, force: true });
  });

  // ENOENT is not lock contention; swallowing it would hide a missing fixture directory.
  it("propagates a non-lock error instead of retrying it", async () => {
    rm.mockReset();
    rm.mockRejectedValue(Object.assign(new Error("nope"), { code: "ENOENT" }));

    await expect(cleanupTmpDir("C:/nowhere/scratch")).rejects.toThrow(/nope/);
    expect(rm).toHaveBeenCalledTimes(1);
  });

});
