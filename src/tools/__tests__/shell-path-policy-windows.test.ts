import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { findResolvedShellPathViolation, findShellPathPolicyViolation, validateShellWorkingDirectory } from "../shell-path-policy.js";

// Native path resolution and namespace aliases are specific to this host.
describe.skipIf(process.platform !== "win32")("native shell path aliases", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  const aliases: ReadonlyArray<(root: string) => string> = [
    root => `${root.toLowerCase()}\\.AWS\\credentials`,
    root => `${root}\\.aws\\credentials`,
    root => `${root.replaceAll("\\", "/")}/.aws\\credentials`,
    root => `\\\\?\\${root}\\.aws\\credentials`,
    root => `\\\\.\\${root}\\.aws\\credentials`,
    root => `${root}\\.aws.\\credentials`,
    root => `${root}\\.aws \\credentials`,
    root => `${root}\\.aws. \\credentials`,
    root => `${root}\\.gitconfig:stream`,
    root => `${root}\\.env:stream`,
  ];

  it.each(aliases.map((alias, index) => [index, alias] as const))("blocks sensitive alias %i for both effects and read-fence settings", (_index, alias) => {
    const root = mkdtempSync(join(tmpdir(), "shell-alias-"));
    roots.push(root);
    const path = alias(root);
    for (const effect of ["read", "write"] as const) {
      for (const fenced of [false, true]) {
        expect(findResolvedShellPathViolation(path, path, root, [], effect, fenced), path)
          .toMatchObject({ kind: "sensitive-path" });
      }
    }
    expect(findShellPathPolicyViolation(`cat ${shellQuote(path)}`, root, root, [], false), path)
      .toMatchObject({ kind: "sensitive-path" });
    expect(findShellPathPolicyViolation(`sort -o${shellQuote(path)} input.txt`, root, root, [], false), path)
      .toMatchObject({ kind: "sensitive-path" });
  });

  it.each([
    "C:\\EXAMPL~1\\file.txt",
    "report~1.txt",
    "C:\\ordinary\\file.txt:stream",
    "C:\\ordinary. \\file.txt",
    "\\\\.\\PhysicalDrive0",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.txt",
  ])("refuses unresolved native authority before allowing wide reads: %s", path => {
    expect(findResolvedShellPathViolation(path, path, process.cwd(), [], "read", false)).not.toBeNull();
  });

  it.each([
    "sort '-o=x\\..\\.ENV' input.txt",
    "curl '-K=x\\..\\.AWS\\credentials' https://example.invalid/",
    "curl '-o=x\\..\\.ENV' https://example.invalid/",
    "wget '-O=x\\..\\.ENV' https://example.invalid/",
  ])("checks native paths after a leading equals sign in a short option: %s", command => {
    for (const fenced of [false, true]) {
      expect(findShellPathPolicyViolation(command, process.cwd(), process.cwd(), [], fenced))
        .toMatchObject({ kind: "sensitive-path" });
    }
  });

  it.each([
    "sort '-o1\\..\\.ENV' input.txt",
    "curl '-K1\\..\\.AWS\\credentials' https://example.invalid/",
    "wget '-O1\\..\\.ENV' https://example.invalid/",
    "cp '-t1\\..\\.SSH' input.txt",
    ...["_x", "@x", "-x", "한", " x"].map(prefix => `sort '-o${prefix}\\..\\.ENV' input.txt`),
    "sort '-ro1\\..\\.ENV' input.txt",
    "curl '-sSK1\\..\\.AWS\\credentials' https://example.invalid/",
    "sort '-o1\\..\\.env:stream' input.txt",
  ])("checks complete native paths in attached short-option values: %s", command => {
    for (const fenced of [false, true]) {
      expect(findShellPathPolicyViolation(command, process.cwd(), process.cwd(), [], fenced))
        .toMatchObject({ kind: "sensitive-path" });
    }
  });

  it.each([
    "sort -oresults.env in",
    "sort '-ooutput\\result.txt' in",
    "sort '-rooutput\\result.txt' in",
    "sort '-o-x\\..\\result.txt' in",
  ])("preserves ordinary complete native output paths: %s", command => {
    expect(findShellPathPolicyViolation(command, process.cwd(), process.cwd(), [], true)).toBeNull();
  });

  it.each([
    "sort '-oC:.env' input.txt",
    "curl '-oC:.env' https://example.invalid/",
    "sort '--output=C:.env' input.txt",
    "curl '--output=C:.env' https://example.invalid/",
    "sort '-oc:foo' input.txt",
    "curl '-oc:foo' https://example.invalid/",
    "sort '-oC:.env.local=value' input.txt",
    'sort -o"C:.env.local=value" input.txt',
    "curl '-oC:.aws/credentials=foo' https://example.invalid/",
    "sort -o C:.env input.txt",
    "curl -o C:.env https://example.invalid/",
  ])("refuses drive-relative option paths: %s", command => {
    expect(findShellPathPolicyViolation(command, process.cwd(), process.cwd(), [], false))
      .toMatchObject({ kind: "invalid-path" });
  });

  it.each(["CON", "NUL", "COM1.txt"])("keeps ordinary device names distinct from sensitive files: %s", path => {
    expect(findResolvedShellPathViolation(path, path, process.cwd(), [], "read", false)).toBeNull();
  });

  it("blocks sensitive network paths without contacting the share", () => {
    for (const path of [
      "\\\\example.invalid\\share\\.aws.\\credentials",
      "\\\\?\\UNC\\example.invalid\\share\\.aws\\credentials",
    ]) expect(findResolvedShellPathViolation(path, path, process.cwd(), [], "read", false))
      .toMatchObject({ kind: "sensitive-path" });
  });

  it("refuses an ambiguous working directory", () => {
    const cwd = `${process.cwd()}\\ordinary. `;
    expect(validateShellWorkingDirectory(cwd, process.cwd(), [])).not.toBeNull();
    expect(findShellPathPolicyViolation("cat notes.txt", cwd, process.cwd(), [], false))
      .toMatchObject({ kind: "invalid-path" });
  });

  it("preserves file-backed key-generation operands alongside numeric key sizes", () => {
    const root = mkdtempSync(join(tmpdir(), "shell-key-operand-"));
    roots.push(root);
    expect(findShellPathPolicyViolation("openssl req -newkey rsa:2048 -out ./cert.pem", root, root, [], false)).toBeNull();
    expect(findShellPathPolicyViolation(`openssl req -newkey ${shellQuote(`ec:${root}\\.aws\\credentials`)} -out ./cert.pem`, root, root, [], false)).not.toBeNull();
  });
});
