// Resolve operands against each possible execution directory, including changes made by cd.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shellQuote } from "../../lib/shell-resolver.js";
import type { HostShellFallbackReason } from "../../permissions/host-shell-execution-plan.js";
import { configureHostResources } from "../../main/host-resources.js";
import type { ShellExecutionFacts } from "../../shared/shell-execution.js";
import { hostShellAnalysisFacts } from "../prepared-shell-invocation.js";
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
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  mkdirSync(join(CWD, "sub"), { recursive: true });
  for (const name of ["a", "b", "c", "sub", "build", "test", "prior", ...Array.from({ length: 8 }, (_, index) => `d${index}`)]) mkdirSync(join(ROOT, name));
  for (let index = 0; index < 8; index += 1) mkdirSync(join(ROOT, "a", `d${index}`));
  mkdirSync(join(ROOT, "sub", "s2", "s3"), { recursive: true });
  mkdirSync(join(ROOT, "sub", "t2"));
  symlinkSync(join(ROOT, "sub"), join(ROOT, "lnk"), "junction");
  writeFileSync(join(ROOT, "flag"), "");
  writeFileSync(join(ROOT, "src", "foo.ts"), "");
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

  it("checks the success body against a cd destination missing during analysis", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "shell-cwd-tracking-")));
    try {
      expect(existsSync(join(root, "missing"))).toBe(false);
      expect(findShellPathPolicyViolation("cd missing && cat ../../outside.txt", root, root, [], true)).toMatchObject({
        kind: "sandbox-boundary",
        candidate: "../../outside.txt",
        path: join(dirname(root), "outside.txt"),
      });
    } finally {
      rmdirSync(root);
    }
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

  // On an unsandboxed host route an observed destination can vanish before execution; a failed cd leaves the shell where it was.
  describe("an unsandboxed host cd that may fail at execution", () => {
    const R = ROOT.replaceAll("\\", "/");
    const hostFacts = (environment: Record<string, string> = {}): ShellExecutionFacts => ({ dialect: "bash", environment: { R, ...environment }, hostCdFaults: true });
    const host = (command: string, environment?: Record<string, string>) => findShellPathPolicyViolation(command, ROOT, ROOT, EXTRAS, true, hostFacts(environment));
    const verdict = (command: string, environment?: Record<string, string>) => host(command, environment)?.kind ?? null;
    const repeat = (count: number, step: (index: number) => string) => Array.from({ length: count }, (_, index) => step(index)).join("; ");
    const absolute = (count: number) => repeat(count, (index) => `cd "$R/d${index % 8}" && make; cd "$R"`);
    const unrolled = (count: number) => repeat(count, (index) => `cd "$R/d${index % 8}" && make`);
    const forLoop = (count: number) => `for d in ${Array.from({ length: count }, (_, index) => `d${index % 8}`).join(" ")}; do cd "$R/$d" && make; done`;
    const nested = (count: number) => repeat(count, (index) => `cd d${index} && test -f m && cd ..`);
    const made = (count: number) => repeat(count, (index) => `cd d${index} && make && cd ..`);
    const tests = (count: number) => repeat(count, (index) => `if test -f q${index}; then v${index}=1; fi`);
    const listed = (count: number) => repeat(count, (index) => `cd "$R/d${index % 8}" && ls; cd "$R"`);
    const listedLoop = (count: number) => `for d in ${Array.from({ length: count }, (_, index) => `d${index % 8}`).join(" ")}; do cd "$R/$d" && ls; cd "$R"; done`;

    it.each([
      ["E1", "cd sub; touch ../y"],
      ["E2", "cd sub || touch ../y"],
      ["E3", "cd sub; cd s2; touch ../../y"],
      ["E4", "cd a || cd b; touch ../x"],
      ["E6", "cd sub; cat ../outside.txt"],
      ["C1", "cd c || (rm -rf d0); cd d0; touch ../x"],
      ["C2", "cd c || rm -rf d0 | cat; cd d0; touch ../x"],
      ["C3", "cd c || echo \"$(rm -rf d0)\"; cd d0; touch ../x"],
      ["C4", "cd c || rm -rf d0; cd d0; touch ../x"],
      ["C5", "cd c || { rm -rf d0; }; cd d0; touch ../x"],
      ["W1", "cd \"$R/c\" && make; while [ -e flag ]; do rm -rf \"$R/d0\"; done; cd \"$R/d0\"; touch ../x"],
      ["W2", "cd \"$R/c\" || true; while [ -e flag ]; do rm -rf \"$R/d0\"; done; cd \"$R/d0\"; touch ../x"],
      ["W3", "cd \"$R/c\" && make; until [ -e zz ]; do rm -rf \"$R/d0\"; done; cd \"$R/d0\"; touch ../x"],
      ["F1", "cd \"$R/c\" && make || cd \"$R/d0\"; touch ../x"],
      ["F2", "cd \"$R/c\" && make || cd \"$R/a\"; touch ../x"],
      ["F3", "cd \"$R/c\" && true || cd \"$R/d0\"; touch ../x"],
      ["B7", "cd c && make; cd missing && touch ../../x"],
      ["B8", "cd \"$R/c\" || true; rm -rf \"$R/d0\"; cd \"$R/d0\"; touch ../x"],
      ["X1", "cd a || { mkdir n && cd n && touch ../../x; }"],
      ["X14", `cd "$R/c" || true; ${absolute(16)}; cd sub; touch ../../x`],
      ["V9", "cd \"$R/c\" || true; f(){ rm -rf \"$R/d0\"; }; f; cd \"$R/d0\"; touch ../x"],
      ["V10", "cd \"$R/c\" || true; if rm -rf \"$R/d0\"; then :; fi; cd \"$R/d0\"; touch ../x"],
      ["V11", "cd \"$R/c\" || true; mkdir zz & rm -rf \"$R/d0\" & cd \"$R/d0\"; touch ../x"],
      ["D1", "cd \"$R/c\" || true; cd -; cd -; touch ../x"],
      ["A1", "cd a || mkdir n; cd n/..; touch ../x"],
      ["A2", "cd sub; cd s2 || mkdir n; cd n/../..; touch ../x"],
      ["T1", "test -f q && cd sub; cd sub; touch ../x"],
      ["A4", "cd sub; cd s2 || mkdir -p n/m; cd n/m/../../..; touch ../w"],
      ["SR1", "cd sub; cd \"$R/sub\"; touch ../x"],
      ["SR4", "cd sub/s2; cd \"$R/sub/s2\"; touch ../../x"],
      ["SR5", "cd \"$R/sub\" || true; cd \"$R/sub\"; touch ../x"],
      ["EX1", "cd sub || exit foo; touch ../x"],
      ["EX2", "cd sub || exit 1 < nofile; touch ../x"],
      ["EX3", "cd sub || exit 1 2; touch ../x"],
      ["EX4", "cd sub || exit \"$NOPE\"x; touch ../x"],
      ["EX5", "set -e; cd sub || exit foo; touch ../x"],
    ])("asks where a failed cd lets %s escape: %s", (_row, command) => {
      expect(verdict(command)).toBe("sandbox-boundary");
    });

    it.each([
      ["E5", "cd sub || pushd .; touch ../x"],
      ["R1", "cd sub || return 1; touch ../x"],
      ["R2", "f() { cd sub || return 1; }; f; touch ../x"],
      ["O18", "cd sub; cd \"$OLDPWD\""],
      ["O19", "cd a && cd ..; touch \"$OLDPWD/x\""],
      ["L2", `cd "$R/c" && make; cd "$R/a" || true; ${repeat(8, () => "cd \"$OLDPWD\"")}`],
    ])("declines %s as an unresolved working directory: %s", (_row, command) => {
      expect(verdict(command)).toBe("dynamic-path");
    });

    it.each([
      ["P3 (FOR8)", forLoop(8)],
      ["P6", `cd a || mkdir -p a; ${nested(8)}`],
      ["U4", `cd a || ls; ${made(8)}`],
      ["U5", `cd a || true; ${made(8)}`],
      ["X10", `cd b || mkdir -p b; ${nested(8)}`],
      ["X15", repeat(40, () => "cd sub && make && cd ..")],
      ["X16", `cd a; make; ${repeat(12, (index) => `cd "$R/d${index % 8}"; make`)}; touch x`],
      ["L3", `cd "$R/c" && make; cd "$R/a" || true; ${repeat(8, (index) => `cd d${index} || mkdir d${index}`)}`],
      ["UN8", unrolled(8)],
      ["UN12", unrolled(12)],
      ["FOR12", forLoop(12)],
      ["FOR10", forLoop(10)],
      ["UN10", unrolled(10)],
      ["P6a", `cd a || mkdir -p a; ${nested(6)}`],
      ["X9", `cd a || ls; ${repeat(6, (index) => `cd d${index}`)}`],
      ["SUBR16", repeat(16, () => "cd sub && ls && cd ..")],
      ["SUBR32", repeat(32, () => "cd sub && ls && cd ..")],
      ["FORR24", listedLoop(24)],
      ["eight conditional directory changes", `cd a || exit 1; ${repeat(8, (index) => `if cd d${index}; then v${index}=1; cd ..; fi`)}`],
      ["IF16 (cap)", `cd a || exit 1; ${repeat(16, (index) => `if cd d${index % 8}; then v${index}=1; cd ..; fi`)}`],
      ["NAV20 (cap)", `cd a || exit 1; cd ..; ${repeat(20, () => "cd sub && cd ..")}`],
      ["IFC24 (cap)", `cd a || exit 1; ${repeat(24, (index) => `if cd d${index % 8}; then v${index}=1; cd ..; fi`)}`],
      ["IFT16 (cap)", `cd a || true; ${repeat(16, (index) => `if cd d${index % 8}; then v${index}=1; cd ..; fi`)}`],
    ])("ends an exhausted cd budget in an ordinary ask, not a deny: %s", (_row, command) => {
      expect(verdict(command)).toBe("dynamic-path");
    });

    it.each([
      ["P1", absolute(8)],
      ["P2", "for d in a b c; do cd $d && make && cd ..; done"],
      ["P4", `cd "$R/c" || true; ${absolute(8)}`],
      ["P5", `cd "$R/c" || echo skip; ${absolute(8)}`],
      ["P6'", `cd "$R/c" || mkdir -p "$R/c"; ${absolute(6)}`],
      ["U1", "cd \"$R/d0\" && make; cd \"$R/d1\" && make; cd \"$R/d2\" && make"],
      ["U3", `cd "$R/c" || ls; ${absolute(8)}`],
      ["UN6", unrolled(6)],
      ["FOR6", forLoop(6)],
      ["X2", "cd a || mkdir m; cd sub; ls"],
      ["X3", "cd sub; cd s2 || mkdir m; cd ..; ls"],
      ["X5", "cd a || cd b || cd sub; ls"],
      ["X11", `cd "$R/c" || true; ${absolute(16)}`],
      ["X13", absolute(24)],
      ["X12", `cd "$R/c" || true; ${absolute(24)}`],
      ["FORR12", listedLoop(12)],
      ["UNR16", listed(16)],
      ["UNR32", listed(32)],
      ["O16", "cd build || mkdir build; cd build; make"],
      ["B1", "cd \"$R/c\" || true; mkdir zz; cd \"$R/d0\"; touch x"],
      ["B2", "cd \"$R/c\" || true; (mkdir zz); cd \"$R/d0\"; touch x"],
      ["B3", "cd \"$R/c\" || true; x=$(mkdir zz); cd \"$R/d0\"; touch x"],
      ["B4", "cd \"$R/c\" || true; rm -rf d1; cd \"$R/d0\"; touch x"],
      ["V1", "cd \"$R/c\" || true; f(){ mkdir zz; }; f; cd \"$R/d0\"; touch x"],
      ["V2", "cd \"$R/c\" || true; for i in 1; do mkdir zz; done; cd \"$R/d0\"; touch x"],
      ["V3", "cd \"$R/c\" || true; if mkdir zz; then :; fi; cd \"$R/d0\"; touch x"],
      ["V4", "cd \"$R/c\" || true; ! mkdir zz; cd \"$R/d0\"; touch x"],
      ["V5", "cd \"$R/c\" || true; { mkdir zz; } > out; cd \"$R/d0\"; touch x"],
      ["V6", "cd \"$R/c\" || true; echo hi > out; cd \"$R/d0\"; touch x"],
      ["V7", "cd \"$R/c\" || true; mkdir zz & cd \"$R/d0\"; touch x"],
      ["V8", "cd \"$R/c\" || true; (mkdir zz) & cd \"$R/d0\"; touch x"],
      ["L1", `cd "$R/c" && make; cd "$R/a" || true; ${repeat(8, () => "cd -")}`],
      ["L5", "for d in a b c; do cd $d || exit 1; make; cd ..; done"],
      ["U2", "cd \"$R/a\" || true; g() { cd \"$1\" && make; cd ..; }; g d0; g d1; g d2; g d3"],
      ["A3", "cd sub; cd s2 || mkdir n; cd n/../..; touch y"],
    ])("leaves %s as it is when no failed cd escapes: %s", (_row, command) => {
      expect(verdict(command)).toBeNull();
    });

    it.each([
      "cd a || exit 1; cd ..; cd b; ls; cd ..",
      "cd a || ls; cd ..; cd b; ls; cd ..",
      "cd a || mkdir m; cd ..; cd b; ls; cd ..",
      "cd sub || exit 1; touch ../x",
      "cd sub || { echo no >&2; exit 1; }; touch ../x",
      "set -e; cd sub; touch ../x",
      "set -e; cd build; make; cd ..; cd src; make",
      "cd build || exit; make",
      "cd a && make; cd ../b && make",
      "mkdir -p build && cd build && make",
      "cd build || echo 'no build' >&2; ls",
      "cd src && git status; cd ../test && ls",
      "cd a; make; cd -",
      "for d in a b c; do (cd $d && make); done",
      "cd sub; ls; cd -",
      "cd src; cat foo.ts",
      "cd sub; touch y",
      "cd build && cmake ..",
      "cd a; ls; cd ../b; ls",
      "cd a; make; cd d0; ls x",
      "cd sub && touch y; cd s2 && touch z",
      "cd \"$R/c\" && make; while [ -e flag ]; do make clean; done; cd \"$R/d0\" && touch ../x",
      "cd sub; cd ..; touch y",
    ])("leaves ordinary navigation as it is: %s", (command) => {
      expect(verdict(command)).toBeNull();
    });

    it.each([
      "set -e; if cd sub; then :; fi; touch ../x",
      "set -e; cd sub || :; touch ../x",
      "set -e; set +e; cd sub; touch ../x",
      "set -e; (set +e; cd sub; touch ../x)",
      "set -e; ! cd sub; touch ../x",
      "set -e; f() { cd sub; touch ../x; }; f || true",
      "set -e; (cd sub; touch ../x) || true",
      "set -e; x=$(cd sub; touch ../x)",
    ])("keeps the fault path where errexit does not stop it: %s", (command) => {
      expect(verdict(command)).toBe("sandbox-boundary");
    });

    it.each(["pushd .", "popd", "eval \"$Q\"", ". ./missing.sh", "cd \"$(pwd)\""])("stops a fault path at %s as it stops a normal path", (step) => {
      const normal = verdict(`${step}; touch ../x`);
      expect(normal).not.toBeNull();
      expect(verdict(`cd sub || ${step}; touch ../x`)).toBe(normal);
      expect(verdict(`cd sub || { ${step}; touch ../x; }`)).toBe(normal);
    });

    it("keeps a fault path whose OLDPWD differs", () => {
      expect(verdict("cd a && cd ..; touch \"$OLDPWD/x\"", { OLDPWD: join(FIXTURE, "outside") })).toBe("sandbox-boundary");
    });

    it("continues a fault path in the parent when it ends inside a subshell", () => {
      expect(verdict("cd sub; (exit 1); touch ../x")).toBe("sandbox-boundary");
    });

    it("ends a fault path that leaves the starting directory", () => {
      expect(verdict("cd sub; cd ../b; touch ../x")).toBeNull();
    });

    it("models no cd fault on a sandboxed route", () => {
      expect(findShellPathPolicyViolation("cd sub; touch ../y", ROOT, ROOT, EXTRAS, true, { dialect: "bash", environment: {} })).toBeNull();
      expect(verdict("cd sub; touch ../y")).toBe("sandbox-boundary");
    });

    // The state limit gives the ordinary ask only when the states differ in nothing but the working directory.
    const values = Array.from({ length: 64 }, (_, index) => index).join(" ");
    const steps = `for i in ${values}; do for j in ${values}; do for k in ${values}; do :; done; done; done`;
    it.each([
      ["test -f chain", tests(7), "analysis-limit"],
      ["cd then test -f chain", `cd sub; ${tests(7)}`, "analysis-limit"],
      ["cd, test -f chain, then a read", `cd sub; ${tests(7)}; cat /etc/passwd`, "analysis-limit"],
      ["fallible cd then test -f chain", `cd a || true; ${tests(7)}`, "analysis-limit"],
      ["guarded cd then test -f chain", `cd a || exit 1; ${tests(7)}`, "analysis-limit"],
      ["nested loops", steps, "analysis-limit"],
      ["fallible cd then nested loops", `cd a || true; ${steps}`, "analysis-limit"],
    ] as const)("gives the state-limit verdict for a %s", (_label, command, expected) => {
      expect(verdict(command)).toBe(expected);
    });

    // On Windows each cd state observes its destination with its own helper launch: this row takes 65 launches (63 cd
    // observations, the working-directory check and one operand batch), measured at 7.1 s alone and 11.8 s on a loaded host.
    // The 79 s timeout is 2x the 39.1 s main median of the whole state-limit set, measured back-to-back on 2026-11-25
    // (this branch: 47.2 s).
    it("gives a dynamic-path verdict when each conditional cd adds a working-directory state", () => {
      expect(verdict(`cd a || true; ${repeat(7, (index) => `if test -f q${index}; then cd e${index}; fi`)}`)).toBe("dynamic-path");
    }, 79_000);

    it("asks past the cap on forks without a possible filesystem change", () => {
      expect(verdict(`${repeat(15, () => "cd sub; cd ..")}; cd sub; touch ../y`)).toBe("sandbox-boundary");
      expect(verdict(`${repeat(16, () => "cd sub; cd ..")}; cd sub; touch ../y`)).toBe("dynamic-path");
      const words = (count: number) => Array.from({ length: count }, (_, index) => index).join(" ");
      expect(verdict(`for i in ${words(15)}; do cd sub; cd ..; done; cd sub; touch ../y`)).toBe("sandbox-boundary");
      expect(verdict(`for i in ${words(16)}; do cd sub; cd ..; done; cd sub; touch ../y`)).toBe("dynamic-path");
    });

    it("takes success only for a cd to an ancestor or the current directory, even after a possible change", () => {
      expect(verdict(`make; ${repeat(8, (index) => `cd "$R/d${index}" && ls; cd "$R"`)}`)).toBeNull();
      expect(verdict(`cd "$R/c" || true; ${absolute(8)}`)).toBeNull();
    });


    // On a fault path every cd that does not stay in the current directory or move to an ancestor forks again: a removed working
    // directory keeps resolving relative operands from its old path, and links or a second removal can fail any later cd.
    it.each([
      ["REL-anc-ancq", "cd sub/s2; cd \"$R\"; ls", null],
      ["REL-disj-ancq", "cd a; cd ../b; cd \"$R/a\"; ls", null],
      ["REL-eq-desc (SR1)", "cd sub; cd \"$R/sub\"; touch ../x", "sandbox-boundary"],
      ["REL-desc-desc", "cd sub; cd \"$R/sub/s2\"; touch ../../x", "sandbox-boundary"],
      ["REL-anc-desc (ANC1)", "cd sub/s2; cd \"$R/sub\"; touch ../x", "sandbox-boundary"],
      ["ANC2", "cd sub/s2/s3; cd \"$R/sub\"; touch ../x", "sandbox-boundary"],
      ["ANC3", "cd sub/s2 || true; cd sub; touch ../x", "sandbox-boundary"],
      ["REL-disj-desc", "cd sub/s2; cd \"$R/sub/t2\"; touch ../../x", "sandbox-boundary"],
      ["absolute sibling destination from the failed branch", "cd sub; cd \"$R/a\"; touch ../x", "sandbox-boundary"],
      ["REL-eq-disj", "cd a; cd ../sub/s2; cd \"$R/sub/s2\"; touch ../../x", "sandbox-boundary"],
      ["REL-desc-disj", "cd a; cd ../sub; cd \"$R/sub/s2\"; touch ../../x", "sandbox-boundary"],
      ["REL-anc-disj", "cd a; cd ../sub/s2/s3; cd \"$R/sub/s2\"; touch ../../x", "sandbox-boundary"],
      ["REL-disj-disj", "cd a; cd ../sub/s2; cd \"$R/sub/t2\"; touch ../../x", "sandbox-boundary"],
      // On Windows the non-ancestor `..` spelling observes "unknown", so the fault path still forks.
      ["absolute destination after two sibling branches", "cd b; cd ../sub/s2; cd \"$R/a/d0\"; touch ../../x", "sandbox-boundary"],
      ["absolute destination after two descendant branches", "cd sub; cd s2; cd \"$R/sub/t2\"; touch ../../x", "sandbox-boundary"],
    ])("models a later cd against a recorded fault destination: %s: %s", (_cell, command, kind) => {
      expect(verdict(command)).toBe(kind);
    });

    it.each([
      "cd sub/s2; cd lnk; touch ../x",
      "cd sub; cd lnk/s2; touch ../../x",
      "cd lnk/s2; cd \"$R/sub\"; touch ../x",
      "cd sub/s2; cd -P lnk; touch ../x",
      "cd lnk; cd \"$R/sub/s2\"; touch ../../x",
    ])("forks a later cd that reaches a fault destination through a directory link: %s", (command) => {
      expect(verdict(command)).toBe("sandbox-boundary");
    });

    it("ends a fault path where it leaves the starting directory on a route that asks before every command", () => {
      expect(verdict("cd \"$R/sub/s2\"; cd ..; cd \"$R/sub\"; touch ../x")).toBeNull();
      expect(verdict("cd sub; cd ..; touch x")).toBeNull();
    });

    describe("where nothing else asks before the command runs", () => {
      const writes = (command: string) => findShellPathPolicyViolation(command, ROOT, ROOT, EXTRAS, true, { ...hostFacts(), hostCdFaultWrites: true })?.kind ?? null;

      it.each([
        "cd \"$R/sub/s2\"; cd ..; cd \"$R/sub\"; touch ../x",
        "cd sub; cd ..; touch x",
        "cd a; make; cd ..; touch stamp",
        "cd a && make; cd ..; touch stamp",
        "cd a; make; cd ..; echo done > stamp",
        "cd a; ls; cd ../b; touch y",
      ])("continues a fault path that leaves the starting directory and checks its writes: %s", (command) => {
        expect(writes(command)).toBe("sandbox-boundary");
      });

      it.each([
        "cd a || exit 1; make; cd ..; touch stamp",
        "set -e; cd a; make; cd ..; touch stamp",
        "cd a; ls; cd ../b; ls",
        "cd a; make; cd ..; cat stamp",
        "cd sub; ls; cd -",
      ])("leaves reads and stopped fault paths as they are: %s", (command) => {
        expect(writes(command)).toBeNull();
      });
    });

    it("keeps condition ladders without a cd as they are on main", () => {
      expect(verdict(`cd a || exit 1; ${repeat(48, (index) => `if test -f q${index}; then echo ${index}; fi`)}`)).toBeNull();
      expect(verdict(repeat(20, (index) => `test -f q${index} && echo ${index}`))).toBeNull();
      expect(verdict(tests(24))).toBe("analysis-limit");
    });

    it("models cd faults only for the unsandboxed host substrate", () => {
      const facts = (substrate: "none" | "asrt" | "mxc") => hostShellAnalysisFacts(undefined, { substrate, executionRequest: "default", fallbackReason: "none" });
      expect(findShellPathPolicyViolation("cd sub; touch ../y", ROOT, ROOT, EXTRAS, true, facts("none"))?.kind).toBe("sandbox-boundary");
      expect(findShellPathPolicyViolation("cd sub; touch ../y", ROOT, ROOT, EXTRAS, true, facts("asrt"))).toBeNull();
      expect(findShellPathPolicyViolation("cd sub; touch ../y", ROOT, ROOT, EXTRAS, true, facts("mxc"))).toBeNull();
    });

    it("continues fault paths past the starting directory only with the shell sandbox off", () => {
      const continues = (executionRequest: "default" | "host", fallbackReason: HostShellFallbackReason) =>
        hostShellAnalysisFacts(undefined, { substrate: "none", executionRequest, fallbackReason })?.hostCdFaultWrites === true;
      expect(continues("default", "disabled-by-setting")).toBe(true);
      expect(continues("default", "platform-unsupported")).toBe(true);
      expect(continues("host", "none")).toBe(false);
      expect(continues("default", "requested-sandbox-unavailable")).toBe(false);
      expect(continues("default", "windows-partial-shell-acl-unsafe")).toBe(false);
      expect(hostShellAnalysisFacts(undefined, { substrate: "asrt", executionRequest: "default", fallbackReason: "none" })).toBeUndefined();
    });
  });
});
