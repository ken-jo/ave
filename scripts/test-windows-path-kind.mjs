// Drive classification accepts only X:, follows substituted drives and fails closed on unmapped drives.
// Output must contain only the resolved mapping.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function factsOf(path) {
  const [facts] = JSON.parse(run("--pin", path).stdout);
  const { birthtimeNs, mtimeNs, size } = lstatSync(path, { bigint: true });
  const bytes = readFileSync(path);
  const digest = (span) => createHash("sha256").update(span).digest("hex");
  const epoch = 11644473600000000000n;
  const dev = String(BigInt(facts.volumeSerial));
  const id = facts.fileId.slice(2);
  const birth = birthtimeNs + epoch;
  return { dev, id, birth, size: String(size), mtime: String(mtimeNs + epoch), head: digest(bytes.subarray(0, 65536)),
    tail: digest(bytes.subarray(-65536)), token: `${dev}:${id}:creation:${birth}` };
}

// The evidence token `<dev>:<id>:creation:<value>` of a file; `birthOffset` gives the same file ID with another creation time.
function tokenOf(path, birthOffset = 0n) {
  const { dev, id, birth } = factsOf(path);
  return `${dev}:${id}:creation:${birth + birthOffset}`;
}

// A new folder on a volume that tunnels names: a file created or renamed onto a name freed moments ago takes the creation time of the
// file that left it. AVE_TEST_TUNNEL_ROOT names a folder on such a volume; unset, the temp folder is used, which CI keeps on the system
// volume. The probe proves the volume tunnels before a test relies on it, and fails when it does not.
function tunnellingFolder(prefix) {
  const dir = mkdtempSync(join(process.env.AVE_TEST_TUNNEL_ROOT || tmpdir(), prefix));
  const probe = join(dir, "probe");
  const birth = () => lstatSync(probe, { bigint: true }).birthtimeNs;
  writeFileSync(probe, "");
  const before = birth();
  // Wait, by comparing values, until a new file's creation time differs, so an equal time below can only be a tunnelled one.
  for (let index = 0; ; index += 1) {
    const clock = join(dir, `clock-${index}`);
    writeFileSync(clock, "");
    const later = lstatSync(clock, { bigint: true }).birthtimeNs;
    rmSync(clock);
    if (later !== before) break;
  }
  renameSync(probe, join(dir, "probe-away"));
  writeFileSync(probe, "");
  const tunnelled = birth() === before;
  rmSync(probe);
  rmSync(join(dir, "probe-away"));
  if (!tunnelled) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${dir} is on a volume that does not tunnel names; set AVE_TEST_TUNNEL_ROOT to a folder on one`);
  }
  return dir;
}

async function recoveryTests() {
  const record = `${"a".repeat(32)}.cleanup.json`;
  const hidden = `.${"b".repeat(32)}.removing`;
  const part = ".download.part";
  const tests = [];
  const add = (label, test, root = () => mkdtempSync(join(tmpdir(), "ave-held-recovery-"))) => tests.push([label, test, root]);
  const tunnelling = () => tunnellingFolder("ave-held-tunnel-");
  const expect = (args, lines, code = 0) => {
    const result = answered(args);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.deepEqual(result.lines.filter((line) => !line.startsWith("destination-id ")).map((line) =>
      /^written \d+:[0-9a-f]{32}:creation:[1-9]\d*$/u.test(line) ? "written" : line), lines);
    if (code !== 4) assert.equal(result.stderr, "");
  };
  const snapshot = (path) => {
    const { token, size, mtime, head, tail } = factsOf(path);
    return ["--expect", token, "--content", `${size}:${mtime}:${head}:${tail}`];
  };
  const removeRecord = (dir, name, birthOffset = 0n) => {
    const { size, head } = factsOf(join(dir, name));
    return ["--dir-remove-record", ...held(dir), name, "--expect", tokenOf(join(dir, name), birthOffset), "--length", size, "--digest", head];
  };
  add("record removal keeps an edited or replaced name", (dir) => {
    const path = join(dir, record);
    expect(["--dir-write-record", ...held(dir), record, "7b7d"], ["ready", "written"]);
    const remove = removeRecord(dir, record);
    writeFileSync(path, "[]");
    expect(remove, ["ready", "kept"]);
    assert.equal(readFileSync(path, "utf8"), "[]");
    renameSync(path, join(dir, "previous"));
    writeFileSync(path, "{}");
    expect(remove, ["ready", "kept"]);
    assert.equal(readFileSync(path, "utf8"), "{}");
    expect(removeRecord(dir, record), ["ready", "removed"]);
  });
  // Right file ID, wrong creation time: each identity-bound mode must leave the entry where it is.
  add("wrong birth: identity removal keeps the entry", (dir) => {
    writeFileSync(join(dir, hidden), "hidden bytes");
    expect(["--dir-remove-id", ...held(dir), hidden, "--expect", tokenOf(join(dir, hidden), 1n)], ["ready", "left"]);
    assert.equal(readFileSync(join(dir, hidden), "utf8"), "hidden bytes");
  });
  add("wrong birth: restore keeps the hidden file", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "hidden bytes");
    const known = snapshot(source);
    known[1] = tokenOf(source, 1n);
    expect(["--dir-restore", ...held(dir), hidden, part, ...known], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "hidden bytes");
    assert.ok(!existsSync(join(dir, part)));
  });
  add("wrong birth: target restore keeps the old file aside a vacant name", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "old bytes");
    expect(["--dir-restore-target", ...held(dir), hidden, "target", "--expect", tokenOf(source, 1n)], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "old bytes");
    assert.ok(!existsSync(join(dir, "target")));
  });
  add("wrong birth: target restore does not take the writer as committed", (dir) => {
    const source = join(dir, hidden);
    const target = join(dir, "target");
    writeFileSync(source, "old bytes");
    writeFileSync(target, "new bytes");
    const args = ["--dir-restore-target", ...held(dir), hidden, "target", "--expect", tokenOf(source)];
    expect([...args, "--writer", tokenOf(target, 1n)], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "old bytes");
    expect([...args, "--writer", tokenOf(target)], ["ready", "resolved"]);
    assert.ok(!existsSync(source));
    assert.equal(readFileSync(target, "utf8"), "new bytes");
  });
  add("wrong birth: record removal keeps the record", (dir) => {
    expect(["--dir-write-record", ...held(dir), record, "7b7d"], ["ready", "written"]);
    expect(removeRecord(dir, record, 1n), ["ready", "kept"]);
    assert.equal(readFileSync(join(dir, record), "utf8"), "{}");
  });
  add("wrong birth: a rename keeps the staged file", (dir) => {
    writeFileSync(join(dir, "staged"), "staged bytes");
    expect(["--dir-rename", ...held(dir), "staged", ...held(dir), "report.pdf", "--expect", tokenOf(join(dir, "staged"), 1n)],
      ["ready", "refused source"], 3);
    assert.equal(readFileSync(join(dir, "staged"), "utf8"), "staged bytes");
    assert.ok(!existsSync(join(dir, "report.pdf")));
  });
  add("evidence classes other than creation stay unresolved", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "hidden bytes");
    const { dev, id, birth, size, mtime, head, tail } = factsOf(source);
    for (const token of [`${dev}:${id}:none:-`, `${dev}:${id}:birth:${birth}`, `${dev}:${id}:fingerprint:${size}:${mtime}:${head}:${tail}`, `${dev}:${id}:other:1`]) {
      expect(["--dir-remove-id", ...held(dir), hidden, "--expect", token], ["ready", "left"]);
    }
    for (const token of [`${dev}:${id}:*:${birth}`, `${dev}:${id}:creation:0`, `${dev}:${id}:creation:`,
      `${dev}:${id}:${birth}`, `${dev}:${id}`]) {
      assert.equal(answered(["--dir-remove-id", ...held(dir), hidden, "--expect", token]).code, 2, token);
    }
    for (const extra of [["--retire"], ["--expect", tokenOf(source)], ["--unknown", "1"]]) {
      assert.equal(answered(["--dir-remove-id", ...held(dir), hidden, "--expect", tokenOf(source), ...extra]).code, 2, extra.join(" "));
    }
    assert.equal(answered(["--dir-restore-target", ...held(dir), hidden, "target", "--expect", tokenOf(source), "--retire",
      "--writer", `${dev}:${"c".repeat(32)}:creation:1`]).code, 2);
    assert.equal(readFileSync(source, "utf8"), "hidden bytes");
  });
  for (const existing of [false, true]) add(`a volume without file-ID opens refuses the copy before it starts (existing target: ${existing})`, (dir) => {
    writeFileSync(join(dir, "source"), "source");
    if (existing) writeFileSync(join(dir, "target"), "old bytes");
    const result = spawnSync(join(tmpdir(), "ave-path-pin-test.exe"),
      ["volume-without-file-ids", "--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden],
      { input: "c", windowsHide: true, shell: false, env: {}, timeout: 10_000, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 3, result.stdout);
    assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u), ["refused volume"]);
    assert.deepEqual(readdirSync(dir).sort(), existing ? ["source", "target"] : ["source"]);
    if (existing) assert.equal(readFileSync(join(dir, "target"), "utf8"), "old bytes");
  });
  for (const [mode, refusal] of [["volume-without-file-ids", "refused volume"], ["volume-query-fails", "refused volume-unknown"]]) add(`${mode} refuses the copy before the existing target is opened`, (dir) => {
    writeFileSync(join(dir, "source"), "source");
    writeFileSync(join(dir, "target"), "old bytes");
    // Opened with no sharing (the exclusive-lock open flag), so any open of the target by the helper fails instead of answering the refusal.
    const locked = openSync(join(dir, "target"), constants.O_RDONLY | 0x10000000);
    let result;
    try {
      assert.throws(() => readFileSync(join(dir, "target")), { code: "EBUSY" });
      result = spawnSync(join(tmpdir(), "ave-path-pin-test.exe"),
        [mode, "--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden],
        { input: "c", windowsHide: true, shell: false, env: {}, timeout: 10_000, encoding: "utf8" });
    } finally {
      closeSync(locked);
    }
    assert.ifError(result.error);
    assert.equal(result.status, 3, result.stdout);
    assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u), [refusal]);
    assert.equal(readFileSync(join(dir, "target"), "utf8"), "old bytes");
  });
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
  add("holds the rejected record through classification and disposition", async (dir) => {
    const path = join(dir, record);
    const moved = join(dir, "moved-record");
    writeFileSync(path, "rejected");
    const result = await runCopy(["--dir-sweep-record", ...held(dir), record, "8192"], (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line.startsWith("record ")) {
        assert.equal(line.split(" ").at(-1), Buffer.from("rejected").toString("hex"));
        assert.throws(() => renameSync(path, moved), /EBUSY|EPERM|EACCES/u);
        stdin.end("c");
      }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.lines.at(-1), "removed");
    assert.ok(!existsSync(path));
    assert.ok(!existsSync(moved));
  });
  add("stale fingerprint never restores or removes its source", (dir) => {
    const source = join(dir, hidden);
    writeFileSync(source, "original");
    const known = snapshot(source);
    writeFileSync(source, "modified");
    expect(["--dir-restore", ...held(dir), hidden, part, ...known], ["ready", "left"]);
    expect(["--dir-remove-id", ...held(dir), hidden, ...known], ["ready", "left"]);
    const current = factsOf(source);
    const staleContent = [current.size, current.mtime, ...known[3].split(":").slice(2)].join(":");
    expect(["--dir-restore", ...held(dir), hidden, part, "--expect", current.token, "--content", staleContent], ["ready", "left"]);
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
    const token = tokenOf(restored);
    expect(["--dir-remove-id", ...held(dir), part, "--expect", token], ["ready", "removed"]);
    expect(["--dir-remove-id", ...held(dir), part, "--expect", token], ["ready", "absent"]);
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
    expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], ["refused target"], 3);
    assert.ok(!existsSync(join(dir, part)));
  });
  add("copy part collision stays a plain EEXIST", (dir) => {
    writeFileSync(join(dir, "source"), "source");
    writeFileSync(join(dir, part), "preexisting");
    expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], ["ready", "failed EEXIST"], 4);
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
      expect(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], ["ready", "failed EEXIST"], 4);
      assert.equal(readFileSync(join(occupied, "sentinel"), "utf8"), "existing bytes");
      assert.equal(readFileSync(join(original, "sentinel"), "utf8"), "existing bytes");
      assert.equal(readFileSync(join(dir, "source"), "utf8"), "download bytes");
      assert.ok(!existsSync(join(dir, "target")));
    });
  }
  add("copy identifies its locked writer before progress and verifies the committed name", async (dir) => {
    writeFileSync(join(dir, "source"), "source");
    const result = await runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line.startsWith("writing ")) {
        assert.throws(() => renameSync(join(dir, part), join(dir, "moved")), /EBUSY|EPERM|EACCES/u);
        assert.throws(() => rmSync(join(dir, part)), /EBUSY|EPERM|EACCES/u);
      }
      if (line === "copied") stdin.end("c");
    });
    assert.equal(result.code, 0, result.stderr);
    const { dev, token } = factsOf(join(dir, "target"));
    const [destination, ...copyLines] = result.lines;
    assert.match(destination, /^destination-id \d+:[0-9a-f]{32}:creation:[1-9][0-9]*$/u);
    assert.equal(destination.split(" ")[1].split(":")[0], dev);
    assert.deepEqual(copyLines, ["ready", `writing ${token}`, "progress 6", "copied", `published ${token}`, "committed"]);
    assert.ok(!existsSync(join(dir, part)));
    assert.ok(!existsSync(join(dir, "moved")));
  });
  add("commit refuses a late target and keeps it intact", async (dir) => {
    writeFileSync(join(dir, "source"), "source");
    const result = await runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], (line, stdin) => {
      if (line === "ready") stdin.write("c");
      if (line === "copied") {
        writeFileSync(join(dir, "target"), "unrelated bytes");
        stdin.end("c");
      }
    });
    assert.equal(result.code, 3, JSON.stringify(result));
    assert.match(result.lines[2], /^writing \d+:[0-9a-f]{32}:creation:[1-9]\d*$/u);
    assert.deepEqual(result.lines.slice(3), ["progress 6", "copied", "refused target removed"]);
    assert.equal(readFileSync(join(dir, "target"), "utf8"), "unrelated bytes");
    assert.ok(!existsSync(join(dir, part)));
  });
  add("replacement rollback leaves a genuinely occupied destination alone", async (dir) => {
    const target = join(dir, "target");
    writeFileSync(join(dir, "source"), "new bytes");
    writeFileSync(target, "old bytes");
    const old = snapshot(target);
    const args = ["replace-occupied", "--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden];
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
    assert.ok(result.lines.some((line) => line.startsWith(`target-left left ${aside} ${old[1]} mismatch `)));
  });
  for (const failure of ["none", "commit", "restore"]) {
    add(`copy replacement with ${failure} failure mode`, async (dir) => {
      const source = join(dir, "source");
      const target = join(dir, "target");
      writeFileSync(source, "new bytes");
      writeFileSync(target, "old bytes");
      const old = snapshot(target);
      const args = ["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden];
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
        assert.ok(result.lines.some((line) => line.startsWith(`target-left left ${hiddenNames[0]} ${old[1]} mismatch `)));
      } else {
        assert.deepEqual(hiddenNames, []);
        assert.equal(readFileSync(target, "utf8"), failure === "none" ? "new bytes" : "old bytes");
        if (failure === "commit") assert.deepEqual(snapshot(target), old);
      }
    });
  }
  // Name tunnelling gives the file put at a just-freed name the creation time of the file that left it. The rename is still verified by
  // the held handle's file ID and volume, and the creation time the file has afterwards is published.
  const copyAll = (dir) => runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], (line, stdin) => {
    if (line === "ready") stdin.write("c");
    if (line === "copied") stdin.end("c");
  });
  // Write `name` and let a creation time pass, so a file created after it cannot share its creation time by chance.
  const freedLater = (dir, name, bytes) => {
    writeFileSync(join(dir, name), bytes);
    const left = factsOf(join(dir, name));
    writeFileSync(join(dir, "source"), "new bytes");
    assert.notEqual(factsOf(join(dir, "source")).birth, left.birth);
    return left;
  };
  add("a replacement on a tunnelling volume commits, publishes its new creation time and retires the old file", async (dir) => {
    const old = freedLater(dir, "target", "old bytes");
    const result = await copyAll(dir);
    assert.equal(result.code, 0, JSON.stringify(result));
    const now = factsOf(join(dir, "target"));
    assert.equal(readFileSync(join(dir, "target"), "utf8"), "new bytes");
    assert.equal(now.birth, old.birth);
    assert.deepEqual(result.lines.slice(-3), [`published ${now.token}`, "target-retired", "committed"]);
    assert.deepEqual(readdirSync(dir).sort(), ["source", "target"]);
  }, tunnelling);
  add("a copy into a name deleted moments ago commits", async (dir) => {
    const deleted = freedLater(dir, "target", "deleted bytes");
    rmSync(join(dir, "target"));
    const result = await copyAll(dir);
    assert.equal(result.code, 0, JSON.stringify(result));
    const now = factsOf(join(dir, "target"));
    assert.equal(now.birth, deleted.birth);
    assert.deepEqual(result.lines.slice(-2), [`published ${now.token}`, "committed"]);
    assert.deepEqual(readdirSync(dir).sort(), ["source", "target"]);
  }, tunnelling);
  add("a rename into a name deleted moments ago commits", (dir) => {
    const deleted = freedLater(dir, "target", "deleted bytes");
    rmSync(join(dir, "target"));
    const result = answered(["--dir-rename", ...held(dir), "source", ...held(dir), "target", "--expect", tokenOf(join(dir, "source"))]);
    assert.equal(result.code, 0, JSON.stringify(result));
    const now = factsOf(join(dir, "target"));
    assert.equal(now.birth, deleted.birth);
    assert.deepEqual(result.lines, ["ready", `published ${now.token}`, "committed"]);
  }, tunnelling);
  add("target restore takes a renamed writer by its file ID and volume only", (dir) => {
    const source = join(dir, hidden);
    const target = join(dir, "target");
    writeFileSync(source, "old bytes");
    writeFileSync(target, "new bytes");
    writeFileSync(join(dir, "other"), "other bytes");
    const args = ["--dir-restore-target", ...held(dir), hidden, "target", "--expect", tokenOf(source)];
    for (const extra of [["--writer", tokenOf(target)], ["--retire"]]) {
      assert.equal(answered([...args, "--renamed-writer", tokenOf(target), ...extra]).code, 2, extra.join(" "));
    }
    expect([...args, "--renamed-writer", tokenOf(join(dir, "other"))], ["ready", "left"]);
    assert.equal(readFileSync(source, "utf8"), "old bytes");
    expect([...args, "--renamed-writer", tokenOf(target, 1n)], ["ready", "resolved"]);
    assert.ok(!existsSync(source));
    assert.equal(readFileSync(target, "utf8"), "new bytes");
  });
  add("stamps a file another handle holds open for writing", (dir) => {
    const path = join(dir, "staged");
    writeFileSync(path, "partial");
    const writer = openSync(path, "r+");
    try {
      expect(["--dir-stamp", ...held(dir), "staged"], ["ready", `stamp ${tokenOf(path)}`]);
    } finally {
      closeSync(writer);
    }
  });
  add("keeps a retirement record while a concurrent reader holds delete sharing", async (dir) => {
    const root = join(dir, "records");
    mkdirSync(root);
    const record = `${"a".repeat(32)}.cleanup.json`;
    const target = join(dir, "target");
    const hiddenPath = join(dir, hidden);
    writeFileSync(join(dir, "source"), "new bytes");
    writeFileSync(target, "old bytes");
    const old = snapshot(target);
    let writer;
    const reader = openSync(target, "r");
    try {
      const result = await runCopy(["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], (line, stdin) => {
        if (line === "ready") stdin.write("c");
        if (line.startsWith("copy-id ")) writer = line.slice("copy-id ".length);
        if (line === "copied") {
          const body = Buffer.from(JSON.stringify({ old, writer })).toString("hex");
          expect(["--dir-write-record", ...held(root), record, body], ["ready", "written"]);
          stdin.end("c");
        }
      });
      assert.equal(result.code, 0);
      assert.match(result.lines.at(-2), /^target-left left \.[0-9a-f]{32}\.removing \d+:[0-9a-f]{32}:creation:[1-9]\d* remove-failed (?:-|\S+)$/u);
      assert.equal(result.lines.at(-1), "committed");
      assert.ok(readdirSync(dir).includes(hidden));
      expect(["--dir-restore-target", ...held(dir), hidden, "target", ...old, "--writer", writer], ["ready", "left"]);
      expect(["--dir-sweep", ...held(root), "--keep-records"], ["ready", "swept 0"]);
      assert.ok(existsSync(join(root, record)));
    } finally {
      closeSync(reader);
    }
    assert.ok(!existsSync(hiddenPath));
    expect(["--dir-restore-target", ...held(dir), hidden, "target", ...old, "--writer", writer], ["ready", "resolved"]);
    assert.equal(readFileSync(target, "utf8"), "new bytes");
    expect(removeRecord(root, record), ["ready", "removed"]);
  });

  add("keeps the journal while the recorded writer part is delete-pending", (dir) => {
    const partPath = join(dir, part);
    writeFileSync(partPath, "writer bytes");
    const known = snapshot(partPath);
    expect(["--dir-write-record", ...held(dir), record, "7b7d"], ["ready", "written"]);
    const reader = openSync(partPath, "r");
    try {
      const result = answered(["--dir-remove-id", ...held(dir), part, ...known]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.lines.at(-1), /^left(?: .*)?$/u);
      assert.ok(readdirSync(dir).includes(part), "pending cleanup keeps the recorded part name observable");
      assert.ok(existsSync(join(dir, record)));
    } finally {
      closeSync(reader);
    }
    expect(["--dir-remove-id", ...held(dir), part, ...known], ["ready", "absent"]);
    expect(removeRecord(dir, record), ["ready", "removed"]);
  });

  for (const boundary of ["before-move", "after-move", "after-commit", "leftover"]) {
    add(`replacement restart after ${boundary}`, async (dir) => {
      const root = join(dir, "records");
      mkdirSync(root);
      const target = join(dir, "target");
      writeFileSync(join(dir, "source"), "new bytes");
      writeFileSync(target, "old bytes");
      const old = snapshot(target);
      let saved;
      let writer;
      const result = await runCopy([`stop-${boundary}`, "--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden], (line, stdin) => {
        if (line === "ready") stdin.write("c");
        if (line.startsWith("copy-id ")) writer = line.slice("copy-id ".length);
        if (line === "copied") {
          saved = Buffer.from(JSON.stringify({ hidden, old, writer })).toString("hex");
          expect(["--dir-write-record", ...held(root), record, saved], ["ready", "written"]);
          stdin.end("c");
        }
      }, join(tmpdir(), "ave-path-pin-test.exe"));
      assert.equal(result.code, 7, JSON.stringify(result));
      assert.equal(result.lines[1], `target-id ${old[1]}`);
      if (boundary === "leftover") assert.match(result.lines.at(-1), /^target-left left /u);
      else if (boundary === "after-commit") assert.match(result.lines.at(-1), /^published /u);
      else assert.equal(result.lines.at(-1), "copied");
      expect(["--dir-read", ...held(root), record, "8192"], ["ready", `record ${saved}`]);
      if (boundary === "before-move") {
        assert.deepEqual(snapshot(target), old);
        assert.ok(!existsSync(join(dir, hidden)));
      } else {
        assert.deepEqual(snapshot(join(dir, hidden)), old);
      }
      // Stopped after the commit rename, the record holds only the writer seen before it, so recovery takes it by file ID and volume.
      expect(["--dir-restore-target", ...held(dir), hidden, "target", "--expect", old[1],
        boundary === "after-commit" ? "--renamed-writer" : "--writer", writer], ["ready", "resolved"]);
      if (boundary === "after-commit") {
        assert.equal(readFileSync(target, "utf8"), "new bytes");
      } else {
        assert.deepEqual(snapshot(target), old);
      }
      assert.ok(!existsSync(join(dir, hidden)));
    }, boundary === "after-commit" ? tunnelling : undefined);
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
        if (zeroRecovery) known[1] = known[1].replace(/:[0-9a-f]{32}:/u, `:${"0".repeat(32)}:`);
        const args = recovery ? ["--dir-remove-id", ...held(dir), hidden, ...known]
          : ["--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden];
        const position = zeroRecovery ? "recovery" : site === "writer" ? "second" : "first";
        const result = await runCopy([`file-id-${fault}-${position}`, ...args], (line, stdin) => {
          if (line === "ready") stdin.write("c");
          if (line === "copied") stdin.end("c");
        }, join(tmpdir(), "ave-path-pin-test.exe"));
        const expected = site === "directory" ? { code: 3, lines: ["refused to"] }
          : site === "writer" ? { code: 4, lines: ["ready", "failed EUNKNOWN left"] }
          : { code: 0, lines: ["ready", "left"] };
        assert.deepEqual({ code: result.code, lines: result.lines.filter((line) => !line.startsWith("destination-id ")) }, expected);
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
      const args = [blocked ? "commit-blocked" : "commit-mismatch", "--dir-copy", ...held(dir), "source", ...held(dir), "target", part, hidden];
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
  for (const [label, test, makeRoot] of tests) {
    let root;
    try {
      root = makeRoot();
      await test(root);
      console.log(`PASS ${label}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${label}\n${error}`);
    } finally {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
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
  let result = answered(["--dir-rename", ...held(from), "a", ...held(to), "report.pdf", "--expect", tokenOf(join(from, "a"))], "c");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.lines, ["ready", `published ${tokenOf(join(to, "report.pdf"))}`, "committed"]);
  assert.equal(readFileSync(join(to, "report.pdf"), "utf8"), "staged a");

  writeFileSync(join(from, "b"), "staged b");
  result = answered(["--dir-rename", ...held(from), "b", ...held(to), "report.pdf", "--expect", tokenOf(join(from, "b"))], "");
  assert.deepEqual(result.lines, ["ready", "cancelled"], "the end of input at a step stops it");
  assert.equal(readFileSync(join(to, "report.pdf"), "utf8"), "staged a");
  result = answered(["--dir-rename", ...held(from), "b", ...held(to), "report.pdf", "--expect", tokenOf(join(from, "b"))], "c");
  assert.deepEqual(result.lines, ["ready", "replace"]);
  assert.equal(readFileSync(join(to, "report.pdf"), "utf8"), "staged a");
  assert.equal(readFileSync(join(from, "b"), "utf8"), "staged b");

  const [path, volume, index] = held(to);
  result = answered(["--dir-rename", ...held(from), "b", path, volume, (BigInt(index) + 1n).toString(), "report.pdf", "--expect", tokenOf(join(from, "b"))], "c");
  assert.equal(result.code, 3);
  assert.deepEqual(result.lines, ["refused to"], "another directory at the checked path is refused before anything is asked");
  const [fromPath, fromVolume, fromIndex] = held(from);
  result = answered(["--dir-remove", fromPath, fromVolume, (BigInt(fromIndex) + 1n).toString(), "b", "--expect", tokenOf(join(from, "b"))], "c");
  assert.deepEqual(result.lines, ["refused from"]);

  // Junctions point at an empty folder inside the fixture, and are unlinked on their own before the fixture is removed.
  const elsewhere = join(dirOps, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(to, "junction.pdf"), "junction");
  result = answered(["--dir-rename", ...held(from), "b", ...held(to), "junction.pdf", "--expect", tokenOf(join(from, "b"))], "c");
  assert.deepEqual(result.lines, ["ready", "refused target"]);
  assert.ok(existsSync(join(from, "b")));

  result = answered(["--dir-copy", ...held(from), "b", ...held(to), "copied.pdf", ".0123.part", ".0123456789abcdef0123456789abcdef.removing"], "cc");
  assert.match(result.lines[2], /^writing \d+:[0-9a-f]{32}:creation:[1-9]\d*$/u);
  assert.equal(result.lines[3], "cancelled", "input that arrives while bytes are copied stops the copy");
  assert.deepEqual(readdirSync(to).sort(), ["junction.pdf", "report.pdf"]);
  const copy = spawn(helper, ["--dir-copy", ...held(from), "b", ...held(to), "copied.pdf", ".0123.part", ".0123456789abcdef0123456789abcdef.removing"], { windowsHide: true, shell: false, env: {} });
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
  const [, ready, writing, ...outcome] = copied.output.split(/\r?\n/u).filter(Boolean);
  assert.equal(ready, "ready");
  assert.match(writing, /^writing \d+:[0-9a-f]{32}:creation:[1-9]\d*$/u);
  assert.deepEqual(outcome, ["progress 8", "copied", `published ${tokenOf(join(to, "copied.pdf"))}`, "committed"]);
  assert.equal(readFileSync(join(to, "copied.pdf"), "utf8"), "staged b");
  assert.ok(!existsSync(join(to, ".0123.part")));

  const staged = tokenOf(join(from, "b"));
  result = answered(["--dir-remove", ...held(from), "b", "--expect", tokenOf(join(from, "b"), 1n)], "c");
  assert.deepEqual(result.lines, ["ready", "refused source"], "a removal whose stamp has another creation time keeps the file");
  assert.equal(readFileSync(join(from, "b"), "utf8"), "staged b");
  result = answered(["--dir-stamp", ...held(from), "b"], "c");
  assert.deepEqual(result.lines, ["ready", `stamp ${staged}`]);
  result = answered(["--dir-remove", ...held(from), "b", "--expect", staged], "c");
  assert.deepEqual(result.lines, ["ready", "removed"]);
  result = answered(["--dir-remove", ...held(from), "b", "--expect", staged], "c");
  assert.deepEqual(result.lines, ["ready", "absent"]);
  result = answered(["--dir-stamp", ...held(from), "b"], "c");
  assert.deepEqual(result.lines, ["ready", "absent"]);
  result = answered(["--dir-remove", ...held(from), "b"], "c");
  assert.equal(result.code, 2, "a removal without a stamp is a usage error");

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
