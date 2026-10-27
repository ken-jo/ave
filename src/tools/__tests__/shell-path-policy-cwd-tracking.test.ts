// Resolve operands against each possible execution directory, including changes made by cd.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { findShellPathPolicyViolation } from "../shell-path-policy.js";

// A shallower allowed directory makes traversal escape only after cd.
// Windows hosts resolve the fixture POSIX roots onto the process drive, as in shell-path-policy.test.ts.
const hostFilesystemPath = (path: string): string => process.platform === "win32" ? resolve(path).replaceAll("\\", "/") : path;
const ROOT = hostFilesystemPath("/private/tmp/ave-cwd-tracking");
const CWD = `${ROOT}/src/deep/nested`;
const TMP = hostFilesystemPath("/tmp");
const EXTRAS = [TMP];

// Reads are unfenced by default but retain the sensitive-path deny-list; test cwd tracking with writes and fenced reads.
function check(command: string, blockReads = false) {
  return findShellPathPolicyViolation(command, CWD, ROOT, EXTRAS, blockReads);
}

describe("shell path policy — working directory tracking", () => {
  it("blocks a WRITE climbing out of a shallow allowed directory reached by cd", () => {
    const violation = check(`cd ${TMP} && cp ./staged ../../etc/evil`);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("sandbox-boundary");
  });

  it("blocks the same climb with a READ verb once reads are re-fenced", () => {
    const violation = check(`cd ${TMP} && cat ../../etc/passwd`, true);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("sandbox-boundary");
  });

  it.each([
    [`cd ${TMP} && mv ./staged ../etc/evil`, "one level up"],
    [`cd ${TMP}; cp ./staged ./x/../../etc/evil`, "climb hidden mid-path"],
    [`cd ${TMP} && head -1 ../../../etc/shadow`, "a sensitive file above"],
  ])("blocks %s (%s)", (command) => {
    expect(check(command)).not.toBeNull();
  });

  it.each([
    [`cd ${TMP} && cat ../etc/passwd`, "one level up"],
    [`cd ${TMP}; cat ./x/../../etc/passwd`, "climb hidden mid-path"],
  ])("blocks read %s (%s) when reads are re-fenced", (command) => {
    expect(check(command, true)).not.toBeNull();
  });

  it("still resolves against the session cwd when no cd is present", () => {
    // Check both write confinement and opt-in read confinement.
    expect(check("cp ./staged ../../../../../etc/evil")).not.toBeNull();
    expect(check("cat ../../../../../etc/passwd", true)).not.toBeNull();
  });

  // Wide reads remain allowed by directory policy but must still respect protected paths.
  it("admits a read that climbs out, under the shipped policy", () => {
    expect(check(`cd ${TMP} && cat ../../etc/passwd`)).toBeNull();
    expect(check("cat ../../../../../etc/passwd")).toBeNull();
  });

  it.each([
    [`cd ${TMP} && cat notes.txt`],
    ["cd .. && ls"],
    [`cd ${TMP}`],
    ["ls -la"],
    ["cat notes.txt"],
  ])("allows %s", (command) => {
    expect(check(command)).toBeNull();
  });

  it("resolves a later operand against the directory cd moved to, not the session cwd", () => {
    // Resolve the operand against the directory entered by cd.
    expect(check("cd sub && cat ../notes.txt")).toBeNull();
  });

  describe("a cd whose destination argv does not decide", () => {
    it.each([
      ["cd $DIR && cat foo", "an unexpanded variable"],
      ["cd - && cat foo", "OLDPWD"],
    ])("stops the command: %s (%s)", (command) => {
      const violation = check(command);
      expect(violation).not.toBeNull();
      expect(violation!.kind).toBe("dynamic-path");
    });

    it("says what to do instead", () => {
      expect(check("cd $DIR && cat foo")!.reason).toMatch(/unresolved working-directory destination/i);
    });

    it("treats a bare cd as decidable — it goes home, which is then checked", () => {
      // Bare cd resolves through prepared HOME and must receive the same boundary check.
      // A known outside destination is a violation, distinct from an unresolved destination.
      const violation = findShellPathPolicyViolation("cd && cat foo", CWD, ROOT, EXTRAS, true, { dialect: "bash", environment: { HOME: homedir() } });
      expect(violation).not.toBeNull();
      expect(violation!.kind).toBe("sandbox-boundary");
    });

    it("does not mistake -L/-P for the destination", () => {
      expect(check(`cd -P ${TMP} && cat notes.txt`)).toBeNull();
    });
  });
});
