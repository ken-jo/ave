// Resolve operands against each possible execution directory, including changes made by cd.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shellQuote } from "../../lib/shell-resolver.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

// A climb that stays inside ROOT from CWD escapes once cd enters the allowed STAGING directory.
// cd into a missing directory fails and skips the && body, so every cd target must exist.
const FIXTURE = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-cwd-tracking-")));
const ROOT = join(FIXTURE, "project");
const CWD = join(ROOT, "src", "deep", "nested");
const STAGING = join(FIXTURE, "outside", "parent", "staging");
const STAGING_ARG = shellQuote(STAGING.replaceAll("\\", "/"));
const EXTRAS = [STAGING];

beforeAll(() => {
  mkdirSync(join(CWD, "sub"), { recursive: true });
  for (let index = 0; index < 6; index += 1) mkdirSync(join(CWD, `d${index}`));
  mkdirSync(join(STAGING, "x"), { recursive: true });
});

afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }));

// Reads are unfenced by default but retain the sensitive-path deny-list; test cwd tracking with writes and fenced reads.
function check(command: string, blockReads = false) {
  return findShellPathPolicyViolation(command, CWD, ROOT, EXTRAS, blockReads);
}

describe("shell path policy — working directory tracking", () => {
  it("blocks a WRITE climbing out of a shallow allowed directory reached by cd", () => {
    const violation = check(`cd ${STAGING_ARG} && cp ./staged ../../etc/evil`);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("sandbox-boundary");
  });

  it("blocks the same climb with a READ verb once reads are re-fenced", () => {
    const violation = check(`cd ${STAGING_ARG} && cat ../../etc/passwd`, true);
    expect(violation).not.toBeNull();
    expect(violation!.kind).toBe("sandbox-boundary");
  });

  it.each([
    [`cd ${STAGING_ARG} && mv ./staged ../etc/evil`, "one level up"],
    [`cd ${STAGING_ARG}; cp ./staged ./x/../../etc/evil`, "climb hidden mid-path"],
    [`cd ${STAGING_ARG} && head -1 ../../../etc/shadow`, "a sensitive file above"],
  ])("blocks %s (%s)", (command) => {
    expect(check(command)).not.toBeNull();
  });

  it.each([
    [`cd ${STAGING_ARG} && cat ../etc/passwd`, "one level up"],
    [`cd ${STAGING_ARG}; cat ./x/../../etc/passwd`, "climb hidden mid-path"],
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
    expect(check(`cd ${STAGING_ARG} && cat ../../etc/passwd`)).toBeNull();
    expect(check("cat ../../../../../etc/passwd")).toBeNull();
  });

  it.each([
    [`cd ${STAGING_ARG} && cat notes.txt`],
    ["cd .. && ls"],
    [`cd ${STAGING_ARG}`],
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
      expect(check(`cd -P ${STAGING_ARG} && cat notes.txt`)).toBeNull();
    });
  });

  // The destination can disappear before execution; a failed cd leaves the shell in the starting directory.
  describe("a cd whose destination exists during analysis", () => {
    it.each(["cd sub; touch ../../../../escape.txt", "cd sub || touch ../../../../escape.txt"])(
      "checks the statement after %s from the starting directory", (command) => {
        expect(check(command)).toMatchObject({ kind: "sandbox-boundary", candidate: "../../../../escape.txt", path: join(FIXTURE, "escape.txt") });
      });

    it.each([
      "cd sub; ls; cd ..",
      "cd sub; touch x; cd ..; touch y",
      "cd sub; cd ..; touch y",
      "cd sub; touch ../y",
      "cd sub && touch ../../../../y",
      "cd sub; ls; cd -",
      "cd sub && ls; cd -",
    ])("leaves %s as it is when the failed path stays inside", (command) => {
      expect(check(command)).toBeNull();
      expect(check(command, true)).toBeNull();
    });

    it.each(["cd src; ls; cd ..", "cd src; touch x; cd ..; touch y"])("leaves %s from the root as it is", (command) => {
      expect(findShellPathPolicyViolation(command, ROOT, ROOT, EXTRAS, true)).toBeNull();
    });

    it("keeps checking a path that a modeled fault path also reaches", () => {
      const root = shellQuote(ROOT.replaceAll("\\", "/"));
      expect(findShellPathPolicyViolation(`cd src; cd ${root} && cd src; cd ../..`, ROOT, ROOT, EXTRAS, true)).toMatchObject({ kind: "sandbox-boundary" });
    });

    it("keeps repeated navigation bounded", () => {
      const scripts = [
        Array.from({ length: 20 }, () => "cd sub && cd ..").join("; "),
        Array.from({ length: 20 }, () => "cd sub; cd ..").join("; "),
        `${Array.from({ length: 6 }, (_, index) => `cd d${index}; cd ..`).join("; ")}; touch w`,
      ];
      const start = performance.now();
      for (const script of scripts) expect(check(script, true)).toBeNull();
      expect(performance.now() - start).toBeLessThan(5_000);
    });
  });
});
