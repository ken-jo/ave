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

function asrtSource(file: string): string {
  return readFileSync(
    createRequire(import.meta.url).resolve(`@anthropic-ai/sandbox-runtime/dist/sandbox/${file}`),
    "utf8",
  );
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

  it("reads every Windows dependency error as incomplete srt-win setup", () => {
    expect(classifySandboxDependencyErrors("win32", [
      "Sandbox user is not provisioned (user=false, cred=false)",
      "WFP filters not installed under sublayer x",
    ])).toEqual(["windows-setup-incomplete"]);
  });

  it("refuses to classify a check that did not fail", () => {
    expect(() => classifySandboxDependencyErrors("linux", [])).toThrow(/without a dependency error/);
  });

  it("matches the wording the installed sandbox runtime actually emits", () => {
    const linux = asrtSource("linux-sandbox-utils.js");
    const manager = asrtSource("sandbox-manager.js");
    expect(linux).toContain("'bubblewrap (bwrap) not installed'");
    expect(linux).toContain("`bubblewrap (bwrap) not executable at ${");
    expect(linux).toContain("'socat not installed'");
    expect(linux).toContain("`socat not executable at ${");
    expect(manager).toContain("`ripgrep (${");
    expect(manager).toContain(") not found`");
  });
});
