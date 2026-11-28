// A macOS holder command that is a `#!` script: the interpreter the kernel would run is resolved by the holder's own
// executable rule, so `#!/usr/bin/env node` cannot pick up a program from an unchecked PATH entry at run time.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MxcExecutableNotAdmissibleError, resolvePosixHolderLaunch } from "../wrap-bundled-command.js";

let root: string;
let bin: string;

function program(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe.runIf(process.platform !== "win32")("macOS holder interpreter resolution", () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "phl-")));
    bin = join(root, "bin");
    program(bin, "fake-node", "\x7fELF-not-a-script");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("runs a binary as itself, with no prefix", () => {
    const launch = resolvePosixHolderLaunch(join(bin, "fake-node"), { PATH: bin });
    expect(launch).toEqual({ command: join(bin, "fake-node"), prefix: [], files: [join(bin, "fake-node")] });
  });

  it("resolves an env interpreter on the holder's PATH and execs it with the script as its argument", () => {
    const script = program(join(root, "pkg"), "server.js", "#!/usr/bin/env fake-node\nconsole.log(1)\n");
    const launch = resolvePosixHolderLaunch(script, { PATH: bin });
    expect(launch.command).toBe(join(bin, "fake-node"));
    expect(launch.prefix).toEqual([script]);
    // Both files take the executable rule: a script inside a writable root is refused as well as its interpreter.
    expect(launch.files).toEqual([script, join(bin, "fake-node")]);
  });

  it("keeps an absolute interpreter's arguments in front of the script", () => {
    const script = program(join(root, "pkg"), "tool.sh", "#!/bin/sh -e\necho hi\n");
    expect(resolvePosixHolderLaunch(script, { PATH: bin })).toMatchObject({ command: realpathSync.native("/bin/sh"), prefix: ["-e", script] });
  });

  it("refuses an env interpreter the holder's PATH does not resolve, or one on a relative PATH entry", () => {
    const script = program(join(root, "pkg"), "absent.js", "#!/usr/bin/env no-such-runtime\n");
    expect(() => resolvePosixHolderLaunch(script, { PATH: bin })).toThrow(MxcExecutableNotAdmissibleError);
    const found = program(join(root, "pkg"), "rel.js", "#!/usr/bin/env fake-node\n");
    expect(() => resolvePosixHolderLaunch(found, { PATH: `relative/bin:${bin}` })).toThrow(MxcExecutableNotAdmissibleError);
  });

  it.each([
    ["env with an option", "#!/usr/bin/env -S fake-node --flag"],
    ["env with an assignment", "#!/usr/bin/env FOO=1 fake-node"],
    ["env with a path", "#!/usr/bin/env ./fake-node"],
    ["a relative interpreter", "#!fake-node"],
  ])("refuses %s by name", (_case, line) => {
    const script = program(join(root, "pkg"), `case-${Math.random().toString(16).slice(2)}.js`, `${line}\n`);
    expect(() => resolvePosixHolderLaunch(script, { PATH: bin })).toThrow(expect.objectContaining({ code: "executable-not-admissible", message: expect.stringContaining(line) }));
  });

  it("refuses an interpreter that is itself a script", () => {
    const wrapper = program(join(root, "wrap"), "runtime", "#!/bin/sh\nexec /bin/cat\n");
    const script = program(join(root, "pkg"), "nested.js", `#!${wrapper}\n`);
    expect(() => resolvePosixHolderLaunch(script, { PATH: bin })).toThrow(expect.objectContaining({ code: "executable-not-admissible", message: expect.stringContaining(`#!${wrapper}`) }));
  });
});
