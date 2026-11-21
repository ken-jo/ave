import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it, mock } from "node:test";
import { parse } from "yaml";
import { windowsPowerShellEnv, windowsPowerShellPath } from "../../scripts/lib/windows-powershell-env.mjs";
import { assertNoJobRootWriters, diagnoseJobRoot } from "../../.github/scripts/job-root-diagnostic.mjs";
import { cleanupWindowsJobRoot as cleanupJobRoot, diagnoseCleanupFailure, hardenWindowsJobRoot, isolationAssignments, validateJobHomeRoot } from "../../.github/scripts/isolate-job-home.mjs";
import { JOB_RECEIPTS, runInJob } from "../../.github/scripts/run-in-job.mjs";

describe("job home isolation", () => {
  it("places Windows fixtures on the system volume instead of the runner temp volume", async () => {
    const create = mock.fn(() => "C:\\ave-ci-abc123");
    const publish = mock.fn();
    const values = await isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot: "C:\\Windows" },
      create, mock.fn(), () => "1:2:3", publish);
    assert.deepEqual(create.mock.calls.map(call => call.arguments), [["C:\\ave-ci-"]]);
    assert.deepEqual(values, {
      HOME: "C:\\ave-ci-abc123\\home", USERPROFILE: "C:\\ave-ci-abc123\\home",
      AVE_HOME: "C:\\ave-ci-abc123\\home\\.ave", TMPDIR: "C:\\ave-ci-abc123\\tmp",
      TEMP: "C:\\ave-ci-abc123\\tmp", TMP: "C:\\ave-ci-abc123\\tmp",
      AVE_TEST_TMP_ROOT: "C:\\ave-ci-abc123\\home\\.ave-test-tmp",
      LOCALAPPDATA: "C:\\ave-ci-abc123\\home\\local-app-data", APPDATA: "C:\\ave-ci-abc123\\home\\app-data",
      AVE_CI_JOB_ROOT: "C:\\ave-ci-abc123", AVE_CI_JOB_ROOT_IDENTITY: "1:2:3",
    });
    assert.deepEqual(publish.mock.calls.map(call => call.arguments), [
      [{ AVE_CI_JOB_ROOT: "C:\\ave-ci-abc123", AVE_CI_JOB_ROOT_IDENTITY: "unknown" }], [values],
    ]);
  });
  it("leaves room for socket paths before publishing environment changes", async () => {
    await assert.rejects(() => isolationAssignments({ platform: "darwin", runnerTemp: "/".padEnd(81, "a") }), /socket path/);
  });

  it("publishes the unverified job root for cleanup and preserves it when its identity cannot be read", async t => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "example-")));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const root = "C:\\ave-ci-abc123";
    const localRoot = join(parent, win32.basename(root));
    const sentinel = join(parent, "shared");
    writeFileSync(sentinel, "preserve");
    const identityError = new Error("Could not read directory identity");
    const create = () => { mkdirSync(localRoot); return root; };
    const harden = mock.fn();
    const events = [];
    const env = {};
    const publish = assignments => { events.push("publish"); Object.assign(env, assignments); };

    await assert.rejects(() => isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, create, harden,
      () => { events.push("read"); throw identityError; }, publish), error => {
      assert.match(error.message, /Directory left at /);
      assert.ok(error.message.includes(root));
      assert.equal(error.cause, identityError);
      return true;
    });
    assert.deepEqual(readdirSync(localRoot), []);
    assert.equal(harden.mock.callCount(), 0);
    assert.deepEqual(events, ["publish", "read"]);
    assert.deepEqual(env, { AVE_CI_JOB_ROOT: root, AVE_CI_JOB_ROOT_IDENTITY: "unknown" });

    const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const cleanup = workflow.jobs["windows-permission-tests"].steps
      .find(step => step.name === "Remove isolated system-volume job directory");
    assert.equal(cleanup.if, "steps.docs-impact.outputs.docs_only != 'true' && always() && env.AVE_CI_JOB_ROOT != ''");
    assert.equal(cleanup.run, "node ave/.github/scripts/isolate-job-home.mjs --cleanup");

    const readIdentity = mock.fn(() => fixtureIdentity(localRoot));
    const rename = mock.fn();
    const remove = mock.fn();
    await assert.rejects(cleanupJobRoot(env.AVE_CI_JOB_ROOT, {
      systemRoot: "C:\\Windows", identity: env.AVE_CI_JOB_ROOT_IDENTITY, readIdentity, rename, remove,
    }), { message: `Cannot clean up job root ${root}: directory identity is unknown or invalid` });
    for (const operation of [readIdentity, rename, remove]) assert.equal(operation.mock.callCount(), 0);
    assert.deepEqual(readdirSync(localRoot), []);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
  });

  it("keeps non-Windows homes under runner temp", async () => {
    const create = mock.fn();
    const home = "/runner/temp/home";
    assert.deepEqual(await isolationAssignments({ platform: "linux", runnerTemp: "/runner/temp" }, create), {
      HOME: home, USERPROFILE: home, AVE_HOME: `${home}/.ave`,
      TMPDIR: "/runner/temp/tmp", TEMP: "/runner/temp/tmp", TMP: "/runner/temp/tmp",
    });
    assert.equal(create.mock.callCount(), 0);
  });
  for (const systemRoot of [undefined, "Windows", "\\\\host\\share\\Windows"]) {
    it(`refuses an invalid system directory before creating a root: ${systemRoot}`, async () => {
      const create = mock.fn();
      await assert.rejects(() => isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot }, create), /local system volume/);
      assert.equal(create.mock.callCount(), 0);
    });
  }
  it("accepts only an isolated job directory directly on the system volume for cleanup", () => {
    assert.equal(validateJobHomeRoot("C:\\ave-ci-abc123", "C:\\Windows"), "C:\\ave-ci-abc123");
    for (const root of ["C:\\", "C:\\Users\\alice", "C:\\ave-ci-abc123\\home", "D:\\ave-ci-abc123", "C:\\other", "C:\\ave-ci-abc123\\..\\other"]) {
      assert.throws(() => validateJobHomeRoot(root, "C:\\Windows"), /isolated job root/);
    }
  });
});

function blockedRemoval() {
  return Object.assign(new Error("Removal blocked"), { code: "EPERM", syscall: "unlink" });
}
function cleanupSeams(error = blockedRemoval()) {
  return {
    remove: mock.fn(() => { throw error; }), run: queryResult(), diagnostic: mock.fn(),
  };
}
// The cleanup precondition streams only process rows; the post-failure diagnostic streams entries and holders first.
function queryRecords({
  processes = [], holders = [], entries = [], failed = false, changed = false, limited = false,
  processScanFailed = false, processLimited = false, preflight = false,
} = {}) {
  const rows = [
    ...(preflight ? [] : [
      ...entries.map(entry => ({ kind: "candidate", ...entry })),
      { kind: "files", failed, changed, limited, empty: entries.length === 0 },
      ...holders,
      { kind: "holders", limited: false, failed: false },
    ]),
    ...processes,
    { kind: "processes", failed: processScanFailed, limited: processLimited },
  ];
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}
const QUERY_VARIABLE = "AVE_CI_JOB_ROOT_QUERY";
function isPreflightQuery(options) {
  return /^\$preflight = \$true$/m.test(options.env[QUERY_VARIABLE]);
}
function queryResult(result) {
  return mock.fn((_command, _args, options, done) => done(null, queryRecords({ ...result, preflight: isPreflightQuery(options) })));
}
async function cleanupWindowsJobRoot(root, { remove = rmSync, ...options } = {}) {
  try { await diagnoseCleanupFailure(root, () => remove(root, { recursive: true, force: true }), options); }
  finally { await nextTurn(); }
}
const PROCESS_DETAILS = {
  kind: "process", pid: 4000, unresolvedParentPid: 2000, image: "C:\\fixture\\holder.exe", reason: "argument",
  created: "2026-01-02T03:04:05.0000000Z",
};
function output(seams) {
  return seams.diagnostic.mock.calls.map(call => call.arguments[0]).join("\n");
}
function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function runFixturePowerShell(script) {
  const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`;
  return execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, stdio: "pipe", env: windowsPowerShellEnv() }).trim();
}
function runFixtureQuery(executable, args, { env, encoding, windowsHide }, done) {
  const child = spawn(executable, args, { env, windowsHide, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.setEncoding(encoding);
  child.once("error", done);
  child.once("close", code => done(code === 0 ? null : new Error("Fixture query failed")));
  return child;
}
function runInjectedQuery(injection, transform = script => script) {
  return (_command, args, options, done) => {
    const env = { ...options.env, [QUERY_VARIABLE]: `${injection}\n${transform(options.env[QUERY_VARIABLE])}` };
    return runFixtureQuery(windowsPowerShellPath(), args, { ...options, env }, done);
  };
}
async function within(promise, ms, message) {
  const timer = new AbortController();
  try {
    return await Promise.race([promise, sleep(ms, undefined, { signal: timer.signal }).then(() => { throw new Error(message); })]);
  } finally { timer.abort(); }
}
function fixtureAcl(path) {
  return `Get-Acl -LiteralPath ${powerShellLiteral(path)}`;
}
function applyFixtureDenies(rules, savedAcls) {
  const sid = runFixturePowerShell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  const sddl = JSON.parse(runFixturePowerShell("ConvertTo-Json -Compress -InputObject @(" +
    rules.map(([path]) => `(${fixtureAcl(path)}).Sddl`).join("; ") + ")"));
  for (const [i, [path]] of rules.entries()) savedAcls.set(path, sddl[i]);
  runFixturePowerShell(rules.map(([path, rights]) => [
    `$acl = ${fixtureAcl(path)}`,
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(" +
      "[Security.Principal.SecurityIdentifier]::new('" + sid + "'), '" + rights + "', 'Deny'))",
    `Set-Acl -LiteralPath ${powerShellLiteral(path)} -AclObject $acl`,
  ].join("\n")).join("\n"));
  return sid;
}
function restoreFixtureAcls(savedAcls) {
  if (savedAcls.size === 0) return;
  const restore = [...savedAcls].filter(([path]) => existsSync(path)).map(([path, sddl]) => [
    "try {",
    `  $acl = ${fixtureAcl(path)}`,
    `  $acl.SetSecurityDescriptorSddlForm(${powerShellLiteral(sddl)}, 'Access')`,
    `  Set-Acl -LiteralPath ${powerShellLiteral(path)} -AclObject $acl`,
    "} catch { $restoreError = $_ }",
  ].join("\n"));
  runFixturePowerShell(["$restoreError = $null", ...restore, "if ($restoreError) { throw $restoreError }"].join("\n"));
}

function fixtureIdentity(path) {
  const { dev, ino, birthtimeNs } = lstatSync(path, { bigint: true });
  return `${dev}:${ino}:${birthtimeNs}`;
}

const MANIFEST = [
  { id: "example-1", receipt: "example-1.receipt", invocation: "node example.mjs" },
  { id: "example-2", receipt: "example-2.receipt", invocation: "node example.mjs shared" },
];
function provenReceipts(identity, manifest = MANIFEST) {
  return manifest.map(({ id, receipt }) => ({ name: receipt, text: `${id}\n${identity}\n0` }));
}

// Mirrors the hosted failure: 19 branch and 79 leaf directories, 5,121 files, directory depth 8.
function writeRealisticJobTree(localRoot) {
  for (const branch of [
    "home/.ave/cache/models/example/blobs/sha256", "home/.ave-test-tmp", "home/local-app-data/example",
    "home/app-data/example", "tmp/example/target/release/deps", "tmp/example/target/release/build/example",
  ]) mkdirSync(join(localRoot, ...branch.split("/")), { recursive: true });
  let leaf = 0;
  for (const [branch, count] of [
    ["home/.ave/cache/models/example/blobs/sha256", 40], ["tmp/example/target/release/deps", 20],
    ["tmp/example/target/release/build/example", 10], ["home/.ave-test-tmp", 3],
    ["home/local-app-data/example", 3], ["home/app-data/example", 3],
  ]) {
    for (let i = 0; i < count; i++, leaf++) {
      const directory = join(localRoot, ...branch.split("/"), `example-${i}`);
      mkdirSync(directory);
      for (let j = 0; j < (leaf < 64 ? 65 : 64); j++) writeFileSync(join(directory, `example-${j}.dat`), "example");
    }
  }
  return readdirSync(localRoot, { recursive: true }).length;
}

describe("Windows job root writer precondition", () => {
  const root = "C:\\ave-ci-abc123";
  const systemRoot = "C:\\Windows";

  function fixture(t) {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "example-")));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const localRoot = join(parent, win32.basename(root));
    const held = join(localRoot, "example.log");
    const sentinel = join(parent, "shared");
    mkdirSync(localRoot);
    writeFileSync(held, "example");
    writeFileSync(sentinel, "preserve");
    const localPath = path => join(parent, win32.basename(path));
    const identity = fixtureIdentity(localRoot);
    return {
      parent, localRoot, held,
      options: {
        systemRoot, identity,
        readIdentity: path => fixtureIdentity(localPath(path)),
        rename: (from, to) => renameSync(localPath(from), localPath(to)),
        remove: (path, options) => rmSync(localPath(path), options),
        readReceipts: () => provenReceipts(identity), manifest: MANIFEST,
      },
      assertPreserved() {
        assert.equal(readFileSync(held, "utf8"), "example");
        assert.equal(readFileSync(sentinel, "utf8"), "preserve");
        assert.deepEqual(readdirSync(parent).sort(), [win32.basename(root), "shared"]);
      },
    };
  }

  function assertReportedRoot(error, originalRoot) {
    assert.equal(/^Cannot clean up job root (.+?): /.exec(error.message)?.[1], originalRoot);
  }

  it("preserves the original root when the writer query fails", async t => {
    const job = fixture(t);
    const run = (_command, _args, _options, done) => done(new Error("Query unavailable"));
    await assert.rejects(cleanupJobRoot(root, { ...job.options, run }), error => {
      assert.match(error.message, /writer evidence is incomplete/i);
      assert.match(error.message, /Query unavailable/);
      assertReportedRoot(error, root);
      return true;
    });
    job.assertPreserved();
  });

  it("reports the writer query deadline and the unfinished process scan", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assertNoJobRootWriters(root, () => {});
    t.mock.timers.tick(5_000);
    await assert.rejects(result, /5000 ms deadline\nCleanup process scan did not report completion/);
  });

  it("terminates a query at its deadline and leaves no descendants", { skip: process.platform !== "win32" }, async () => {
    const stalled = runInjectedQuery("function Get-CimInstance($Class, $Property, $Filter) { Start-Sleep -Seconds 30 }");
    let child;
    let exited;
    await assert.rejects(assertNoJobRootWriters(root, (...args) => {
      child = stalled(...args);
      exited = once(child, "exit");
      return child;
    }), /5000 ms deadline/);
    assert.deepEqual(await exited, [null, "SIGTERM"]);
    assert.equal(runFixturePowerShell(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}').Count`), "0");
  });

  it("reports an incomplete writer record stream that exceeds the byte limit", async () => {
    const run = (_command, _args, { maxBuffer }, done) => done(null, " ".repeat(maxBuffer + 1));
    await assert.rejects(assertNoJobRootWriters(root, run), /output exceeded 65536 bytes/);
  });

  it("refuses a writer query with a malformed process status", async () => {
    const run = (_command, _args, _options, done) => done(null, `${JSON.stringify({ kind: "processes", limited: false })}\n`);
    await assert.rejects(assertNoJobRootWriters(root, run), /Invalid cleanup processes status field: failed/);
  });

  it("refuses a writer query that streams entry or holder rows", async () => {
    const run = (_command, _args, _options, done) => done(null, queryRecords());
    await assert.rejects(assertNoJobRootWriters(root, run), error => {
      assert.match(error.message, /writer evidence is incomplete/);
      assert.match(error.message, /^Unexpected process record$/m);
      return true;
    });
  });

  for (const [flag, reason] of [
    ["recordLimited", "Native file holder records exceeded the 128-record limit"],
    ["byteLimited", "Native file holder output reached its 53248-byte limit"],
    ["lookupLimited", "Native file holder lookup covered only the first 20 files"],
  ]) {
    it(`reports the diagnostic holder ${flag} bound`, async () => {
      const status = queryRecords().split("\n");
      status[1] = JSON.stringify({ kind: "holders", failed: false, limited: flag !== "lookupLimited", [flag]: true });
      const diagnostic = mock.fn();
      await diagnoseJobRoot(root, diagnostic, (_command, _args, _options, done) => done(null, status.join("\n")));
      assert.ok(output({ diagnostic }).split("\n").includes(reason), output({ diagnostic }));
    });
  }

  if (process.platform === "win32") {
    it("removes a junction inside the root without following it", async t => {
      const job = fixture(t);
      mkdirSync(join(job.localRoot, "home"));
      symlinkSync(job.parent, join(job.localRoot, "home", "example"), "junction");
      await cleanupJobRoot(root, { ...job.options, run: scanLocalRoot(job), diagnostic: () => {} });
      assert.deepEqual(readdirSync(job.parent), ["shared"]);
      assert.equal(readFileSync(join(job.parent, "shared"), "utf8"), "preserve");
    });

    it("cleans a realistic 5k-entry job root within the query deadline", async t => {
      const job = fixture(t);
      const entries = writeRealisticJobTree(job.localRoot);
      assert.equal(entries, 5219);
      const scan = scanLocalRoot(job);
      let queryMs;
      const run = (command, args, options, done) => {
        const start = performance.now();
        return scan(command, args, options, (error, stdout) => {
          queryMs = Math.round(performance.now() - start);
          done(error, stdout);
        });
      };
      const diagnostic = mock.fn();
      const start = performance.now();
      await cleanupJobRoot(root, { ...job.options, run, diagnostic });
      const cleanupMs = Math.round(performance.now() - start);
      assert.deepEqual(readdirSync(job.parent), ["shared"]);
      const timing = output({ diagnostic }).split("\n").find(line => /^Cleanup process scan inspected \d+ process rows in \d+ ms$/.test(line));
      assert.ok(timing, output({ diagnostic }));
      t.diagnostic(`${entries} entries: query ${queryMs} ms, cleanup ${cleanupMs} ms; ${timing}`);
    });

    it("keeps the post-failure diagnostic of a 5k-entry root within the query deadline", async t => {
      const job = fixture(t);
      assert.equal(writeRealisticJobTree(job.localRoot), 5219);
      const diagnostic = mock.fn();
      const start = performance.now();
      await diagnoseJobRoot(job.localRoot, diagnostic);
      const lines = output({ diagnostic }).split("\n");
      assert.ok(lines.includes("Native file holder lookup covered only the first 20 files"), lines.join("\n"));
      assert.equal(lines.filter(line => line.startsWith("candidate path=")).length, 20);
      t.diagnostic(`diagnostic ${Math.round(performance.now() - start)} ms`);
      job.assertPreserved();
    });
  }

  for (const [name, records] of [
    ["failed", queryRecords({ preflight: true, processScanFailed: true })],
    ["limited", queryRecords({ preflight: true, processLimited: true })],
    ["missing its status", queryRecords({ preflight: true }).replace(/^.*"kind":"processes".*\n/m, "")],
  ]) {
    it(`refuses cleanup when the process scan is ${name}`, async t => {
      const job = fixture(t);
      const run = (_command, _args, _options, done) => done(null, records);
      await assert.rejects(cleanupJobRoot(root, { ...job.options, run }), error => {
        assertReportedRoot(error, root);
        assert.match(error.message, /writer evidence is incomplete/);
        assert.match(error.message, /^Cleanup process scan was incomplete$/m);
        return true;
      });
      job.assertPreserved();
    });
  }

  it("refuses cleanup for a missing receipt ledger before scanning processes", async t => {
    const job = fixture(t);
    const run = queryResult();
    const readReceipts = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    await assert.rejects(cleanupJobRoot(root, { ...job.options, readReceipts, run }),
      { message: `Cannot clean up job root ${root}: the job receipt ledger is unreadable` });
    assert.equal(run.mock.callCount(), 0);
    job.assertPreserved();
  });

  const FOREIGN = "00000000-0000-4000-8000-000000000000.receipt";
  const [first, second] = MANIFEST;
  for (const [name, receipts, problems] of [
    ["an empty ledger", () => [], [`"${first.receipt}" is missing`, `"${second.receipt}" is missing`]],
    ["a missing step", identity => provenReceipts(identity).slice(0, 1), [`"${second.receipt}" is missing`]],
    ["a foreign zero file", identity => [...provenReceipts(identity), { name: FOREIGN, text: "0" }],
      [`"${FOREIGN}" is not a contained-step receipt`]],
    ["a foreign directory", identity => [...provenReceipts(identity), { name: "example", text: undefined }],
      [`"example" is not a contained-step receipt`]],
    ["a wrong identity", identity => [{ name: first.receipt, text: `${first.id}\n1:2:3\n0` }, provenReceipts(identity)[1]],
      [`"${first.receipt}" names another job root`]],
    ["a wrong step", identity => [{ name: first.receipt, text: `${second.id}\n${identity}\n0` }, provenReceipts(identity)[1]],
      [`"${first.receipt}" names another step`]],
    ["a registered step without a verdict", identity => [{ name: first.receipt, text: `${first.id}\n${identity}\n` }, provenReceipts(identity)[1]],
      [`"${first.receipt}" has no zero verdict`]],
    ["a non-zero verdict", identity => [{ name: first.receipt, text: `${first.id}\n${identity}\n1` }, provenReceipts(identity)[1]],
      [`"${first.receipt}" has no zero verdict`]],
  ]) {
    it(`refuses cleanup for ${name} before scanning processes`, async t => {
      const job = fixture(t);
      const run = queryResult();
      await assert.rejects(cleanupJobRoot(root, { ...job.options, readReceipts: () => receipts(job.options.identity), run }), {
        message: [`Cannot clean up job root ${root}: ${problems.length} contained-step receipts are missing or unproven`,
          ...problems.map(problem => `receipt ${problem}`)].join("\n"),
      });
      assert.equal(run.mock.callCount(), 0);
      job.assertPreserved();
    });
  }

  it("checks receipts against the workflow manifest by default", async t => {
    const job = fixture(t);
    const { containedStepManifest } = await import("../../.github/scripts/run-in-job.mjs");
    const manifest = await containedStepManifest();
    assert.ok(manifest.length > 1);
    await cleanupJobRoot(root, {
      ...job.options, manifest: undefined, readReceipts: () => provenReceipts(job.options.identity, manifest), run: queryResult(),
    });
    assert.deepEqual(readdirSync(job.parent), ["shared"]);
  });

  const TOMBSTONE = /^ave-ci-abc123\.cleanup-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
  for (const stage of ["rename", "remove"]) {
    it(`refuses cleanup with the error when the quarantine ${stage} fails`, async t => {
      const job = fixture(t);
      const failure = Object.assign(new Error(`EPERM: operation not permitted, ${stage}`), { code: "EPERM", syscall: stage });
      const diagnostic = mock.fn();
      await assert.rejects(cleanupJobRoot(root, {
        ...job.options, [stage]: () => { throw failure; }, run: queryResult(), diagnostic,
      }), error => {
        assertReportedRoot(error, root);
        assert.equal(error.cause, failure);
        const tombstone = /(?:rename to|removing) (\S+) failed/.exec(error.message)?.[1];
        assert.match(win32.basename(tombstone ?? ""), TOMBSTONE, error.message);
        assert.equal(error.message, stage === "rename"
          ? `Cannot clean up job root ${root}: rename to ${tombstone} failed (${failure.message}). Directory left in place.`
          : `Cannot clean up job root ${root}: removing ${tombstone} failed (${failure.message}). Remaining entries left at ${tombstone}.`);
        return true;
      });
      await nextTurn();
      assert.ok(output({ diagnostic }).includes(`Job root cleanup failed: code="EPERM" syscall="${stage}"`), output({ diagnostic }));
      const [left] = readdirSync(job.parent).filter(name => name !== "shared");
      assert.match(left, stage === "rename" ? /^ave-ci-abc123$/u : TOMBSTONE);
      assert.equal(readFileSync(join(job.parent, left, "example.log"), "utf8"), "example");
      assert.equal(readFileSync(join(job.parent, "shared"), "utf8"), "preserve");
    });
  }

  function localReceipts(directory) {
    return readdirSync(directory, { withFileTypes: true }).map(entry => ({
      name: entry.name, text: entry.isFile() ? readFileSync(join(directory, entry.name), "utf8") : undefined,
    }));
  }
  const helpers = fileURLToPath(new URL(`../../resources/windows-job/${process.arch}/`, import.meta.url));
  function containedChild(job, launcher = join(helpers, "ave-job.exe")) {
    const receipts = join(job.localRoot, JOB_RECEIPTS);
    const cwd = join(job.localRoot, "tmp");
    const pidFile = join(job.localRoot, "example.pid");
    mkdirSync(receipts);
    mkdirSync(cwd);
    assert.ok(existsSync(launcher), "Build the Windows job launcher and its fixtures first");
    // The root exits at once; its detached child keeps a cwd under the job root.
    const script = "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],"
      + " { cwd: process.argv[1], detached: true, stdio: 'ignore' }); child.unref(); require('node:fs').writeFileSync(process.argv[2], String(child.pid));";
    const args = ["-e", script, cwd, pidFile];
    const manifest = [{ id: "example-1", receipt: "example-1.receipt", invocation: [process.execPath, ...args].join(" ") }];
    const done = runInJob(process.execPath, args, { root: job.localRoot, identity: job.options.identity, manifest, launcher });
    return { receipts, pidFile, manifest, done };
  }
  const scanLocalRoot = (job, injection = "") => runInjectedQuery(injection, script => script
    .replace(`$root = ${powerShellLiteral(root)}`, `$root = ${powerShellLiteral(job.localRoot)}`));

  function wrapperJob(t) {
    const job = fixture(t);
    mkdirSync(join(job.localRoot, JOB_RECEIPTS));
    const launcher = join(job.parent, "missing-launcher.exe");
    return { ...job, launcher, receipts: () => localReceipts(join(job.localRoot, JOB_RECEIPTS)) };
  }

  it("registers nothing for an invocation outside the manifest", t => {
    const job = wrapperJob(t);
    assert.throws(() => runInJob("node", ["other.mjs"], { root: job.localRoot, identity: job.options.identity, manifest: MANIFEST, launcher: job.launcher }),
      { message: "Not a contained workflow step: node other.mjs" });
    assert.deepEqual(job.receipts(), []);
  });

  it("registers nothing without the job-root identity", t => {
    const job = wrapperJob(t);
    assert.throws(() => runInJob("node", ["example.mjs"], { root: job.localRoot, manifest: MANIFEST, launcher: job.launcher }),
      { message: "Contained test commands require AVE_CI_JOB_ROOT_IDENTITY" });
    assert.deepEqual(job.receipts(), []);
  });

  it("refuses to re-register a step that already has a receipt", t => {
    const job = wrapperJob(t);
    const [proof] = provenReceipts(job.options.identity);
    writeFileSync(join(job.localRoot, JOB_RECEIPTS, proof.name), proof.text);
    assert.throws(() => runInJob("node", ["example.mjs"], { root: job.localRoot, identity: job.options.identity, manifest: MANIFEST, launcher: job.launcher }),
      { code: "EEXIST" });
    assert.deepEqual(job.receipts(), [proof]);
  });

  it("keeps the setup import graph free of installed packages", () => {
    // Setup runs before dependencies are installed; the manifest loads on demand.
    const seen = new Set();
    const visit = url => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      for (const [, specifier] of readFileSync(url, "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gmu)) {
        if (specifier.startsWith("node:")) continue;
        assert.match(specifier, /^\.\.?\//u, `${fileURLToPath(url)} imports ${specifier}`);
        visit(new URL(specifier, url));
      }
    };
    visit(new URL("../../.github/scripts/isolate-job-home.mjs", import.meta.url));
    assert.ok(seen.size >= 5, [...seen].join("\n"));
  });

  if (process.platform === "win32") {
    it("removes the root after the job close kills a live contained child", async t => {
      const job = fixture(t);
      const { receipts, pidFile, manifest, done } = containedChild(job);
      assert.equal(await done, 0);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.deepEqual(localReceipts(receipts), [{ name: "example-1.receipt", text: `example-1\n${job.options.identity}\n0` }]);
      await cleanupJobRoot(root, { ...job.options, manifest, readReceipts: () => localReceipts(receipts), run: scanLocalRoot(job), diagnostic: () => {} });
      assert.deepEqual(readdirSync(job.parent), ["shared"]);
    });

    it("refuses cleanup after a contained step's job query fails", async t => {
      const job = fixture(t);
      const { receipts, manifest, done } = containedChild(job, join(helpers, "ave-job-query-failure.exe"));
      assert.equal(await done, 125);
      assert.deepEqual(localReceipts(receipts), [{ name: "example-1.receipt", text: `example-1\n${job.options.identity}\n` }]);
      await assert.rejects(cleanupJobRoot(root, { ...job.options, manifest, readReceipts: () => localReceipts(receipts), run: scanLocalRoot(job) }), {
        message: `Cannot clean up job root ${root}: 1 contained-step receipts are missing or unproven\nreceipt "example-1.receipt" has no zero verdict`,
      });
      job.assertPreserved();
    });
  }

  it("refuses a process argument match with its parent PID omitted", async t => {
    const job = fixture(t);
    const run = queryResult({
      processes: [{
        kind: "process", pid: PROCESS_DETAILS.pid, reason: "argument",
        image: PROCESS_DETAILS.image, created: PROCESS_DETAILS.created,
      }],
    });
    await assert.rejects(cleanupJobRoot(root, { ...job.options, run }), error => {
      assertReportedRoot(error, root);
      assert.match(error.message, /live processes can still access the job root/i);
      assert.match(error.message, /^process pid=4000 match=argument$/m);
      assert.match(error.message, /^Cleanup process match metadata was unavailable for pid=4000$/m);
      return true;
    });
    job.assertPreserved();
  });

  // The filesystem gates a reference the process scan cannot see: the rename or removal refuses with its error.
  function assertQuarantineRefusal(t, error, reportedRoot, parent) {
    const match = /^Cannot clean up job root (.+?): (?:rename to (\S+) failed \(.+\)\. Directory left in place\.|removing (\S+) failed \(.+\)\. Remaining entries left at (\S+)\.)$/
      .exec(error.message.split("\n")[0]);
    assert.ok(match, error.message);
    assert.equal(match[1], reportedRoot);
    assert.ok(["EPERM", "EBUSY", "EACCES"].includes(error.cause?.code), String(error.cause));
    const left = match[2] ? reportedRoot : match[3];
    if (match[3]) assert.equal(match[4], match[3]);
    assert.ok(readdirSync(parent).includes(win32.basename(left)), readdirSync(parent).join(","));
    assert.equal(readFileSync(join(parent, "shared"), "utf8"), "preserve");
    t.diagnostic(`quarantine refused at ${match[2] ? "rename" : "removal"} with ${error.cause.code}`);
    return left;
  }

  if (process.platform === "win32") {
    const processCases = [
      { name: "an invalid OpenProcess handle", nativeFailure: "OpenProcess failed" },
      { name: "a failed NtQueryInformationProcess call", nativeFailure: "NtQueryInformationProcess failed" },
      { name: "a failed ReadProcessMemory call", nativeFailure: "ReadProcessMemory failed" },
      { name: "a cwd over the byte limit", nativeFailure: "cwd exceeds 4096 bytes" },
      { name: "a missing CIM ExecutablePath", field: "ExecutablePath", value: "$null", reason: "missing CIM ExecutablePath" },
      { name: "a missing CIM CommandLine", field: "CommandLine", value: "$null", reason: "missing CIM CommandLine" },
      { name: "a path conversion error", field: "ExecutablePath", value: '"C:\\example`0.exe"', reason: "path conversion failed (image)" },
    ];
    for (const { name, nativeFailure, field, value, reason = nativeFailure } of processCases) {
      it(`reports ${name} without refusing cleanup`, async t => {
        const job = fixture(t);
        const run = runInjectedQuery("", script => {
          script = script.replace(`$root = ${powerShellLiteral(root)}`, `$root = ${powerShellLiteral(job.localRoot)}`);
          if (nativeFailure) {
            return script.replace("function ReadCurrentDirectory($id) {", `$&
  if ($id -eq ${process.pid}) { return @{ reason = ${powerShellLiteral(nativeFailure)} } }`);
          }
          return script.replace("    $row = $_", `$&
    if ($row.ProcessId -eq ${process.pid}) {
      $row = $row | Select-Object -Property *
      $row.${field} = ${value}
    }`);
        });
        const diagnostic = mock.fn();
        await cleanupJobRoot(root, { ...job.options, run, diagnostic });
        assert.equal(existsSync(job.localRoot), false);
        assert.equal(readFileSync(join(job.parent, "shared"), "utf8"), "preserve");
        const lines = output({ diagnostic });
        assert.ok(lines.split("\n").some(line => line.startsWith(`process unreadable pid=${process.pid} reason=`)
          && line.includes(reason)), lines);
      });
    }

    it("refuses cleanup when a process row has no ProcessId", async t => {
      const job = fixture(t);
      const run = runInjectedQuery("", script => script
        .replace(`$root = ${powerShellLiteral(root)}`, `$root = ${powerShellLiteral(job.localRoot)}`)
        .replace("    $row = $_", `$&
    if ($row.ProcessId -eq ${process.pid}) {
      $row = $row | Select-Object -Property *
      $row.ProcessId = $null
    }`));
      await assert.rejects(cleanupJobRoot(root, { ...job.options, run }), error => {
        assertReportedRoot(error, root);
        assert.match(error.message, /writer evidence is incomplete/);
        assert.match(error.message, /^Cleanup process scan failed: process row without ProcessId$/m);
        assert.match(error.message, /^Cleanup process scan was incomplete$/m);
        return true;
      });
      job.assertPreserved();
    });

    it("reports unreadable process evidence on successful rollback", async t => {
      const job = fixture(t);
      const setupError = new Error("DACL readback failed");
      const diagnostic = mock.fn();
      const run = runInjectedQuery("", script => script
        .replace("function ReadCurrentDirectory($id) {", `$&
  if ($id -eq ${process.pid}) { return @{ reason = 'OpenProcess failed' } }`));
      await assert.rejects(isolationAssignments({ platform: "win32", systemRoot }, () => job.localRoot,
        () => { throw setupError; }, fixtureIdentity, undefined, run, diagnostic), error => error === setupError);
      assert.deepEqual(readdirSync(job.parent), ["shared"]);
      const lines = output({ diagnostic });
      assert.ok(lines.includes(`process unreadable pid=${process.pid} reason="OpenProcess failed"`), lines);
      assert.match(lines, /^Cleanup process scan inspected \d+ process rows in \d+ ms$/m);
    });

    it("refuses rollback when the real process scan reaches its limit", async t => {
      const job = fixture(t);
      const setupError = new Error("DACL readback failed");
      const run = runInjectedQuery("", script => script
        .replace("kind = 'processes'; failed = $script:processFailed; limited = $script:processLimited",
          "kind = 'processes'; failed = $script:processFailed; limited = $true"));
      await assert.rejects(isolationAssignments({ platform: "win32", systemRoot }, () => job.localRoot,
        () => { throw setupError; }, fixtureIdentity, undefined, run), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], setupError);
        assertReportedRoot(error.errors[1], job.localRoot);
        assert.match(error.errors[1].message, /Cleanup process scan reached its inspection or reporting limit/);
        assert.match(error.errors[1].message, /^Cleanup process scan was incomplete$/m);
        return true;
      });
      job.assertPreserved();
    });

    const NEWER_IDLE_ROWS = [
      "function Get-CimInstance($Class, $Property) {",
      "  1..600 | ForEach-Object { [pscustomobject]@{ ProcessId = 0; CreationDate = [datetime]::MaxValue } }",
      "  CimCmdlets\\Get-CimInstance -ClassName $Class -Property $Property",
      "}",
    ].join("\n");
    for (const [reference, injection] of [["cwd", ""], ["image", ""], ["cwd", NEWER_IDLE_ROWS]]) {
      const behind = injection ? " behind 600 newer idle rows" : "";
      it(`refuses cleanup while an uncontained process has its ${reference} under the root${behind}`, async t => {
        const job = fixture(t);
        const executable = reference === "image" ? join(job.localRoot, "example.exe") : process.execPath;
        const cwd = reference === "cwd" ? join(job.localRoot, "tmp") : job.parent;
        if (reference === "cwd") mkdirSync(cwd);
        if (reference === "image") copyFileSync(process.execPath, executable);
        const child = spawn(executable, ["-e", "process.stdin.resume(); console.log('ready')"],
          { cwd, windowsHide: true, stdio: "pipe" });
        const exited = once(child, "exit");
        try {
          const [ready] = await Promise.race([
            once(child.stdout, "data"), exited.then(() => { throw new Error("Reference fixture exited early"); }),
          ]);
          assert.equal(ready.toString().trim(), "ready");
          await assert.rejects(cleanupJobRoot(root, { ...job.options, run: scanLocalRoot(job, injection) }), error => {
            assertReportedRoot(error, root);
            assert.match(error.message, /live processes can still access the job root/);
            const lines = error.message.split("\n");
            assert.ok(lines.some(line => line.startsWith(`process pid=${child.pid} `) && line.includes(` match=${reference} `)),
              error.message);
            const timing = lines.find(line => /^Cleanup process scan inspected \d+ process rows in \d+ ms$/.test(line));
            assert.ok(timing, error.message);
            if (injection) assert.ok(Number(timing.split(" ")[4]) > 600, timing);
            t.diagnostic(timing);
            return true;
          });
          job.assertPreserved();
        } finally {
          child.stdin.end();
          const [code] = await exited;
          assert.equal(code, 0);
        }
      });
    }

    it("sees the query process after the process match limit", async t => {
      const job = fixture(t);
      const matches = [
        "function Get-CimInstance($Class, $Property) {",
        `  1..21 | ForEach-Object { [pscustomobject]@{ ProcessId = 900000 + $_; ExecutablePath = ${powerShellLiteral(join(job.localRoot, "example.exe"))} } }`,
        "  CimCmdlets\\Get-CimInstance -ClassName $Class -Property $Property",
        "}",
      ].join("\n");
      await assert.rejects(cleanupJobRoot(root, { ...job.options, run: scanLocalRoot(job, matches) }), error => {
        assertReportedRoot(error, root);
        assert.match(error.message, /live processes can still access the job root/);
        assert.match(error.message, /^Cleanup process scan exceeded 20 process matches$/m);
        assert.doesNotMatch(error.message, /query process missing/);
        return true;
      });
      job.assertPreserved();
    });

    // A service creates this process, as the logon service creates a sandbox runner: it is in no step's job.
    const CREATE_OUTSIDE_JOB = [
      "$ErrorActionPreference = 'Stop'",
      "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      "$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{",
      "  CommandLine = $env:EXAMPLE_COMMAND; CurrentDirectory = $env:EXAMPLE_CWD; ProcessStartupInformation = $startup }",
      "if ($created.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($created.ReturnValue)\" }",
      "$process = [Diagnostics.Process]::GetProcessById([int]$created.ProcessId)",
      "try {",
      "  $null = $process.Handle",
      "  $parent = (Get-CimInstance Win32_Process -Filter \"ProcessId = $($created.ProcessId)\").ParentProcessId",
      "  [Console]::WriteLine(\"$($created.ProcessId) $((Get-Process -Id $parent).ProcessName)\")",
      "  [Console]::In.ReadToEnd() | Out-Null",
      "} finally { $process.Kill(); if (-not $process.WaitForExit(10000)) { throw 'Created process did not exit' } }",
    ].join("\n");
    for (const reference of ["cwd", "image"]) {
      it(`refuses cleanup while a service-created process has its ${reference} under the root`, async t => {
        const job = fixture(t);
        const image = reference === "image" ? join(job.localRoot, "example.exe") : process.execPath;
        const cwd = reference === "cwd" ? join(job.localRoot, "tmp") : job.parent;
        if (reference === "cwd") mkdirSync(cwd);
        if (reference === "image") copyFileSync(process.execPath, image);
        const creator = spawn(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
          Buffer.from(CREATE_OUTSIDE_JOB, "utf16le").toString("base64")], {
          cwd: job.parent, windowsHide: true, stdio: "pipe",
          env: { ...windowsPowerShellEnv(), EXAMPLE_COMMAND: `"${image}" -e "setInterval(() => {}, 1000)"`, EXAMPLE_CWD: cwd },
        });
        const exited = once(creator, "exit");
        try {
          const [line] = await Promise.race([
            once(creator.stdout, "data"), exited.then(() => { throw new Error("Process creator exited early"); }),
          ]);
          const [id, parent] = line.toString().trim().split(" ");
          const pid = Number(id);
          assert.ok(Number.isInteger(pid) && pid > 0, line.toString());
          assert.equal(parent.toLowerCase(), "wmiprvse");
          await assert.rejects(cleanupJobRoot(root, { ...job.options, run: scanLocalRoot(job) }), error => {
            assertReportedRoot(error, root);
            assert.match(error.message, /live processes can still access the job root/);
            assert.ok(error.message.split("\n").some(entry => entry.startsWith(`process pid=${pid} `)
              && entry.includes(` match=${reference} `)), error.message);
            return true;
          });
          job.assertPreserved();
        } finally {
          creator.stdin.end();
          const [code] = await exited;
          assert.equal(code, 0);
        }
      });
    }

    for (const scenario of ["cwd", "image", "module", "argument", "argument with invalid creation time"]) {
      const invalidCreationTime = scenario === "argument with invalid creation time";
      const reference = invalidCreationTime ? "argument" : scenario;
      it(`refuses rollback for a live ${scenario} reference`, async t => {
        const job = fixture(t);
        let executable = process.execPath;
        let path = join(job.localRoot, "shared");
        let args = ["-e", "process.stdin.resume(); console.log('ready')"];
        if (reference === "cwd") mkdirSync(path);
        if (reference === "argument") args.push("--", path);
        if (reference === "image") {
          path = join(job.localRoot, "example.exe");
          copyFileSync(process.execPath, path);
          executable = path;
        }
        if (reference === "module") {
          path = join(job.localRoot, "example.dll");
          copyFileSync(join(process.env.SystemRoot, "System32", "xinput1_4.dll"), path);
          executable = windowsPowerShellPath();
          const script = [
            "$ErrorActionPreference = 'Stop'",
            "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);' -Name Loader -Namespace Example",
            "if ([Example.Loader]::LoadLibrary($env:EXAMPLE_DLL) -eq [IntPtr]::Zero) { throw 'DLL was not loaded' }",
            "[Console]::WriteLine('ready'); [Console]::In.ReadToEnd() | Out-Null",
          ].join("\n");
          args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
        }
        const child = spawn(executable, args, {
          cwd: reference === "cwd" ? path : job.parent,
          env: { ...windowsPowerShellEnv(), EXAMPLE_DLL: path }, windowsHide: true, stdio: "pipe",
        });
        const exited = once(child, "exit");
        try {
          const [ready] = await Promise.race([
            once(child.stdout, "data"), exited.then(() => { throw new Error("Reference fixture exited early"); }),
          ]);
          assert.equal(ready.toString().trim(), "ready");
          const setupError = new Error("Could not publish job environment");
          const run = invalidCreationTime ? runInjectedQuery("", script => script.replace("    $row = $_", `$&
    if ($row.ProcessId -eq ${child.pid}) {
      $row = $row | Select-Object -Property *
      $row.CreationDate = 'invalid timestamp'
    }`)) : undefined;
          await assert.rejects(isolationAssignments({ platform: "win32", systemRoot }, () => job.localRoot,
            () => {}, fixtureIdentity, assignments => { if (assignments.HOME) throw setupError; }, run), error => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors[0], setupError);
            const refusal = error.errors[1];
            // A loaded module has no process-scan reference; the quarantine removal refuses instead.
            if (reference === "module") return Boolean(assertQuarantineRefusal(t, refusal, job.localRoot, job.parent));
            assertReportedRoot(refusal, job.localRoot);
            assert.ok(refusal.message.split("\n").some(line => line.startsWith(`process pid=${child.pid} `)
              && line.includes(` match=${reference}`)), refusal.message);
            if (invalidCreationTime) {
              assert.ok(refusal.message.split("\n").includes(`Cleanup process match metadata was unavailable for pid=${child.pid}`),
                refusal.message);
            }
            assert.match(refusal.message, /live processes can still access the job root/i);
            return true;
          });
          if (reference !== "module") assert.equal(readFileSync(job.held, "utf8"), "example");
          assert.equal(readFileSync(join(job.parent, "shared"), "utf8"), "preserve");
        } finally {
          child.stdin.end();
          const [code] = await exited;
          assert.equal(code, 0);
        }
      });
    }

    for (const operation of ["cleanup", "rollback"]) {
      it(`refuses ${operation} while an outside process holds a job file open`, async t => {
        const job = fixture(t);
        // Only the environment names the file, so the command line scan cannot identify this holder.
        const holder = spawn(process.execPath, ["-e", [
          "const fs = require('node:fs');",
          "const fd = fs.openSync(process.env.EXAMPLE_FILE, 'r+');",
          "process.stdin.on('end', () => fs.closeSync(fd)).resume();",
          "console.log('ready');",
        ].join(" ")], {
          cwd: job.parent, env: { ...process.env, EXAMPLE_FILE: job.held }, windowsHide: true, stdio: "pipe",
        });
        const exited = once(holder, "exit");
        try {
          const [ready] = await Promise.race([
            once(holder.stdout, "data"), exited.then(() => { throw new Error("Holder exited before opening the file"); }),
          ]);
          assert.equal(ready.toString().trim(), "ready");
          const inspect = runInjectedQuery("", script => script.replace(
            `$root = ${powerShellLiteral(root)}`, `$root = ${powerShellLiteral(job.localRoot)}`,
          ));
          const run = (command, args, options, done) => options.env[QUERY_VARIABLE].includes(`$root = ${powerShellLiteral(root)}`)
            ? inspect(command, args, options, done) : done(new Error("Unexpected post-removal query"));
          const setupError = new Error("Could not publish job environment");
          const diagnostic = mock.fn();
          const failure = operation === "cleanup"
            ? () => cleanupJobRoot(root, { ...job.options, run, diagnostic })
            : async () => isolationAssignments({ platform: "win32", systemRoot }, () => job.localRoot,
              () => {}, fixtureIdentity, assignments => { if (assignments.HOME) throw setupError; }, undefined, diagnostic);
          let left;
          await assert.rejects(failure, error => {
            if (operation === "rollback") {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.errors[0], setupError);
              error = error.errors[1];
            }
            left = assertQuarantineRefusal(t, error, operation === "rollback" ? job.localRoot : root, job.parent);
            return true;
          });
          await nextTurn();
          if (win32.basename(left) === win32.basename(root)) {
            job.assertPreserved();
            // The bounded post-failure diagnostic still names the holder.
            const holders = output({ diagnostic }).split("\n").filter(line => line.startsWith(`holder pid=${holder.pid} `));
            assert.ok(holders.some(line => line.includes(`path=${JSON.stringify(job.held)}`)), output({ diagnostic }));
          }
        } finally {
          holder.stdin.end();
          const [code] = await exited;
          assert.equal(code, 0);
        }
      });
    }
  }
});

function createJobRootFixture(t) {
  const root = mkdtempSync(`${tmpdir()}${sep}.${sep}example-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalRoot = realpathSync.native(root);
  assert.notEqual(root.toLowerCase(), canonicalRoot.toLowerCase());
  return canonicalRoot;
}

function rootSwapFixture(t) {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "example-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "ave-ci-abc123");
  const replacement = join(parent, "alice");
  const original = join(parent, "bob");
  mkdirSync(root);
  mkdirSync(replacement);
  writeFileSync(join(root, "example"), "original");
  writeFileSync(join(replacement, "example"), "sentinel");
  return {
    parent, root,
    swap() {
      renameSync(root, original);
      renameSync(replacement, root);
    },
    assertPreserved() {
      assert.equal(readFileSync(join(original, "example"), "utf8"), "original");
      const contents = readdirSync(parent).map(name => readFileSync(join(parent, name, "example"), "utf8"));
      assert.ok(contents.includes("sentinel"), "the replacement directory's sentinel must survive");
    },
  };
}

describe("Windows cleanup root ownership", () => {
  const root = "C:\\ave-ci-abc123";
  for (const path of ["ave-ci-abc123", "C:\\example\\ave-ci-abc123", "D:\\ave-ci-abc123"]) {
    it(`does not dispatch removal for ${path}`, async () => {
      const remove = mock.fn();
      await assert.rejects(cleanupJobRoot(path, { systemRoot: "C:\\Windows", remove }), /isolated job root/);
      assert.equal(remove.mock.callCount(), 0);
    });
  }

  it("does not dispatch removal when the directory identity has changed", async () => {
    const remove = mock.fn();
    await assert.rejects(cleanupJobRoot(root, {
      systemRoot: "C:\\Windows", identity: "1:2:3", readIdentity: () => "1:4:5", remove,
    }), { message: `Cleanup requires an unchanged isolated job root. Directory identity changed at ${root}` });
    assert.equal(remove.mock.callCount(), 0);
  });

  it("preserves a directory swapped in after the cleanup identity check", async t => {
    const fixture = rootSwapFixture(t);
    const localPath = path => join(fixture.parent, win32.basename(path));
    let reads = 0;
    const identity = fixtureIdentity(fixture.root);
    const failure = await cleanupJobRoot(root, {
      systemRoot: "C:\\Windows", identity,
      readIdentity(path) {
        const current = fixtureIdentity(localPath(path));
        if (path === root && ++reads === 2) fixture.swap();
        return current;
      },
      rename: (from, to) => renameSync(localPath(from), localPath(to)),
      remove: (path, options) => rmSync(localPath(path), options),
      readReceipts: () => provenReceipts(identity), manifest: MANIFEST,
      run: queryResult(),
    }).catch(error => error);
    fixture.assertPreserved();
    assert.match(String(failure), /unchanged isolated job root/);
  });

  it("preserves a directory swapped in after the rollback identity check", async t => {
    const fixture = rootSwapFixture(t);
    const setupError = new Error("DACL readback failed");
    let reads = 0;
    let failure;
    try {
      await isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, () => fixture.root,
        () => { throw setupError; }, path => {
          const identity = fixtureIdentity(path);
          if (++reads === 3) fixture.swap();
          return identity;
        }, undefined, queryResult());
    } catch (error) { failure = error; }
    fixture.assertPreserved();
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors[0], setupError);
    assert.match(String(failure.errors[1]), /unchanged isolated job root/);
  });
});

describe("Windows job root cleanup diagnostics", () => {
  const root = join(tmpdir(), "ave-job-diagnostic");
  it("removes once without diagnostics on first-try success", async () => {
    const seams = cleanupSeams();
    seams.remove = mock.fn();
    await cleanupWindowsJobRoot(root, seams);
    assert.deepEqual(seams.remove.mock.calls.map(call => call.arguments), [[root, { recursive: true, force: true }]]);
    for (const seam of [seams.run, seams.diagnostic]) assert.equal(seam.mock.callCount(), 0);
  });
  it("runs the entire diagnostic with exact time and output bounds and preserves the removal error", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.run = queryResult({ processes: [PROCESS_DETAILS] });
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.equal(seams.run.mock.callCount(), 1);
    assert.equal(seams.remove.mock.callCount(), 1);
    const [command, args, options] = seams.run.mock.calls[0].arguments;
    assert.equal(command, "powershell.exe");
    assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.ok(Buffer.from(args.at(-1), "base64").toString("utf16le").includes(QUERY_VARIABLE));
    const { [QUERY_VARIABLE]: script, ...env } = options.env;
    assert.ok(script.includes(root));
    assert.equal(options.timeout, 5000);
    assert.deepEqual({ ...options, timeout: undefined, env }, {
      encoding: "utf8", windowsHide: true, timeout: undefined, maxBuffer: 64 * 1024, env: windowsPowerShellEnv(),
    });
    assert.match(output(seams), /process pid=4000 unresolved-parent-pid=2000 image=.*holder\.exe.*match=argument.*created="2026-01-02T03:04:05.0000000Z"/);
    assert.doesNotMatch(output(seams), /diagnostic failed/);
  });
  for (const failure of ["child", "malformed JSON", "invalid entries", "incomplete scan", "output"]) {
    it(`preserves the original removal error on ${failure} failure`, async () => {
      const error = blockedRemoval();
      const seams = cleanupSeams(error);
      if (failure === "child") seams.run = mock.fn((_command, _args, _options, done) => done(new Error("SYNTHETIC PRIVATE DETAILS")));
      if (failure === "malformed JSON") seams.run = mock.fn((_command, _args, _options, done) => done(null, "{SYNTHETIC PRIVATE"));
      if (failure === "invalid entries") seams.run = queryResult({ entries: [{ path: "SYNTHETIC PRIVATE" }] });
      if (failure === "incomplete scan") seams.run = queryResult({ failed: true, processes: [PROCESS_DETAILS] });
      if (failure === "output") seams.diagnostic = mock.fn(() => { throw new Error("closed stderr"); });
      await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
      assert.doesNotMatch(output(seams), /SYNTHETIC PRIVATE/);
      if (failure !== "output") assert.equal(output(seams).split("\n").filter(line => line === "Cleanup diagnostic failed or timed out").length, 1);
      if (failure === "incomplete scan") assert.match(output(seams), /process pid=4000 unresolved-parent-pid=2000/);
    });
  }
  it("retains valid evidence on both sides of a malformed process record", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.run = queryResult({
      processScanFailed: true,
      processes: [{ ...PROCESS_DETAILS, reason: "SYNTHETIC PRIVATE" }, PROCESS_DETAILS],
      entries: [{ path: root, attributes: "Directory", owner: null, deny: null, parentDeny: null, created: null, lastWrite: null }],
    });
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.match(output(seams), /candidate path=.*created="not determined" last-write="not determined"/);
    assert.match(output(seams), /Cleanup process scan was incomplete/);
    assert.match(output(seams), /process pid=4000.*match=argument/);
    assert.doesNotMatch(output(seams), /SYNTHETIC PRIVATE/);
  });
  it("bounds a stalled diagnostic child and still throws the original removal error", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: mock.fn(), unref: mock.fn() };
    seams.run = () => child;
    const start = performance.now();
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 6500, `elapsed=${elapsed}`);
    assert.equal(child.kill.mock.callCount(), 1);
    assert.equal(child.unref.mock.callCount(), 1);
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
    assert.match(output(seams), /Cleanup diagnostic failed or timed out/);
  });
  it("rethrows the removal error while the stderr reader is stalled", async (t) => {
    const script = [
      "import { diagnoseCleanupFailure } from './.github/scripts/isolate-job-home.mjs';",
      "const error = Object.assign(new Error('removal'), { path: 'x'.repeat(16 * 1024) });",
      "console.error = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);",
      "const records = Array.from({ length: 20 }, (_, index) => JSON.stringify({",
      "  kind: 'candidate', path: 'example/' + index + '/' + 'x'.repeat(1400), attributes: 'Archive',",
      "  owner: null, deny: null, parentDeny: null, created: null, lastWrite: null,",
      "})).join('\\n');",
      "try {",
      "  await diagnoseCleanupFailure('example', () => { throw error; }, {",
      "    run(_command, _args, _options, done) { done(null, records + '\\n'); },",
      "  });",
      "} catch (caught) { process.stdout.write(caught === error ? 'original' : 'wrong'); }",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      const seen = [];
      child.stdout.on("data", chunk => seen.push(chunk));
      const [code] = await within(exited, 5700, "Cleanup remained blocked while stderr was unread");
      assert.equal(code, 0);
      assert.equal(Buffer.concat(seen).toString(), "original");
      t.diagnostic("original removal error observed with stderr unread");
    } finally {
      child.stderr.destroy();
      child.stdout.destroy();
      await within(exited, 2000, "Cleanup fixture did not exit");
    }
    const reader = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    reader.stdout.on("data", chunk => out.push(chunk));
    reader.stderr.on("data", chunk => err.push(chunk));
    const [code] = await within(once(reader, "close"), 5500, "Cleanup fixture did not exit");
    assert.equal(code, 0);
    const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
    assert.equal(stdout, "original");
    assert.match(stderr, /^Job root cleanup failed:/);
    assert.match(stderr, /candidate path=/);
  });
  for (const processQuery of ["native", "unavailable"]) {
    it(`never discloses target metadata when the root is replaced by a junction (${processQuery} process query)`, async t => {
      const fixture = createJobRootFixture(t);
      const root = `${fixture}${sep}root`;
      const saved = join(fixture, "saved"), target = join(fixture, "target");
      const sentinel = join(target, "SYNTHETIC-OUTSIDE-SENTINEL.txt");
      mkdirSync(root); mkdirSync(target); writeFileSync(sentinel, "preserve");
      const snapshot = () => [target, sentinel].map(path => {
        const facts = lstatSync(path);
        const script = `(Get-Acl -LiteralPath '${path.replaceAll("'", "''")}').Sddl`;
        const acl = process.platform === "win32" ? execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv() }) : null;
        return { mode: facts.mode, size: facts.size, mtime: facts.mtimeMs, acl };
      });
      let swapped = false;
      try {
        if (process.platform === "win32") hardenWindowsJobRoot(root);
        assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
        assert.equal(realpathSync.native(root).toLowerCase(), root.toLowerCase());
        const before = snapshot();
        const error = Object.assign(blockedRemoval(), { path: join(root, "blocked-original.txt") });
        const seams = cleanupSeams(error);
        seams.run = mock.fn((_command, args, options, done) => {
          renameSync(root, saved); symlinkSync(target, root, "junction"); swapped = true;
          if (processQuery === "unavailable" || process.platform !== "win32") return done(new Error("Query unavailable"));
          return runFixtureQuery(windowsPowerShellPath(), args, options, done);
        });
        await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
        assert.equal(swapped, true);
        assert.equal(seams.remove.mock.callCount(), 1);
        assert.equal(seams.run.mock.callCount(), 1);
        const lines = output(seams);
        assert.doesNotMatch(lines, /SYNTHETIC-OUTSIDE|candidate path=/);
        assert.match(lines, /Cleanup diagnostic failed or timed out/);
        assert.ok(lines.includes(`path=${JSON.stringify(error.path)}`), lines);
        assert.deepEqual(readdirSync(target), ["SYNTHETIC-OUTSIDE-SENTINEL.txt"]);
        assert.equal(readFileSync(sentinel, "utf8"), "preserve");
        assert.deepEqual(snapshot(), before);
      } finally {
        if (swapped) unlinkSync(root);
      }
    });
  }
  it("keeps completed file rows when later child output overflows", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    const records = queryRecords({
      entries: [{ path: root, attributes: "Directory", owner: null, deny: null, parentDeny: null, created: null, lastWrite: null }],
    }).split("\n").slice(0, 2);
    const evidence = `${records.join("\n")}\n`;
    seams.run = (_command, _args, options, done) => runFixtureQuery(process.execPath,
      ["-e", "process.stdout.write(process.env.EXAMPLE_EVIDENCE, () => process.stdout.write('SYNTHETIC'.repeat(20000)))"],
      { ...options, env: { ...options.env, EXAMPLE_EVIDENCE: evidence } }, done);
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.doesNotMatch(output(seams), /SYNTHETIC/);
    assert.match(output(seams), /candidate path=/);
    assert.equal(output(seams).split("\n").filter(line => line === "Cleanup diagnostic failed or timed out").length, 1);
  });
  it("reports an empty surviving Windows root and its parent delete deny", { skip: process.platform !== "win32" }, async () => {
    const parent = mkdtempSync(join(tmpdir(), "ave-job-root-deny-"));
    const root = join(parent, "root");
    const savedAcls = new Map();
    try {
      mkdirSync(root);
      const owner = runFixturePowerShell(`(${fixtureAcl(root)}).GetOwner([Security.Principal.SecurityIdentifier]).Value`);
      const sid = applyFixtureDenies([[parent, "DeleteSubdirectoriesAndFiles"], [root, "Delete"]], savedAcls);
      const deniedAcls = runFixturePowerShell(`(${fixtureAcl(parent)}).Sddl; (${fixtureAcl(root)}).Sddl`);
      const diagnostic = mock.fn();
      let removalError;
      const remove = (...args) => {
        try { rmSync(...args); }
        catch (error) { removalError = error; throw error; }
      };
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic, remove }), caught => caught === removalError && caught.code === "EPERM");
      assert.deepEqual(readdirSync(root), []);
      assert.equal(runFixturePowerShell(`(${fixtureAcl(parent)}).Sddl; (${fixtureAcl(root)}).Sddl`), deniedAcls);
      const lines = output({ diagnostic });
      const candidates = lines.split("\n").filter(line => line.startsWith("candidate path="));
      assert.equal(candidates.length, 1, lines);
      assert.ok(candidates[0].startsWith(
        `candidate path=${JSON.stringify(root)} owner=${JSON.stringify(owner)} deny=[{"sid":"${sid}","rights":"Delete"}]` +
        ` parent-deny=[{"sid":"${sid}","rights":"DeleteSubdirectoriesAndFiles"}] attributes="Directory" handle="not determined"`,
      ), lines);
      assert.match(candidates[0], /created="[\d:T.-]+Z" last-write="[\d:T.-]+Z"$/);
      assert.doesNotMatch(lines, /found no surviving entries|Cleanup diagnostic failed or timed out/);
    } finally {
      try { restoreFixtureAcls(savedAcls); }
      finally {
        rmSync(parent, { recursive: true, force: true });
        assert.equal(existsSync(parent), false);
      }
    }
  });
  it("skips a Windows descendant replaced by a junction after the directory entry was read", { skip: process.platform !== "win32" }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-descendant-swap-"));
    const root = join(fixture, "root"), child = join(root, "child"), saved = join(fixture, "saved");
    const target = join(fixture, "target"), staged = join(fixture, "staged");
    const sentinel = join(target, "OUTSIDE-SWAP-SENTINEL.txt");
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    try {
      mkdirSync(child, { recursive: true });
      mkdirSync(target);
      writeFileSync(sentinel, "preserve");
      symlinkSync(target, staged, "junction");
      seams.run = (_command, args, options, done) => {
        const script = options.env[QUERY_VARIABLE];
        const beforeOpen = "    $handle = if ($canList)";
        assert.ok(script.includes(beforeOpen));
        const swap = [
          `    if ($next.path -eq ${powerShellLiteral(child)}) {`,
          `      [IO.Directory]::Move(${powerShellLiteral(child)}, ${powerShellLiteral(saved)})`,
          `      [IO.Directory]::Move(${powerShellLiteral(staged)}, ${powerShellLiteral(child)})`,
          "    }",
        ].join("\n");
        const env = { ...options.env, [QUERY_VARIABLE]: script.replace(beforeOpen, `${swap}\n${beforeOpen}`) };
        return runFixtureQuery(windowsPowerShellPath(),
          args, { ...options, env }, done);
      };
      await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
      assert.ok(lstatSync(saved).isDirectory());
      assert.ok(lstatSync(child).isSymbolicLink());
      const lines = output(seams);
      assert.doesNotMatch(lines, /OUTSIDE-SWAP-SENTINEL/);
      assert.match(lines, /Cleanup path scan skipped an entry whose directory or reparse attributes changed/);
      assert.match(lines, /Cleanup diagnostic failed or timed out/);
      assert.equal(readFileSync(sentinel, "utf8"), "preserve");
    } finally {
      for (const path of [child, staged]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("reports surviving Windows paths with delete denies, read-only attributes and junctions", { skip: process.platform !== "win32" }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-survivors-"));
    const root = join(fixture, "root's [job]"), target = join(fixture, "target");
    const blocked = join(root, "blocked"), readOnly = join(root, "read-only [fixture].txt"), junction = join(root, "junction");
    const sentinel = join(target, "OUTSIDE-JUNCTION-TARGET.txt");
    const rules = [
      [root, "DeleteSubdirectoriesAndFiles"],
      [blocked, "Delete"],
      [readOnly, "Delete, WriteAttributes"],
      [junction, "Delete"],
    ];
    const savedAcls = new Map();
    try {
      mkdirSync(blocked, { recursive: true });
      mkdirSync(target);
      writeFileSync(sentinel, "preserve");
      writeFileSync(readOnly, "fixture");
      symlinkSync(target, junction, "junction");
      const owner = runFixturePowerShell(`(${fixtureAcl(blocked)}).GetOwner([Security.Principal.SecurityIdentifier]).Value`);
      runFixturePowerShell(`[IO.File]::SetAttributes(${powerShellLiteral(readOnly)}, 'ReadOnly, Hidden, System')`);
      const sid = applyFixtureDenies(rules, savedAcls);

      const diagnostic = mock.fn();
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic }), error => ["EPERM", "EBUSY", "EACCES"].includes(error.code));
      const lines = output({ diagnostic });
      assert.ok(lines.split("\n").find(line => line.startsWith("candidate path="))?.startsWith(`candidate path=${JSON.stringify(root)} `), lines);
      const candidate = path => {
        const line = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(path)} `));
        assert.ok(line, lines);
        assert.ok(line.includes(`owner=${JSON.stringify(owner)}`), line);
        assert.match(line, /handle="not determined"/);
        return line;
      };
      const blockedLine = candidate(blocked);
      assert.ok(blockedLine.includes(`deny=[{"sid":"${sid}","rights":"Delete"}]`), blockedLine);
      assert.ok(blockedLine.includes(`parent-deny=[{"sid":"${sid}","rights":"DeleteSubdirectoriesAndFiles"}]`), blockedLine);
      assert.match(candidate(readOnly), /attributes="[^"]*ReadOnly[^"]*Hidden[^"]*System/);
      const junctionLine = candidate(junction);
      assert.match(junctionLine, /attributes="[^"]*ReparsePoint/);
      assert.ok(junctionLine.includes(`deny=[{"sid":"${sid}","rights":"Delete"}]`), junctionLine);
      assert.doesNotMatch(lines, /OUTSIDE-JUNCTION-TARGET|Cleanup diagnostic failed or timed out/);
      assert.equal(readFileSync(sentinel, "utf8"), "preserve");
    } finally {
      try { restoreFixtureAcls(savedAcls); }
      finally {
        if (existsSync(readOnly)) runFixturePowerShell(`[IO.File]::SetAttributes(${powerShellLiteral(readOnly)}, 'Normal')`);
        if (existsSync(junction)) unlinkSync(junction);
        rmSync(fixture, { recursive: true, force: true });
        assert.equal(existsSync(fixture), false);
      }
    }
  });
  it("reports an outside-root holder that opens a candidate through TEMP", { skip: process.platform !== "win32" }, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-held-"));
    const root = join(fixture, "root");
    let holder;
    let exited;
    try {
      mkdirSync(root);
      hardenWindowsJobRoot(root);
      const image = join(fixture, "holder.exe");
      const file = join(root, "held.log");
      const idleFile = join(root, "idle.log");
      writeFileSync(file, "held fixture");
      writeFileSync(idleFile, "idle fixture");
      const lastWrite = new Date("2026-01-02T03:04:05Z");
      utimesSync(file, lastWrite, lastWrite);
      const { birthtimeMs } = statSync(file);
      const source = 'using System; using System.IO; public class Holder { public static void Main() { using (new FileStream(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "held.log"), FileMode.Open, FileAccess.Read, FileShare.Read)) { Console.WriteLine("ready"); Console.ReadLine(); } } }';
      const script = `Add-Type -TypeDefinition '${source}' -OutputAssembly '${image.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
      execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: "pipe", env: windowsPowerShellEnv() });
      holder = spawn(image, [], { cwd: fixture, env: { ...process.env, TEMP: root }, windowsHide: true, stdio: "pipe" });
      exited = once(holder, "exit");
      const [ready] = await within(Promise.race([
        once(holder.stdout, "data"), exited.then(() => { throw new Error("Holder exited before opening the file"); }),
      ]), 5000, "Holder did not open the file");
      assert.equal(ready.toString().trim(), "ready");
      const diagnostic = mock.fn();
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic }), error => error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES");
      const lines = output({ diagnostic });
      const candidate = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(file)}`));
      assert.ok(candidate, lines);
      assert.equal(Date.parse(candidate.match(/created="([^"]+)"/)?.[1]), Math.trunc(birthtimeMs));
      assert.equal(Date.parse(candidate.match(/last-write="([^"]+)"/)?.[1]), +lastWrite);
      const holderLines = lines.split("\n").filter(line => line.startsWith(`holder pid=${holder.pid} `));
      assert.equal(holderLines.length, 1, lines);
      const [holderLine] = holderLines;
      for (const detail of [`unresolved-parent-pid=${process.pid}`, `image=${JSON.stringify(image)}`, `path=${JSON.stringify(file)}`]) {
        assert.ok(holderLine.includes(detail), holderLine);
      }
      assert.match(holderLine, /app="holder\.exe".*created="[\d:T.-]+Z"/i);
      assert.ok(lines.indexOf(candidate) < lines.indexOf(holderLine), lines);
      t.diagnostic(holderLine);
      holder.stdin.end();
      const [code] = await within(exited, 2000, "Holder did not exit after EOF");
      assert.equal(code, 0);
      await cleanupWindowsJobRoot(root);
      assert.equal(existsSync(root), false);
    } finally {
      if (holder && holder.exitCode === null) {
        holder.stdin.end();
        await within(exited, 2000, "Holder did not exit after EOF");
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  for (const stage of ["before pinning", "when pinning is unavailable", "during the query"]) {
    it(`guards against a leaf replacement ${stage}`, { skip: process.platform !== "win32" }, async () => {
      const fixture = mkdtempSync(join(tmpdir(), "ave-job-holder-swap-"));
      const root = join(fixture, "root");
      const file = join(root, "example.log");
      try {
        mkdirSync(root);
        writeFileSync(file, "original");
        const probe = join(fixture, "probe.txt");
        if (stage === "during the query") writeFileSync(join(root, "bob.log"), "other candidate");
        const run = runInjectedQuery("", script => {
          if (stage === "during the query") {
            const marker = "    $rows = @(ReadFileHolders $pin $file.path)";
            assert.ok(script.includes(marker));
            return script.replace(marker, [
              `    if ($file.path -eq ${powerShellLiteral(file)}) {`,
              `      [IO.File]::WriteAllText(${powerShellLiteral(probe)}, 'query entered')`,
              `      try { [IO.File]::Move(${powerShellLiteral(file)}, ${powerShellLiteral(join(fixture, "saved.log"))}) }`,
              "      catch [IO.IOException] {}",
              "    }",
              marker,
            ].join("\n"));
          }
          const marker = "  $pin = OpenRelative $file.parent $file.name ($readData -bor $readAttributes) $shareWithoutDelete";
          assert.ok(script.includes(marker));
          const swap = [
            `    [IO.File]::Move(${powerShellLiteral(file)}, ${powerShellLiteral(join(fixture, "saved.log"))})`,
            `    [IO.File]::WriteAllText(${powerShellLiteral(file)}, 'replacement')`,
            "",
          ].join("\n");
          // Simulate a candidate whose metadata can be opened but whose data access cannot be pinned.
          return script.replace(marker, swap + (stage === "when pinning is unavailable" ? "  $pin = $null" : marker));
        });
        const diagnostic = mock.fn();
        await diagnoseJobRoot(root, diagnostic, run);
        if (stage === "during the query") {
          assert.equal(readFileSync(probe, "utf8"), "query entered");
          assert.equal(existsSync(join(fixture, "saved.log")), false);
          assert.equal(readFileSync(file, "utf8"), "original");
        } else {
          assert.equal(readFileSync(file, "utf8"), "replacement");
          assert.match(output({ diagnostic }), /Native file holder lookup failed .*operation=unverified-path/);
        }
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  }
  it("matches current directories and command arguments independently of the image path", { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-process-"));
    const fixtureCommand = "console.log('ready'); process.stdin.resume();";
    const children = [];
    async function start(cwd, ...args) {
      const child = spawn(process.execPath, ["-e", fixtureCommand, "--", ...args], { cwd, windowsHide: true, stdio: "pipe" });
      const exited = once(child, "exit");
      children.push({ child, exited });
      await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("Process fixture exited early"); })]);
      return child.pid;
    }
    try {
      const fromCwd = await start(root);
      const argument = join(root, "SYNTHETIC-PRIVATE");
      const viaSibling = `${win32.dirname(root)}\\example\\..\\${win32.basename(root)}\\SYNTHETIC-PRIVATE`;
      const fromArgs = [];
      for (const operand of [`--token=${argument}`, `/out:${argument}`, `-o${argument}`, viaSibling, viaSibling.replace("example", "example dir")]) {
        fromArgs.push([operand, await start(tmpdir(), operand)]);
      }
      const nearMiss = await start(tmpdir(), `${root}-other\\outside.txt`, `${root}\\..\\outside.txt`, `/out:${root}-other`);
      const diagnostic = mock.fn();
      await diagnoseJobRoot(root, diagnostic);
      const lines = output({ diagnostic }).split("\n");
      const lineFor = pid => lines.find(line => line.startsWith(`process pid=${pid} `));
      assert.doesNotMatch(lines.join("\n"), /SYNTHETIC-PRIVATE|--token/);
      assert.ok(lineFor(fromCwd)?.includes("match=cwd"), lines.join("\n"));
      for (const [operand, pid] of fromArgs) assert.ok(lineFor(pid)?.includes("match=argument"), `${operand}\n${lines.join("\n")}`);
      assert.equal(lineFor(nearMiss), undefined, lines.join("\n"));
      assert.doesNotMatch(lines.join("\n"), /SYNTHETIC|--token|Cleanup process scan was incomplete/);
    } finally {
      for (const { child } of children) child.stdin.end();
      await Promise.all(children.map(({ exited }) => exited));
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const [mode, action] of [["failed", "throw 'SYNTHETIC-PRIVATE'"], ["stalled", "Start-Sleep -Seconds 30"]]) {
    it(`keeps real file timestamps when the process scan ${mode}`, { skip: process.platform !== "win32" }, async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-job-process-incomplete-"));
      try {
        const file = join(root, "example.txt");
        const lastWrite = new Date("2026-01-02T03:04:05Z");
        writeFileSync(file, "fixture");
        utimesSync(file, lastWrite, lastWrite);
        const { birthtimeMs } = statSync(file);
        const error = blockedRemoval();
        const seams = cleanupSeams(error);
        seams.run = runInjectedQuery(`function Get-CimInstance($Class, $Property, $Filter) { ${action} }`);
        await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
        const lines = output(seams);
        const candidate = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(file)} `));
        assert.ok(candidate, lines);
        assert.equal(Date.parse(candidate.match(/created="([^"]+)"/)?.[1]), Math.trunc(birthtimeMs));
        assert.equal(Date.parse(candidate.match(/last-write="([^"]+)"/)?.[1]), +lastWrite);
        assert.match(lines, /Cleanup process scan was incomplete|Cleanup diagnostic failed or timed out/);
        assert.doesNotMatch(lines, /SYNTHETIC-PRIVATE/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});


describe("Windows job root query", () => {
  const libraryName = "rstrt" + "mgr";
  const registryBackedHolderQuery = new RegExp(`${libraryName}|${/\bRm[A-Z]\w*/.source}`);

  it("detects registry-backed holder identifiers without embedding the library name", () => {
    assert.match(`${libraryName}.dll`, registryBackedHolderQuery);
    assert.match("Rm" + "StartSession", registryBackedHolderQuery);
    const source = readFileSync(new URL(import.meta.url), "utf8");
    assert.ok(!source.toLowerCase().includes(libraryName));
  });

  it("keeps registry-backed holder APIs out of the diagnostic module", () => {
    const source = readFileSync(new URL("../../.github/scripts/job-root-diagnostic.mjs", import.meta.url), "utf8");
    assert.equal(source.match(registryBackedHolderQuery)?.[0], undefined);
  });

  it("generates a registry-free holder query", async () => {
    const run = queryResult();
    await diagnoseJobRoot("C:\\fixture", () => {}, run);
    assert.equal(run.mock.callCount(), 1);
    const script = run.mock.calls[0].arguments[2].env[QUERY_VARIABLE];
    assert.equal(script.match(registryBackedHolderQuery)?.[0], undefined);
    assert.match(script, /NtQueryInformationFile\(\$handle, \$ioStatus, \$info, \$info.Length, 47\)/);
  });

  it("caps process and path counts and projects only requested fields", async () => {
    const diagnostic = mock.fn();
    const run = queryResult({
      processes: Array.from({ length: 25 }, (_, i) => ({
        ...PROCESS_DETAILS, pid: 4000 + i, CommandLine: "SYNTHETIC", env: { secret: "SYNTHETIC" },
      })),
      entries: Array.from({ length: 25 }, (_, i) => ({
        path: `C:\\fixture\\entry-${i}`, attributes: "ReadOnly, Hidden", owner: CURRENT_SID,
        created: "2026-01-02T03:04:05.0000000Z", lastWrite: "2026-01-02T03:04:06.0000000Z",
        deny: [{ sid: CURRENT_SID, rights: "Delete", note: "SYNTHETIC" }], denyOmitted: 2,
        parentDeny: [], parentDenyOmitted: 0, data: "SYNTHETIC",
      })),
      limited: true, processLimited: true,
    });
    await diagnoseJobRoot("C:\\fixture's", diagnostic, run);
    assert.equal(diagnostic.mock.callCount(), 42);
    assert.match(output({ diagnostic }), /process pid=4000 unresolved-parent-pid=2000 image=.*holder\.exe/);
    assert.match(output({ diagnostic }), /candidate path=.*entry-19.*Delete.*\(\+2 more\).*parent-deny=\[\].*ReadOnly, Hidden.*handle="not determined"/);
    assert.match(output({ diagnostic }), /Cleanup path scan reached its inspection or reporting limit/);
    assert.match(output({ diagnostic }), /Cleanup process scan reached its inspection or reporting limit/);
    assert.doesNotMatch(output({ diagnostic }), /SYNTHETIC|secret|CommandLine|env|entry-20|pid=4020/);
    const [, , options] = run.mock.calls[0].arguments;
    const script = options.env[QUERY_VARIABLE];
    assert.ok(script.includes("$root = 'C:\\fixture''s'"));
    assert.match(script, /Get-CimInstance Win32_Process/);
    assert.match(script, /NtQueryDirectoryFile\(\$handle,/);
    assert.match(script, /NtQuerySecurityObject\(\$handle,/);
    assert.doesNotMatch(script, /Get-ChildItem|Set-Acl|SetAttributes|icacls|takeown|Stop-Process|Remove-Item|-Recurse|Environment/i);
  });
  it("reserves byte budget for native file holder output after long Unicode file rows", async () => {
    const diagnostic = mock.fn();
    const run = queryResult({
      entries: Array.from({ length: 20 }, (_, i) => ({
        path: `C:\\fixture\\${i}\\${"例".repeat(800)}`, attributes: "Archive", owner: null,
        deny: null, parentDeny: null, created: "2026-01-02T03:04:05.0000000Z", lastWrite: "2026-01-02T03:04:06.0000000Z",
      })),
      holders: [
        { kind: "handleQuery", path: "C:\\fixture\\example.log", status: -1073741820 },
        { ...PROCESS_DETAILS, kind: "holder", app: "holder.exe", service: "", path: "C:\\fixture\\example.txt" },
      ],
    });
    await diagnoseJobRoot("C:\\fixture", diagnostic, run);
    const lines = output({ diagnostic });
    assert.ok(Buffer.byteLength(lines) + 1 <= 64 * 1024);
    assert.match(lines, /candidate path=.*created="2026-01-02T03:04:05.0000000Z" last-write="2026-01-02T03:04:06.0000000Z"/);
    assert.match(lines, /Native file holder lookup failed .*status=-1073741820/);
    assert.match(lines, /holder pid=4000.*app="holder\.exe"/);
    assert.match(lines, /Cleanup diagnostic output reached its byte limit/);
  });
});
const CURRENT_SID = "S-1-5-21-100-200-300-1001";
const PRINCIPALS = [CURRENT_SID, "S-1-5-18", "S-1-5-32-544"];
function privateDacl() {
  return { protected: true, rules: PRINCIPALS.map(sid => ({
    sid, rights: 0x1f01ff, type: 0, inherited: false, inheritance: 3, propagation: 0,
  })) };
}
function commandRunner(acl = privateDacl(), sid = CURRENT_SID) {
  return mock.fn((command) => command === "whoami.exe"
    ? `"example\\runner","${sid}"\n` : command === "powershell.exe" ? JSON.stringify(acl) : "");
}
describe("Windows job root hardening", () => {
  it("rebuilds the child module path without changing other environment entries", async () => {
    const originalEnv = process.env;
    const expectedEnv = { ...originalEnv, AVE_JOB_ENV_SENTINEL: "preserved", AVE_JOB_ENV_EMPTY: "" };
    for (const key of Object.keys(expectedEnv)) if (/^psmodulepath$/i.test(key)) delete expectedEnv[key];
    const injectedEnv = {
      ...expectedEnv,
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      psmodulepath: "C:\\Program Files\\PowerShell\\7\\Modules",
      PsMoDuLePaTh: "C:\\Program Files\\PowerShell\\7\\Modules",
    };
    process.env = injectedEnv;
    try {
      const harden = commandRunner(), query = queryResult();
      hardenWindowsJobRoot("C:\\ave-ci-abc123", harden);
      await diagnoseJobRoot("C:\\ave-ci-abc123", mock.fn(), query);
      for (const run of [harden, query]) {
        const calls = run.mock.calls.filter(call => call.arguments[0] === "powershell.exe");
        assert.equal(calls.length, 1);
        for (const { arguments: [, , options] } of calls) {
          assert.ok(options.env);
          const { [QUERY_VARIABLE]: script, ...env } = options.env;
          assert.equal(typeof script, run === query ? "string" : "undefined");
          assert.deepEqual(env, expectedEnv);
          assert.equal(Object.keys(options.env).some(key => /^psmodulepath$/i.test(key)), false);
        }
      }
      assert.equal(process.env, injectedEnv);
      assert.equal(process.env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
    } finally { process.env = originalEnv; }
  });

  it("removes existing grants and inheritance, then grants only SID-based full control", () => {
    const run = commandRunner();
    hardenWindowsJobRoot("C:\\ave-ci-abc123", run);
    assert.deepEqual(run.mock.calls.map(({ arguments: [command, args] }) => [command, args]).slice(0, 3), [
      ["whoami.exe", ["/user", "/fo", "csv", "/nh"]],
      ["icacls.exe", ["C:\\ave-ci-abc123", "/reset"]],
      ["icacls.exe", ["C:\\ave-ci-abc123", "/inheritance:r", "/grant:r",
        ...PRINCIPALS.map(sid => `*${sid}:(OI)(CI)F`)]],
    ]);
    assert.equal(run.mock.calls[3].arguments[0], "powershell.exe");
    const options = { encoding: "utf8", windowsHide: true, stdio: "pipe", timeout: 10_000 };
    for (const call of run.mock.calls.slice(0, 3)) assert.deepEqual(call.arguments[2], options);
    assert.deepEqual(run.mock.calls[3].arguments[2], { ...options, env: windowsPowerShellEnv() });
  });
  for (const [name, alter] of [
    ["a foreign ACE", acl => acl.rules.push({ ...acl.rules[0], sid: "S-1-5-11" })],
    ["an unprotected DACL", acl => { acl.protected = false; }],
    ["a missing principal", acl => acl.rules.pop()],
    ["a duplicate principal", acl => { acl.rules[2].sid = CURRENT_SID; }],
    ["a deny rule", acl => { acl.rules[0].type = 1; }],
    ["inherited access", acl => { acl.rules[0].inherited = true; }],
    ["partial control", acl => { acl.rules[0].rights = 0x1301bf; }],
    ["missing child inheritance", acl => { acl.rules[0].inheritance = 0; }],
    ["inherit-only access", acl => { acl.rules[0].propagation = 2; }],
  ]) {
    it(`refuses readback with ${name}`, () => {
      const acl = privateDacl();
      alter(acl);
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", commandRunner(acl)), /protected DACL/);
    });
  }
  for (const sid of ["S-1-5-11", "S-1-5-21-bad", "S-1-5-21-100-200-300-1001 /grant", "S-1-5-21-1--2"]) {
    it(`refuses an invalid account SID before changing permissions: ${sid}`, () => {
      const run = commandRunner(privateDacl(), sid);
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", run), /valid current account SID/);
      assert.equal(run.mock.callCount(), 1);
    });
  }
  it("hardens the new root while it is empty before returning child paths", async t => {
    const root = createJobRootFixture(t);
    const harden = mock.fn(path => {
      assert.equal(path, root);
      assert.deepEqual(readdirSync(root), []);
    });
    await isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, () => root, harden);
    assert.equal(harden.mock.callCount(), 1);
  });
  it("removes the half-made root when hardening fails", async t => {
    const root = createJobRootFixture(t);
    await assert.rejects(() => isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, () => root,
      () => { throw new Error("DACL readback failed"); }, undefined, undefined,
      process.platform !== "win32" ? queryResult() : undefined), /DACL readback failed/);
    assert.equal(existsSync(root), false);
  });
  for (const stage of ["child directory creation", "environment publication"]) {
    it(`rolls back the new root on ${stage} failure`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-job-publish-"));
      const error = new Error(`Could not finish ${stage}`);
      const publish = mock.fn(assignments => {
        if (assignments.HOME === undefined) return;
        mkdirSync(join(root, "home"));
        throw error;
      });
      try {
        await assert.rejects(() => isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" },
          () => root, mock.fn(), () => "1:2:3", publish,
          process.platform !== "win32" ? queryResult() : undefined), caught => caught === error);
        assert.equal(publish.mock.callCount(), 2);
        assert.equal(existsSync(root), false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("propagates command failures and malformed readback", () => {
    for (const run of [() => { throw new Error("command failed"); }, () => "invalid JSON"]) {
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", run));
    }
    const run = commandRunner();
    assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", (command, ...args) =>
      command === "powershell.exe" ? "invalid JSON" : run(command, ...args)), SyntaxError);
  });
  it("protects a real root and limits directory and file inheritance to three principals", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-acl-"));
    const readAcl = path => {
      const script = `$acl = Get-Acl -LiteralPath '${path.replaceAll("'", "''")}'; @{ protected = $acl.AreAccessRulesProtected; sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); inherited = @($acl.Access | ForEach-Object { $_.IsInherited }) } | ConvertTo-Json -Compress`;
      return JSON.parse(execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv() }));
    };
    try {
      execFileSync(join(process.env.SystemRoot, "System32", "icacls.exe"), [root, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "pipe", windowsHide: true });
      assert.ok(readAcl(root).sids.includes("S-1-5-11"));
      hardenWindowsJobRoot(root);
      const acl = readAcl(root);
      assert.equal(acl.protected, true);
      assert.equal(acl.sids.length, 3);
      assert.ok(acl.sids.includes("S-1-5-18") && acl.sids.includes("S-1-5-32-544"));
      const directory = join(root, "child");
      const file = join(directory, "file.txt");
      mkdirSync(directory);
      writeFileSync(file, "fixture");
      for (const path of [directory, file]) {
        const child = readAcl(path);
        assert.deepEqual(child.sids.sort(), acl.sids.sort());
        assert.ok(child.inherited.every(value => value === true));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
