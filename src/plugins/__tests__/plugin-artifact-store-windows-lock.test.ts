/** Windows directory renames can fail while child files are open; retry lock errors but never treat them as ENOENT. */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isTransientFsLockError, retryOnTransientFsLock } from "../../lib/transient-fs-lock-retry.js";
import { cleanupTmpDir, makeStore, makeTmpDir } from "./artifact-store-test-helpers.js";
import { agentPluginsDocument } from "./test-helpers.js";

const TMP_PREFIX = "artifact-store-winlock-";

function lockError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated lock`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("retryOnTransientFsLock", () => {
  const noSleep = { sleep: async () => {} };

  it("recovers when a transient lock clears within the retry budget", async () => {
    let calls = 0;
    const result = await retryOnTransientFsLock(async () => {
      calls += 1;
      if (calls < 3) throw lockError("EPERM");
      return "promoted";
    }, noSleep);
    expect(result).toBe("promoted");
    expect(calls).toBe(3);
  });

  it("does NOT retry ENOENT — an absent source is a first-install signal", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsLock(async () => {
        calls += 1;
        throw lockError("ENOENT");
      }, noSleep),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("rethrows the last error after exhausting attempts on a persistent lock", async () => {
    let calls = 0;
    await expect(
      retryOnTransientFsLock(
        async () => {
          calls += 1;
          throw lockError("EBUSY");
        },
        { ...noSleep, attempts: 4 },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);
  });

  it("classifies the Windows lock codes as transient but not ENOENT", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]) {
      expect(isTransientFsLockError(lockError(code))).toBe(true);
    }
    expect(isTransientFsLockError(lockError("ENOENT"))).toBe(false);
    expect(isTransientFsLockError(new Error("no code"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")(
  "extractZipWithCommit — real Windows file-lock (meeting#154 repro)",
  () => {
    it("updates the plugin when a transient in-dir lock clears mid-swap", async () => {
      const tmp = makeTmpDir(TMP_PREFIX);
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("meeting");
        await mkdir(installDir, { recursive: true });
        // An open child file locks its parent directory against rename on Windows.
        const lockedFile = resolve(installDir, "runtime.lock");
        await writeFile(lockedFile, "held by running plugin");
        await writeFile(
          resolve(installDir, "plugin.json"),
          JSON.stringify({ id: "meeting", version: "old" }),
        );

        const handle = await open(lockedFile, "r");
        // Release the handle within the install retry window.
        const releaseTimer = setTimeout(() => {
          void handle.close();
        }, 300);

        const zip = new AdmZip();
        zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "meeting", version: "new" }))));

        try {
          const { files } = await store.extractZipWithCommit(
            "meeting",
            zip.toBuffer(),
            async () => undefined,
          );
          expect(files).toContain("plugin.json");
          const promoted = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
          expect(promoted.version).toBe("new");
        } finally {
          clearTimeout(releaseTimer);
          await handle.close().catch(() => undefined);
        }
      } finally {
        await cleanupTmpDir(tmp);
      }
    });

    it("rejects and preserves the old install when the in-dir lock never clears", async () => {
      const tmp = makeTmpDir(TMP_PREFIX);
      try {
        const store = makeStore(tmp);
        const installDir = store.installDirFor("meeting");
        await mkdir(installDir, { recursive: true });
        const lockedFile = resolve(installDir, "runtime.lock");
        await writeFile(lockedFile, "held by running plugin");
        await writeFile(
          resolve(installDir, "plugin.json"),
          JSON.stringify({ id: "meeting", version: "old" }),
        );

        // An exhausted lock retry must preserve the old install and surface the error.
        // The rejects assertion also detects platforms that stop reproducing the lock.
        const handle = await open(lockedFile, "r");
        try {
          const zip = new AdmZip();
          zip.addFile("plugin.json", Buffer.from(JSON.stringify(agentPluginsDocument({ id: "meeting", version: "new" }))));

          await expect(
            store.extractZipWithCommit("meeting", zip.toBuffer(), async () => undefined),
          ).rejects.toThrow(/EPERM|EBUSY|EACCES|EEXIST|ENOTEMPTY/);

          const preserved = JSON.parse(await readFile(resolve(installDir, "plugin.json"), "utf-8"));
          expect(preserved.version).toBe("old");
        } finally {
          await handle.close().catch(() => undefined);
        }
      } finally {
        await cleanupTmpDir(tmp);
      }
    });
  },
);
