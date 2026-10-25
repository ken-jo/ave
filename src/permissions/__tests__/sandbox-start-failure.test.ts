/**
 * The boot gate's one classifier for why ASRT could not start. The permission
 * card names these causes ("unavailable: bubblewrap (bwrap) is missing"), so a
 * renamed ASRT message must fail here, not degrade silently to the generic
 * cause.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { classifySandboxDependencyErrors } from "../sandbox-start-failure.js";
import { SrtWinIntegrityError } from "../srt-win-integrity.js";

it.each([
  ["srt-win-not-found", "windows-sandbox-missing"],
  ["srt-win-integrity-mismatch", "windows-sandbox-integrity-failed"],
] as const)("classifies %s by code across wrapping layers", (code, cause) => {
  const failure = new Error("wrapper", { cause: new Error("inner", { cause: new SrtWinIntegrityError(code) }) });
  expect(classifySandboxDependencyErrors("win32", ["unrelated wording"], failure)).toEqual([cause]);
});

it("terminates on an unknown cyclic cause chain", () => {
  const failure = new Error("cycle");
  failure.cause = failure;
  expect(classifySandboxDependencyErrors("win32", ["setup"], failure)).toEqual(["windows-setup-incomplete"]);
});

function asrtSource(file: string): string {
  return readFileSync(
    createRequire(import.meta.url).resolve(`@anthropic-ai/sandbox-runtime/dist/sandbox/${file}`),
    "utf8",
  );
}

/**
 * The message a string or template literal in the runtime's source produces,
 * found by a fragment of its text, with every `${...}` filled by a sample path
 * — the string the classifier would actually receive.
 */
function emitted(source: string, fragment: string): string {
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const body = match[1] ?? match[2] ?? "";
    if (body.includes(fragment)) return body.replace(/\$\{[^}]*\}/g, "/sample/path");
  }
  throw new Error(`no literal containing ${JSON.stringify(fragment)} in the installed sandbox runtime`);
}

describe("classifySandboxDependencyErrors", () => {
  it("names each missing Linux dependency, in order and without repeats", () => {
    expect(classifySandboxDependencyErrors("linux", [
      "bubblewrap (bwrap) not installed",
      "socat not installed",
      "ripgrep (rg) not found",
      "bubblewrap (bwrap) not executable at /usr/bin/bwrap",
    ])).toEqual(["missing-bwrap", "missing-socat", "missing-ripgrep"]);
  });

  it("reports a message it does not recognise as a failed check, never drops it", () => {
    expect(classifySandboxDependencyErrors("linux", ["Running as root is not supported"]))
      .toEqual(["dependency-check-failed"]);
  });

  it("reads Windows user and WFP errors as incomplete srt-win setup", () => {
    expect(classifySandboxDependencyErrors("win32", [
      "Sandbox user is not provisioned (user=false, cred=false)",
      "WFP filters not installed under sublayer x",
    ])).toEqual(["windows-setup-incomplete"]);
  });

  it("names a missing bundled srt-win binary apart from incomplete setup", () => {
    expect(classifySandboxDependencyErrors("win32", [
      "windows.srtWin.path is set to 'C:\\Program Files\\Ave\\srt-win.exe' but the file does not exist",
    ])).toEqual(["windows-sandbox-missing"]);
  });

  it("refuses to classify a check that did not fail", () => {
    expect(() => classifySandboxDependencyErrors("linux", [])).toThrow(/without a dependency error/);
  });

  it("classifies the messages the installed sandbox runtime actually emits", () => {
    const linux = asrtSource("linux-sandbox-utils.js");
    const manager = asrtSource("sandbox-manager.js");
    const windows = asrtSource("windows-sandbox-utils.js");
    expect(classifySandboxDependencyErrors("linux", [emitted(linux, "bubblewrap (bwrap) not installed")]))
      .toEqual(["missing-bwrap"]);
    expect(classifySandboxDependencyErrors("linux", [emitted(linux, "bubblewrap (bwrap) not executable at ")]))
      .toEqual(["missing-bwrap"]);
    expect(classifySandboxDependencyErrors("linux", [emitted(linux, "socat not installed")]))
      .toEqual(["missing-socat"]);
    expect(classifySandboxDependencyErrors("linux", [emitted(linux, "socat not executable at ")]))
      .toEqual(["missing-socat"]);
    expect(classifySandboxDependencyErrors("linux", [emitted(manager, "ripgrep (")]))
      .toEqual(["missing-ripgrep"]);
    expect(classifySandboxDependencyErrors("win32", [emitted(windows, "no srt-win path configured")]))
      .toEqual(["windows-sandbox-missing"]);
    expect(classifySandboxDependencyErrors("win32", [
      emitted(windows, "windows.srtWin.path is set to ") + emitted(windows, "not exist"),
    ])).toEqual(["windows-sandbox-missing"]);
    expect(classifySandboxDependencyErrors("win32", [emitted(windows, "Sandbox user is not provisioned (user=")]))
      .toEqual(["windows-setup-incomplete"]);
  });
;
});
