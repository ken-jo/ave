// Drive classification accepts only X:, follows substituted drives and fails closed on unmapped drives.
// Output must contain only the resolved mapping.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("This test requires Windows");
const helper = resolve(`resources/windows-path-kind/${process.arch}/ave-path-kind.exe`);
const replyDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function runWithInput(args, input) {
  const result = spawnSync(helper, args, { input, windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: replyDecoder.decode(result.stdout), stderr: replyDecoder.decode(result.stderr) };
}

function run(...args) {
  return runWithInput(args);
}

function held(path) {
  const { dev, ino } = lstatSync(path, { bigint: true });
  return [path, String(dev), String(ino)];
}

function answered(args, input = "c") {
  const { code, stdout, stderr } = runWithInput(args, input);
  return { code, lines: stdout.replace(/\r?\n$/u, "").split(/\r?\n/u), stderr };
}

function runCopy(args, onLine, executable = helper) {
  const child = spawn(executable, args, { windowsHide: true, shell: false, env: {} });
  return new Promise((resolveCopy, rejectCopy) => {
    const lines = [];
    let pending = "";
    let stderr = "";
    let failure;
    const timeout = setTimeout(() => {
      failure = new Error("copy did not finish");
      child.kill();
    }, 10_000);
    child.stdin.on("error", (error) => { failure ??= error; });
    child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
    child.stdout.setEncoding("utf8").on("data", (data) => {
      pending += data;
      const available = pending.split(/\r?\n/u);
      pending = available.pop();
      try {
        for (const line of available) {
          lines.push(line);
          onLine(line, child.stdin);
        }
      } catch (error) {
        failure ??= error;
        child.kill();
      }
    });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) rejectCopy(failure);
      else resolveCopy({ code, lines, stderr });
    });
  });
}

async function recoveryTests() {
  const record = `${"a".repeat(32)}.cleanup.json`;
  const hidden = `.${"b".repeat(32)}.removing`;
  const part = ".download.part";
  const tests = [];
  const add = (label, test) => tests.push([label, test]);
  const expect = (args, lines, code = 0) => {
    const result = answered(args);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.deepEqual(result.lines, lines);
    if (code !== 4) assert.equal(result.stderr, "");
  };
  const snapshot = (path) => {
    const [facts] = JSON.parse(run("--pin", path).stdout);
    const { birthtimeNs, mtimeNs, size } = lstatSync(path, { bigint: true });
    const bytes = readFileSync(path);
    const digest = (span) => createHash("sha256").update(span).digest("hex");
    const epoch = 11644473600000000000n;
    return [String(BigInt(facts.volumeSerial)), facts.fileId.slice(2),
      `${birthtimeNs + epoch}:${size}:${mtimeNs + epoch}:${digest(bytes.subarray(0, 65536))}:${digest(bytes.subarray(-65536))}`];
  };
  add("record round trip and exclusive collision", (dir) => {
    const folder = held(dir);
    expect(["--dir-list-records", ...folder], ["ready", "records"]);
    expect(["--dir-write-record", ...folder, record, "0061ff"], ["ready", "written"]);
    const [facts] = JSON.parse(run("--dacl", join(dir, record)).stdout);
    assert.equal(facts.protected, true);
    assert.equal(facts.aces.length, 1);
    expect(["--dir-write-record", ...folder, record, "62"], ["ready", "failed EEXIST"], 4);
    expect(["--dir-list-records", ...folder], ["ready", `records ${record}`]);
    expect(["--dir-read", ...folder, record, "3"], ["ready", "record 0061ff"]);
    expect(["--dir-read", ...folder, record, "2"], ["ready", "failed EFBIG"], 4);
    writeFileSync(join(dir, record), "");
    expect(["--dir-read", ...folder, record, "1"], ["ready", "record "]);
  });
  add("stale fingerprint never restores or removes its source", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "original");
    const known = snapshot(source);
    writeFileSync(source, "modified");
    expect(["--dir-restore", ...held(dir), hidden, part, ...known], ["ready", "left"]);
    expect(["--dir-remove-id", ...held(dir), hidden, ...known], ["ready", "left"]);
    const [dev, ino, current] = snapshot(source);
    const staleContent = [...current.split(":").slice(0, 3), ...known[2].split(":").slice(3)].join(":");
    expect(["--dir-restore", ...held(dir), hidden, part, dev, ino, staleContent], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "modified");
    assert.ok(!existsSync(join(dir, part)));
  });
  add("restore and identity removal complete when both names verify", (dir) => {
    const source = join(dir, hidden);
    const bytes = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index % 251));
    writeFileSync(source, bytes);
    expect(["--dir-restore", ...held(dir), hidden, part, ...snapshot(source)], ["ready", "restored"]);
    assert.ok(!existsSync(source));
    const restored = join(dir, part);
    assert.deepEqual(readFileSync(restored), bytes);
    const [dev, ino, fingerprint] = snapshot(restored);
    expect(["--dir-remove-id", ...held(dir), part, dev, ino, `${fingerprint.split(":")[0]}:-`], ["ready", "removed"]);
    expect(["--dir-remove-id", ...held(dir), part, dev, ino], ["ready", "absent"]);
  });
  add("occupied restore target and nonregular cleanup source stay in place", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "hidden bytes");
    const known = snapshot(source);
    mkdirSync(join(dir, part));
    expect(["--dir-restore", ...held(dir), hidden, part, ...known], ["ready", "left"]);
    expect(["--dir-remove-id", ...held(dir), part, ...known], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "hidden bytes");
    assert.ok(lstatSync(join(dir, part)).isDirectory());
  });
  for (const [boundary, outcome] of [["restore-target", "restored"], ["restore-write-error", "left"], ["no-exclusive-rename", "left"]]) {
    add(boundary, (dir) => {
      const source = join(dir, hidden);
      const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
      writeFileSync(source, bytes);
      const restore = boundary !== "no-exclusive-rename";
      const args = restore ? ["--dir-restore", ...held(dir), hidden, part, ...snapshot(source)]
        : ["--dir-remove-id", ...held(dir), hidden, ...snapshot(source)];
      const result = spawnSync(join(tmpdir(), "ave-path-pin-test.exe"), [boundary, ...args], {
        input: "c", windowsHide: true, shell: false, env: {}, timeout: 10_000, encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u), ["ready", outcome]);
      assert.equal(result.stderr.trim(), "boundary reached; replacement blocked");
      if (outcome === "restored") {
        assert.deepEqual(readFileSync(join(dir, part)), bytes);
        assert.ok(!existsSync(source));
      } else {
        assert.deepEqual(readFileSync(source), bytes);
        if (restore) assert.deepEqual(readFileSync(join(dir, part)), bytes.subarray(0, 1024 * 1024));
        else assert.deepEqual(readdirSync(dir), [hidden]);
      }
    });
  }
  for (const replaceAncestor of [false, true]) {
    for (const [mode, args] of [
      ["list-records", () => []], ["read", () => [record, "64"]], ["write-record", () => [record, "61"]],
      ["remove-id", (known) => [hidden, ...known]], ["restore", (known) => [hidden, part, ...known]],
    ]) {
      add(`${mode} refuses a replaced ${replaceAncestor ? "ancestor" : "directory"}`, (fixture) => {
        const above = join(fixture, "above");
        const dir = join(above, "chosen");
        mkdirSync(dir, { recursive: true });
        const folder = held(dir);
        writeFileSync(join(dir, hidden), "trusted source");
        const operands = args(snapshot(join(dir, hidden)));
        writeFileSync(join(dir, record), "trusted record");
        if (mode === "read") expect(["--dir-read", ...folder, record, "64"], ["ready", "record 74727573746564207265636f7264"]);
        const swapped = replaceAncestor ? above : dir;
        renameSync(swapped, `${swapped}-moved`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, hidden), "replacement source");
        if (mode !== "write-record") writeFileSync(join(dir, record), "replacement record");
        expect([`--dir-${mode}`, ...folder, ...operands], ["refused from"], 3);
        assert.equal(readFileSync(join(dir, hidden), "utf8"), "replacement source");
        assert.equal(readFileSync(join(replaceAncestor ? join(`${above}-moved`, "chosen") : `${dir}-moved`, hidden), "utf8"), "trusted source");
        assert.ok(!existsSync(join(dir, part)));
        if (mode === "write-record") assert.ok(!existsSync(join(dir, record)));
      });
    }
  }
  add("copy refuses nonregular target before ready", (dir) => {
    writeFileSync(join(dir, "source"), "source");
    mkdirSync(join(dir, "target"));
    expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part], ["refused target"], 3);
    assert.ok(!existsSync(join(dir, part)));
  });
  add("copy part collision stays a plain EEXIST", (dir) => {
    writeFileSync(join(dir, "source"), "source");
    writeFileSync(join(dir, part), "preexisting");
    expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part], ["ready", "failed EEXIST"], 4);
    assert.equal(readFileSync(join(dir, part), "utf8"), "preexisting");
  });
  for (const kind of ["directory", "junction"]) {
    add(`copy reports an occupied part ${kind} as EEXIST`, (dir) => {
      writeFileSync(join(dir, "source"), "download bytes");
      const occupied = join(dir, part);
      const original = kind === "directory" ? occupied : join(dir, "existing-dir");
      mkdirSync(original);
      writeFileSync(join(original, "sentinel"), "existing bytes");
      if (kind === "junction") symlinkSync(original, occupied, "junction");
      expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part], ["ready", "failed EEXIST"], 4);
      assert.equal(readFileSync(join(occupied, "sentinel"), "utf8"), "existing bytes");
      assert.equal(readFileSync(join(original, "sentinel"), "utf8"), "existing bytes");
      assert.equal(readFileSync(join(dir, "source"), "utf8"), "download bytes");
      assert.ok(!existsSync(join(dir, "target")));
    });
  }
  add("copy identifies its locked writer before progress and verifies the committed name", async (dir) => {
    writeFileSync(join(dir, "source"), "source");
    const result = await runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part], (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line.startsWith("writing ")) {
        assert.throws(() => renameSync(join(dir, part), join(dir, "moved")), /EBUSY|EPERM|EACCES/u);
        assert.throws(() => rmSync(join(dir, part)), /EBUSY|EPERM|EACCES/u);
      }
      if (line === "copied") stdin.end("c");
    });
    assert.equal(result.code, 0, result.stderr);
    const [dev, ino] = snapshot(join(dir, "target"));
    assert.deepEqual(result.lines, ["ready", `writing ${dev} ${ino}`, "progress 6", "copied", "committed"]);
    assert.ok(!existsSync(join(dir, part)));
    assert.ok(!existsSync(join(dir, "moved")));
  });
  add("commit refuses a late target and keeps it intact", async (dir) => {
    writeFileSync(join(dir, "source"), "source");
    const result = await runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part], (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line === "copied") {
        writeFileSync(join(dir, "target"), "unrelated bytes");
        stdin.end("c");
      }
    });
    assert.equal(result.code, 3, JSON.stringify(result));
    assert.match(result.lines[1], /^writing \d+ [0-9a-f]{32}$/u);
    assert.deepEqual(result.lines.slice(2), ["progress 6", "copied", "refused target removed"]);
    assert.equal(readFileSync(join(dir, "target"), "utf8"), "unrelated bytes");
    assert.ok(!existsSync(join(dir, part)));
  });
  add("replacement rollback leaves a genuinely occupied destination alone", async (dir) => {
    const target = join(dir, "target");
    writeFileSync(join(dir, "source"), "new bytes");
    writeFileSync(target, "old bytes");
    const old = snapshot(target);
    const args = ["replace-occupied", "--dir-copy", ...held(dir), "source", ...held(dir), "target", part];
    const result = await runCopy(args, (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line === "copied") stdin.end("c");
    }, join(tmpdir(), "ave-path-pin-test.exe"));
    assert.equal(result.code, 3, JSON.stringify(result));
    assert.equal(result.lines.at(-1), "refused target removed");
    assert.equal(readFileSync(target, "utf8"), "competing bytes");
    const [aside] = readdirSync(dir).filter((name) => /^\.[0-9a-f]{32}\.removing$/u.test(name));
    assert.ok(aside);
    assert.deepEqual(snapshot(join(dir, aside)), old);
    assert.ok(result.lines.some((line) => line.startsWith(`target-left left ${aside} ${old[0]} ${old[1]} mismatch `)));
  });
  for (const failure of ["none", "commit", "restore"]) {
    add(`copy replacement with ${failure} failure mode`, async (dir) => {
      const source = join(dir, "source");
      const target = join(dir, "target");
      writeFileSync(source, "new bytes");
      writeFileSync(target, "old bytes");
      const old = snapshot(target);
      const args = ["--dir-copy", ...held(dir), "source", ...held(dir), "target", part];
      const result = await runCopy(failure === "none" ? args : [`replace-${failure}-failure`, ...args], (line, stdin) => {
        if (line === "ready") stdin.write("c");
        if (line === "copied") stdin.end("c");
      }, failure === "none" ? helper : join(tmpdir(), "ave-path-pin-test.exe"));
      assert.equal(result.code, failure === "none" ? 0 : 4, JSON.stringify(result));
      assert.equal(readFileSync(source, "utf8"), "new bytes");
      assert.ok(!existsSync(join(dir, part)));
      const hiddenNames = readdirSync(dir).filter((name) => /^\.[0-9a-f]{32}\.removing$/u.test(name));
      if (failure === "restore") {
        assert.equal(hiddenNames.length, 1);
        assert.ok(!existsSync(target));
        assert.equal(readFileSync(join(dir, hiddenNames[0]), "utf8"), "old bytes");
        assert.ok(result.lines.some((line) => line.startsWith(`target-left left ${hiddenNames[0]} ${old[0]} ${old[1]} mismatch `)));
      } else {
        assert.deepEqual(hiddenNames, []);
        assert.equal(readFileSync(target, "utf8"), failure === "none" ? "new bytes" : "old bytes");
        if (failure === "commit") assert.deepEqual(snapshot(target), old);
      }
    });
  }
  for (const fault of ["query-failure", "zero"]) {
    for (const site of ["directory", "writer", "recovery"]) {
      add(`unverifiable FileId (${fault}) leaves every entry at ${site}`, async (dir) => {
        const source = join(dir, "source");
        const target = join(dir, "target");
        const temporary = join(dir, part);
        const existing = join(dir, hidden);
        writeFileSync(source, "download bytes");
        writeFileSync(existing, "existing bytes");
        const recovery = site === "recovery";
        const zeroRecovery = recovery && fault === "zero";
        const known = snapshot(existing);
        if (zeroRecovery) known[1] = "0".repeat(32);
        const args = recovery ? ["--dir-remove-id", ...held(dir), hidden, ...known]
          : ["--dir-copy", ...held(dir), "source", ...held(dir), "target", part];
        const position = zeroRecovery ? "recovery" : site === "writer" ? "second" : "first";
        const result = await runCopy([`file-id-${fault}-${position}`, ...args], (line, stdin) => {
          if (line === "ready") stdin.write("c");
          if (line === "copied") stdin.end("c");
        }, join(tmpdir(), "ave-path-pin-test.exe"));
        const expected = site === "directory" ? { code: 3, lines: ["refused to"] }
          : site === "writer" ? { code: 4, lines: ["ready", "failed EUNKNOWN left"] }
          : { code: 0, lines: ["ready", "left"] };
        assert.deepEqual({ code: result.code, lines: result.lines }, expected);
        assert.deepEqual(readdirSync(dir).sort(), (site === "writer" ? [hidden, part, "source"] : [hidden, "source"]).sort());
        assert.equal(readFileSync(source, "utf8"), "download bytes");
        assert.equal(readFileSync(existing, "utf8"), "existing bytes");
        assert.ok(!existsSync(target));
        if (site === "writer") assert.equal(readFileSync(temporary, "utf8"), "");
      });
    }
  }
  for (const blocked of [false, true]) {
    add(`commit identity mismatch with ${blocked ? "occupied" : "vacant"} rollback name`, async (dir) => {
      writeFileSync(join(dir, "source"), "source");
      const args = [blocked ? "commit-blocked" : "commit-mismatch", "--dir-copy", ...held(dir), "source", ...held(dir), "target", part];
      const result = await runCopy(args, (line, stdin) => {
        if (line === "ready") stdin.write("c");
        if (line === "copied") stdin.end("c");
      }, join(tmpdir(), "ave-path-pin-test.exe"));
      assert.equal(result.code, 3, JSON.stringify(result));
      assert.equal(result.lines.at(-1), blocked ? "refused target changed" : "refused target left");
      assert.equal(readFileSync(join(dir, part), "utf8"), blocked ? "" : "source");
      if (blocked) assert.equal(readFileSync(join(dir, "target"), "utf8"), "source");
      else assert.ok(!existsSync(join(dir, "target")));
    });
  }
  let failed = 0;
  for (const [label, test] of tests) {
    const root = mkdtempSync(join(tmpdir(), "ave-held-recovery-"));
    try {
      await test(root);
      console.log(`PASS ${label}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${label}\n${error}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`held directory recovery: ${tests.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await recoveryTests();
if (process.argv[2] === "--held-recovery-only") process.exit(0);

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function daclFrame(operands) {
  const body = Buffer.concat([uint32(operands.length), ...operands.flatMap(path => {
    const bytes = Buffer.from(path, "utf8");
    return [uint32(bytes.length), bytes];
  })]);
  return Buffer.concat([uint32(body.length), body]);
}

const systemDirectoryResult = run("--system-directory");
assert.equal(systemDirectoryResult.code, 0, systemDirectoryResult.stderr);
assert.equal(systemDirectoryResult.stderr, "");
assert.match(systemDirectoryResult.stdout, /^[a-z]:\\[^\r\n]+\r?\n$/iu);
const systemDirectory = systemDirectoryResult.stdout.replace(/\r?\n$/u, "");
const spoofedDirectory = spawnSync(helper, ["--system-directory"], {
  windowsHide: true, shell: false, timeout: 10_000,
  env: { SystemRoot: "Z:\\untrusted-root", WINDIR: "Y:\\untrusted-root", PATH: "X:\\untrusted-path" },
});
assert.ifError(spoofedDirectory.error);
assert.equal(spoofedDirectory.status, 0, replyDecoder.decode(spoofedDirectory.stderr));
assert.equal(replyDecoder.decode(spoofedDirectory.stdout), systemDirectoryResult.stdout, "parent system variables cannot change the OS directory answer");
const runtimeSystemDirectory = execFileSync(join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
  ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write([Environment]::SystemDirectory)"],
  { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000,
    env: { SystemRoot: dirname(systemDirectory), WINDIR: dirname(systemDirectory), PATH: systemDirectory } });
assert.equal(systemDirectory.toLowerCase(), runtimeSystemDirectory.toLowerCase(), "native and runtime OS system-directory APIs agree");
assert.equal(run("--system-directory", "unexpected").code, 2);
console.log(`OS system directory: ${systemDirectory}; spoofed environment ignored`);

function unusedDrives() {
  const unused = [];
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (run(`${letter}:`).code === 1) unused.push(`${letter}:`);
  }
  return unused;
}

const system = (process.env.SystemDrive ?? "C:").toUpperCase();
const local = run(system);
assert.equal(local.code, 0, local.stderr);
assert.match(local.stdout, /^\\Device\\HarddiskVolume\d+\r?\n$/u, `the system drive maps to a volume: ${JSON.stringify(local.stdout)}`);
assert.equal(local.stdout.split("\n").filter(Boolean).length, 1, "one line only");
console.log(`${system} -> ${local.stdout.trim()}`);

assert.equal(run(system.toLowerCase()).stdout, local.stdout);

for (const bad of ["C", "C:\\", "CC:", "1:", "\\\\server\\share", ""]) {
  const refused = run(bad);
  assert.equal(refused.code, 2, `"${bad}" is refused as usage`);
  assert.equal(refused.stdout, "");
}
assert.equal(run().code, 2, "no argument is usage");
assert.equal(run("C:", "D:").code, 2, "two arguments are usage");

const [free, second] = unusedDrives();
assert.ok(free && second, "two unused drive letters are available");

const missing = run(free);
assert.equal(missing.code, 1);
assert.equal(missing.stdout, "");
assert.match(missing.stderr, /QueryDosDeviceW failed: \d+/u);
console.log(`${free} (unmapped) -> exit 1`);

// Substituted drives return a native path whose drive must be classified in turn.
const target = mkdtempSync(join(tmpdir(), "ave path kind "));
try {
  execFileSync("subst", [free, target], { windowsHide: true });
  try {
    const subst = run(free);
    assert.equal(subst.code, 0, subst.stderr);
    assert.equal(subst.stdout.trim().toLowerCase(), `\\??\\${target}`.toLowerCase(), `subst maps to its target: ${JSON.stringify(subst.stdout)}`);
    console.log(`${free} (subst) -> ${subst.stdout.trim()}`);
    execFileSync("subst", [second, `${free}\\`], { windowsHide: true });
    try {
      const chained = run(second);
      assert.equal(chained.code, 0, chained.stderr);
      // Substituted drive roots are reported without a trailing separator.
      assert.equal(chained.stdout.trim().toLowerCase(), `\\??\\${free}`.toLowerCase());
      console.log(`${second} (subst of ${free}) -> ${chained.stdout.trim()}`);
    } finally {
      execFileSync("subst", [second, "/D"], { windowsHide: true });
    }
  } finally {
    execFileSync("subst", [free, "/D"], { windowsHide: true });
  }
  assert.equal(run(free).code, 1);
} finally {
  rmSync(target, { recursive: true, force: true });
}
// Held directory operations (dir-ops.h): each step names files only through handles held on its folders, and a held folder and
// every folder above it cannot be renamed until the step ends.
const dirOps = mkdtempSync(join(tmpdir(), "ave dir ops "));
try {
  const from = join(dirOps, "staging");
  const above = join(dirOps, "chosen");
  const to = join(above, "inner");
  mkdirSync(from);
  mkdirSync(to, { recursive: true });

  writeFileSync(join(from, "a"), "staged a");
  let result = answered(["--dir-rename", ...held(from), "a", ...held(to), "report.pdf"], "c");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines, ["ready", "committed"]);
  assert.equal(readFileSync(join(to, "report.pdf"), "utf8"), "staged a");

  writeFileSync(join(from, "b"), "staged b");
  result = answered(["--dir-rename", ...held(from), "b", ...held(to), "report.pdf"], "");
  assert.deepEqual(result.lines, ["ready", "cancelled"], "the end of input at a step stops it");
  assert.equal(readFileSync(join(to, "report.pdf"), "utf8"), "staged a");

  const [path, volume, index] = held(to);
  result = answered(["--dir-rename", ...held(from), "b", path, volume, (BigInt(index) + 1n).toString(), "report.pdf"], "c");
  assert.equal(result.code, 3);
  assert.deepEqual(result.lines, ["refused to"], "another directory at the checked path is refused before anything is asked");
  const [fromPath, fromVolume, fromIndex] = held(from);
  result = answered(["--dir-remove", fromPath, fromVolume, (BigInt(fromIndex) + 1n).toString(), "b"], "c");
  assert.deepEqual(result.lines, ["refused from"]);

  // Junctions point at an empty folder inside the fixture, and are unlinked on their own before the fixture is removed.
  const elsewhere = join(dirOps, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(to, "junction.pdf"), "junction");
  result = answered(["--dir-rename", ...held(from), "b", ...held(to), "junction.pdf"], "c");
  assert.deepEqual(result.lines, ["ready", "refused target"]);
  assert.ok(existsSync(join(from, "b")));

  result = answered(["--dir-copy", ...held(from), "b", ...held(to), "copied.pdf", ".0123.part"], "cc");
  assert.match(result.lines[1], /^writing \d+ [0-9a-f]{32}$/u);
  assert.equal(result.lines[2], "cancelled", "input that arrives while bytes are copied stops the copy");
  assert.deepEqual(readdirSync(to).sort(), ["junction.pdf", "report.pdf"]);
  const copy = spawn(helper, ["--dir-copy", ...held(from), "b", ...held(to), "copied.pdf", ".0123.part"], { windowsHide: true, shell: false, env: {} });
  const copied = await new Promise((resolveCopy, rejectCopy) => {
    let output = "";
    copy.once("error", rejectCopy);
    copy.stdout.setEncoding("utf8");
    copy.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.endsWith("ready\n") || output.endsWith("ready\r\n")) copy.stdin.write("c");
      if (/copied\r?\n$/u.test(output)) {
        // The copy is complete in the held folder, under its temporary name, and the folders it holds cannot be renamed.
        assert.ok(existsSync(join(to, ".0123.part")));
        assert.throws(() => renameSync(to, `${to}-moved`), /EBUSY|EPERM|EACCES/u);
        assert.throws(() => renameSync(above, `${above}-moved`), /EBUSY|EPERM|EACCES/u);
        assert.throws(() => renameSync(from, `${from}-moved`), /EBUSY|EPERM|EACCES/u);
        copy.stdin.end("c");
      }
    });
    copy.once("close", (code) => resolveCopy({ code, output }));
  });
  assert.equal(copied.code, 0);
  // One chunk of "staged b": the copy reports its progress once before it is complete.
  const [ready, writing, ...outcome] = copied.output.split(/\r?\n/u).filter(Boolean);
  assert.equal(ready, "ready");
  assert.match(writing, /^writing \d+ [0-9a-f]{32}$/u);
  assert.deepEqual(outcome, ["progress 8", "copied", "committed"]);
  assert.equal(readFileSync(join(to, "copied.pdf"), "utf8"), "staged b");
  assert.ok(!existsSync(join(to, ".0123.part")));

  result = answered(["--dir-remove", ...held(from), "b"], "c");
  assert.deepEqual(result.lines, ["ready", "removed"]);
  result = answered(["--dir-remove", ...held(from), "b"], "c");
  assert.deepEqual(result.lines, ["ready", "absent"]);

  writeFileSync(join(from, "left"), "left by a crash");
  mkdirSync(join(from, "kept"));
  symlinkSync(elsewhere, join(from, "linked"), "junction");
  result = answered(["--dir-sweep", ...held(from)], "c");
  assert.deepEqual(result.lines, ["ready", "swept 2"], "a sweep removes files and links, never a directory");
  assert.deepEqual(readdirSync(from), ["kept"]);
  assert.ok(existsSync(elsewhere), "removing a junction leaves what it pointed to");
  assert.deepEqual(readdirSync(to).sort(), ["copied.pdf", "junction.pdf", "report.pdf"]);
  console.log("held directory operations: ok");
} finally {
  for (const junction of [join(dirOps, "chosen", "inner", "junction.pdf"), join(dirOps, "staging", "linked")]) {
    if (existsSync(junction)) rmSync(junction);
  }
  rmSync(dirOps, { recursive: true, force: true });
}
console.log("windows-path-kind: ok");

const fixture = mkdtempSync(join(tmpdir(), "ave-path-facts-"));
try {
  console.log(execFileSync(join(tmpdir(), "ave-path-pin-test.exe"), [fixture], { windowsHide: true, encoding: "utf8" }).trim());
  console.log("native pin: deterministic retag and swapped ancestor checks passed");
  const directory = join(fixture, "directory");
  mkdirSync(directory);
  const file = join(directory, "file");
  writeFileSync(file, "pinned bytes");
  const link = join(fixture, "junction");
  symlinkSync(directory, link, "junction");
  const paths = [file, directory, join(directory, "missing"), link, join(link, "file"), join(link, "nested", "unopened")];
  const pins = run("--pin", ...paths);
  assert.equal(pins.code, 0, pins.stderr);
  const rows = JSON.parse(pins.stdout);
  assert.equal(rows.length, paths.length);
  for (const row of rows.flatMap(row => [row, ...row.ancestors])) {
    if (row.exists === true) assert.match(row.fileSystemName, /^[A-Za-z0-9_-]{1,255}$/u, "retained handles report their filesystem");
    else assert.equal(row.fileSystemName, null, "missing and uninspected objects have no filesystem name");
    if (row.exists === true) assert.match(row.changeTime, /^0x[0-9a-f]{16}$/u, "changeTime is a hex-64 string");
    else assert.equal(row.changeTime, null, "missing and uninspected objects have null changeTime");
  }
  assert.equal(JSON.parse(run("--pin", file).stdout)[0].changeTime, rows[0].changeTime, "unchanged pins have stable changeTime");
  for (const [index, path] of paths.slice(0, 2).entries()) {
    const stat = lstatSync(path, { bigint: true });
    assert.equal(BigInt(rows[index].volumeSerialNumber), stat.dev, "Node dev is the legacy 32-bit volume serial");
    assert.equal(BigInt(rows[index].fileIndex), stat.ino, "Node ino is the legacy 64-bit file index");
    assert.match(rows[index].fileId, /^0x[0-9a-f]{32}$/u);
    assert.match(rows[index].volumeSerial, /^0x[0-9a-f]{16}$/u);
    assert.equal(rows[index].canonical.toLowerCase(), `\\\\?\\${path}`.toLowerCase());
    assert.ok(rows[index].ancestors.length > 1);
    assert.ok(rows[index].ancestors.every(ancestor => ancestor.exists));
  }
  const descriptor = openSync(file, "r");
  try {
    assert.equal(BigInt(rows[0].fileIndex), fstatSync(descriptor, { bigint: true }).ino);
    assert.equal(BigInt(rows[0].volumeSerialNumber), fstatSync(descriptor, { bigint: true }).dev);
  } finally { closeSync(descriptor); }
  assert.equal(rows[2].exists, false);
  assert.equal(rows[3].reparseTag, 0xa0000003);
  assert.equal(rows[3].reparseTarget.toLowerCase(), directory.toLowerCase(), "the retained junction handle supplies the target");
  assert.equal(rows[4].exists, null, "a reparse ancestor prevents opening the target");
  assert.equal(rows[5].ancestors.at(-1).exists, null);
  // A GUID-owned tag has no link semantics known to the filesystem runtime.
  const unfamiliar = join(fixture, "unfamiliar");
  writeFileSync(unfamiliar, "");
  execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FixtureReparse {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int length, IntPtr output, int size, out int returned, IntPtr overlapped);
  public static void Set(string path) {
    using(var handle=CreateFile(path,0x40000000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var data=new byte[24]; data[0]=0x42;
      new Guid("db26d866-5321-4f43-977f-4591ca0bf0ee").ToByteArray().CopyTo(data,8);
      int returned;
      if(!DeviceIoControl(handle,0x900a4,data,data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@; [FixtureReparse]::Set('${unfamiliar.replaceAll("'", "''")}')`,
  ], { windowsHide: true });
  let classification;
  try { classification = lstatSync(unfamiliar).isSymbolicLink(); }
  catch (error) { classification = error.code; assert.ok(["EACCES", "EINVAL"].includes(error.code)); }
  assert.notEqual(classification, true, "an unfamiliar tag cannot be admitted by a symbolic-link predicate");
  const unfamiliarPin = run("--pin", unfamiliar);
  assert.equal(unfamiliarPin.code, 0, unfamiliarPin.stderr);
  const [unfamiliarFacts] = JSON.parse(unfamiliarPin.stdout);
  assert.equal(unfamiliarFacts.reparseTag, 0x42);
  assert.equal(unfamiliarFacts.attributes & 0x400, 0x400);
  const unfamiliarDacl = run("--dacl", unfamiliar);
  assert.equal(unfamiliarDacl.code, 0, unfamiliarDacl.stderr);
  assert.equal(JSON.parse(unfamiliarDacl.stdout)[0].reparseTag, 0x42);
  console.log(`unfamiliar reparse tag: lstat=${classification}; native reparseTag=66`);
  const dacls = run("--dacl", "--parent", "--content", file);
  assert.equal(dacls.code, 0, dacls.stderr);
  const [dacl] = JSON.parse(dacls.stdout);
  assert.equal(dacl.changeTime, rows[0].changeTime, "DACL facts carry the pinned changeTime");
  assert.deepEqual(dacl.identity, { volumeSerial: rows[0].volumeSerial, fileId: rows[0].fileId });
  assert.equal(Buffer.from(dacl.contentHex, "hex").toString(), "pinned bytes");
  assert.equal(typeof dacl.owner, "string");
  assert.ok(Array.isArray(dacl.aces));
  assert.ok(dacl.parent);

  const bulkPaths = Array.from({ length: 160 }, (_, index) => join(fixture, `absent ${index} é`).padEnd(253, "x"));
  assert.ok(bulkPaths.every(path => path.length === 253));
  assert.ok(bulkPaths.reduce((length, path) => length + path.length, 0) > 32_767);
  const request = [file, ...bulkPaths];
  const args = ["--dacl", "--parent", "--stdin"];
  const framed = runWithInput(args, daclFrame(request));
  assert.equal(framed.code, 0, framed.stderr);
  const framedRows = JSON.parse(framed.stdout);
  assert.deepEqual(framedRows.map(({ requestPath }) => requestPath), request);
  assert.deepEqual(framedRows[0].identity, dacl.identity);
  assert.deepEqual(framedRows[0].parent, dacl.parent);
  assert.ok(framedRows.slice(1).every(row => row.exists === false && row.parent !== null));

  const complete = daclFrame([file]);
  for (const input of [complete.subarray(0, -1), Buffer.concat([complete, Buffer.from([0])]),
    Buffer.concat([uint32(4), uint32(2049)]), uint32(1024 * 1024 + 1),
    daclFrame([Buffer.from([0xc0, 0x80])]), daclFrame([`${file}\0suffix`])]) {
    const invalid = runWithInput(args, input);
    assert.equal(invalid.code, 2, "malformed frames are refused");
    assert.equal(invalid.stdout, "", "malformed frames emit no facts");
  }
  assert.equal(runWithInput([...args, file], complete).code, 2, "stdin and argv cannot be mixed");
  const lateFailure = runWithInput(args, daclFrame([file, join(fixture, "invalid|target")]));
  assert.equal(lateFailure.code, 4);
  assert.equal(lateFailure.stdout, "", "a failed late snapshot emits no partial batch");

  const writer = openSync(file, "r+");
  try {
    const locked = run("--dacl", "--parent", "--content", file);
    assert.equal(locked.code, 4, "a concurrent write handle prevents a policy snapshot");
    assert.equal(locked.stdout, "");
  } finally { closeSync(writer); }
  assert.equal(JSON.parse(run("--dacl", paths[2]).stdout)[0].exists, false);
  for (const mode of ["--pin", "--dacl"]) {
    const failed = run(mode, file, join(fixture, "invalid|target"));
    assert.equal(failed.code, 4);
    assert.equal(failed.stdout, "", "failed batches emit no partial data");
    assert.equal(run(mode).code, 2);
    assert.notEqual(run(mode, "relative").code, 0);
  }
  console.log("windows-path-facts: pin, DACL, content, reparse, missing and Node identity checks passed");
} finally { rmSync(fixture, { recursive: true, force: true }); }
