// Resolve operands against each possible execution directory, including changes made by cd.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shellQuote } from "../../lib/shell-resolver.js";
import type { ShellExecutionFacts } from "../../shared/shell-execution.js";
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
  for (const name of ["a", "b", "c", "sub", "prior", ...Array.from({ length: 8 }, (_, index) => `d${index}`)]) mkdirSync(join(ROOT, name));
  for (let index = 0; index < 8; index += 1) mkdirSync(join(ROOT, "a", `d${index}`));
  mkdirSync(join(ROOT, "sub", "s2"));
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

  // On an unsandboxed host route the destination can disappear before execution; a failed cd leaves the shell where it was.
  describe("a cd whose destination exists during analysis", () => {
    const hostFacts = (environment: Record<string, string> = {}): ShellExecutionFacts => ({ dialect: "bash", environment, hostCdFaults: true });
    const host = (command: string, blockReads = false) => findShellPathPolicyViolation(command, CWD, ROOT, EXTRAS, blockReads, hostFacts());
    const atRoot = (command: string, environment: Record<string, string> = {}) => findShellPathPolicyViolation(command, ROOT, ROOT, EXTRAS, true, hostFacts(environment));
    const repeat = (count: number, step: (index: number) => string) => Array.from({ length: count }, (_, index) => step(index)).join("; ");

    it.each(["cd sub; touch ../../../../escape.txt", "cd sub || touch ../../../../escape.txt"])(
      "checks the statement after %s from the starting directory", (command) => {
        expect(host(command)).toMatchObject({ kind: "sandbox-boundary", candidate: "../../../../escape.txt", path: join(FIXTURE, "escape.txt") });
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
      expect(host(command)).toBeNull();
      expect(host(command, true)).toBeNull();
    });

    it.each(["cd src; ls; cd ..", "cd src; touch x; cd ..; touch y"])("leaves %s from the root as it is", (command) => {
      expect(atRoot(command)).toBeNull();
    });

    it("keeps checking a path that a modeled fault path also reaches", () => {
      const root = shellQuote(ROOT.replaceAll("\\", "/"));
      expect(atRoot(`cd src; cd ${root} && cd src; cd ../..`)).toMatchObject({ kind: "sandbox-boundary" });
    });

    it("models no cd fault on a sandboxed route", () => {
      expect(findShellPathPolicyViolation("cd sub; touch ../y", ROOT, ROOT, EXTRAS, true)).toBeNull();
      expect(atRoot("cd sub; touch ../y")).toMatchObject({ kind: "sandbox-boundary" });
    });

    it.each([
      "cd a || exit 1; cd ..; cd b; ls; cd ..",
      "cd a || ls; cd ..; cd b; ls; cd ..",
      "cd a || mkdir m; cd ..; cd b; ls; cd ..",
      "cd a || echo no > note; cd ..; cd b; ls; cd ..",
      `cd a || exit 1; cd ..; ${repeat(6, (index) => `cd d${index}; cd ..`)}; touch w`,
    ])("keeps the effects of a fault path on that path: %s", (command) => {
      expect(atRoot(command)).toBeNull();
    });

    it.each([
      `cd a || exit 1; ${repeat(8, (index) => `if cd d${index}; then v${index}=1; cd ..; fi`)}`,
      `cd a || exit 1; cd ..; ${repeat(20, () => "cd sub && cd ..")}`,
    ])("keeps a fault path with effects bounded: %s", (command) => {
      const start = performance.now();
      expect(atRoot(command)).toBeNull();
      expect(performance.now() - start).toBeLessThan(5_000);
    });

    it.each(["pushd .", "popd", "eval \"$Q\"", ". ./missing.sh", "cd \"$(pwd)\""])(
      "stops a fault path at %s as it stops a normal path", (step) => {
        const normal = atRoot(`${step}; touch ../x`);
        expect(normal).not.toBeNull();
        expect(atRoot(`cd sub || ${step}; touch ../x`)?.kind).toBe(normal?.kind);
        expect(atRoot(`cd sub || { ${step}; touch ../x; }`)?.kind).toBe(normal?.kind);
      });

    it.each([
      "cd sub || exit 1; touch ../x",
      "cd sub || { echo no >&2; exit 1; }; touch ../x",
      "set -e; cd sub; touch ../x",
    ])("ends the fault path where %s stops the shell", (command) => {
      expect(atRoot(command)).toBeNull();
    });

    it.each([
      "set -e; if cd sub; then :; fi; touch ../x",
      "set -e; cd sub || :; touch ../x",
      "set -e; set +e; cd sub; touch ../x",
      "set -e; (set +e; cd sub; touch ../x)",
      "set -e; ! cd sub; touch ../x",
      "set -e; f() { cd sub; touch ../x; }; f || true",
      "set -e; (cd sub; touch ../x) || true",
    ])("keeps the fault path where errexit does not stop it: %s", (command) => {
      expect(atRoot(command)).toMatchObject({ kind: "sandbox-boundary" });
    });

    it("keeps a fault path whose OLDPWD differs", () => {
      const outside = join(FIXTURE, "outside");
      expect(atRoot("cd a && cd ..; touch \"$OLDPWD/x\"", { OLDPWD: outside })).toMatchObject({ kind: "sandbox-boundary" });
    });

    it.each(["f() { cd sub || return 1; }; f; touch ../x", "cd sub || return 1; touch ../x"])("does not end the fault path at return: %s", (command) => {
      expect(atRoot(command)).toMatchObject({ kind: "dynamic-path" });
    });

    it("stops at a cd after a fault path changed the filesystem", () => {
      expect(atRoot("cd a || { mkdir n && cd n && touch ../../x; }")).toMatchObject({ kind: "dynamic-path" });
      expect(atRoot("cd a || mkdir m; cd sub; ls")).toMatchObject({ kind: "dynamic-path" });
      expect(atRoot("cd sub; cd s2 || mkdir m; cd ..; ls")).toBeNull();
    });

    it.each([
      "cd c || (rm -rf d0); cd d0; touch ../x",
      "cd c || (rm -rf d0; exit 1); cd d0; touch ../x",
      "cd c || rm -rf d0 | cat; cd d0; touch ../x",
      "cd c || echo \"$(rm -rf d0)\"; cd d0; touch ../x",
      "cd c || x=\"$(rm -rf d0)\"; cd d0; touch ../x",
      "cd c || case \"$(rm -rf d0)\" in *) ;; esac; cd d0; touch ../x",
    ])("carries a change made in a child process to its fault path: %s", (command) => {
      expect(atRoot(command)).toMatchObject({ kind: "dynamic-path" });
    });

    it.each([
      `cd a || mkdir -p a; ${repeat(8, (index) => `cd d${index} && test -f m && cd ..`)}`,
      `cd b || mkdir -p b; ${repeat(8, (index) => `cd d${index} && test -f m && cd ..`)}`,
      `cd b || true; ${repeat(8, (index) => `cd d${index} && make && cd ..`)}`,
      `cd a || ls; ${repeat(6, (index) => `cd d${index}`)}`,
      ...["ls", "true", "echo skip"].map((fallback) => `cd "$R/c" || ${fallback}; ${repeat(8, (index) => `cd "$R/d${index}" && make; cd "$R"`)}`),
    ])("ends a changed fault path in an ordinary ask: %s", (command) => {
      const start = performance.now();
      const violation = atRoot(command, { R: ROOT.replaceAll("\\", "/") });
      expect(performance.now() - start).toBeLessThan(5_000);
      expect(violation).toMatchObject({ kind: "dynamic-path" });
    });

    it("models a failing fallback cd", () => {
      expect(atRoot("cd a || cd b; touch ../x")).toMatchObject({ kind: "sandbox-boundary" });
      expect(atRoot("cd a || cd b || cd sub; ls")).toBeNull();
    });

    it("prefers the fault-free state when a loop revisits the same state", () => {
      const script = "s=0; while :; do if test \"$s\" = 0; then if cd a; then s=2; else s=1; fi; elif test \"$s\" = 2; then cd ../prior && cd ..; s=1; else cd ../..; break; fi; done";
      expect(atRoot(script, { OLDPWD: join(ROOT, "prior") })).toMatchObject({ kind: "sandbox-boundary" });
    });

    it("keeps repeated navigation bounded", () => {
      const scripts = [
        repeat(20, () => "cd sub && cd .."),
        repeat(20, () => "cd sub; cd .."),
        `${repeat(6, (index) => `cd d${index}; cd ..`)}; touch w`,
      ];
      const start = performance.now();
      for (const script of scripts) expect(host(script, true)).toBeNull();
      expect(performance.now() - start).toBeLessThan(5_000);
    });
  });
});
