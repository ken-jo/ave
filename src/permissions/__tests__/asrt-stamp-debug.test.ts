import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampWindowsAcl, stampWindowsAclAsync } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const TARGET = String.raw`C:\profile\private "notes"\item.txt`;
const PARENT = String.raw`C:\profile\private "notes"`;
const NATIVE_TIMINGS = [
  { path: TARGET, parent: PARENT, kind: "denyRead", elapsedMs: 41.25 },
  { path: PARENT, parent: String.raw`C:\profile`, kind: "fdc", elapsedMs: 7.5 },
];

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stampFixture(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "stamp-debug-"));
  roots.push(root);
  const script = join(root, "stamp.mjs");
  const events = join(root, "events.jsonl");
  const request = join(root, "request.json");
  writeFileSync(script, [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(events)}, JSON.stringify({ event: "native" }) + "\\n");`,
    `writeFileSync(${JSON.stringify(request)}, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(readFileSync(0, "utf8")) }));`,
    `if (process.env.SRT_DEBUG) for (const row of ${JSON.stringify(NATIVE_TIMINGS)}) process.stderr.write(JSON.stringify(row) + "\\n");`,
    `process.exitCode = ${exitCode};`,
  ].join("\n"));
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation(message => {
    logs.push(String(message));
    appendFileSync(events, `${JSON.stringify({ event: "log", message })}\n`);
  });
  return {
    logs,
    events,
    request,
    options: {
      sandboxUserSid: "S-1-5-21-1001",
      holderPid: process.pid,
      srtWin: { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [script] },
      denyRead: [TARGET],
      denyWrite: [String.raw`C:\profile\other`],
    },
  };
}

describe.each([
  ["sync", stampWindowsAcl],
  ["async", stampWindowsAclAsync],
] as const)("stamp debug %s", (_mode, stamp) => {
  it("logs planned paths before invocation and keeps native target and parent durations separate", async () => {
    vi.stubEnv("SRT_DEBUG", "1");
    const fixture = stampFixture();
    // Wall-clock adjustment must not affect the monotonic bulk measurement.
    vi.spyOn(Date, "now").mockReturnValue(-1);
    vi.spyOn(performance, "now").mockReturnValueOnce(200).mockReturnValueOnce(237.5);
    await stamp(fixture.options);

    expect(fixture.logs).toHaveLength(2);
    const planned = JSON.parse(fixture.logs[0].split("targets=")[1]);
    expect(planned).toEqual([
      { path: TARGET, parent: PARENT, kind: "denyRead" },
      { path: String.raw`C:\profile\other`, parent: String.raw`C:\profile`, kind: "denyWrite" },
    ]);
    const completion = fixture.logs[1];
    const bulkMs = Number(completion.match(/exit=0 elapsedMs=([\d.]+):/)?.[1]);
    expect(bulkMs).toBe(37.5);
    expect(bulkMs).toBeGreaterThanOrEqual(0);
    const nativeRows = completion.slice(completion.indexOf(": ") + 2).split("\n")
      .filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    expect(nativeRows).toEqual(NATIVE_TIMINGS);
    expect(nativeRows[0].elapsedMs).not.toBe(nativeRows[1].elapsedMs);
    expect(nativeRows.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
    expect(readFileSync(fixture.events, "utf8").trim().split("\n").map(line => JSON.parse(line).event))
      .toEqual(["log", "native", "log"]);
    expect(JSON.parse(readFileSync(fixture.request, "utf8"))).toEqual({
      args: ["acl", "stamp", "--holder-pid", String(process.pid), "--sandbox-user-sid", fixture.options.sandboxUserSid],
      input: { denyRead: fixture.options.denyRead, denyWrite: fixture.options.denyWrite },
    });
  });

  it.each([undefined, ""])("withholds logs when debug is %s", async value => {
    vi.stubEnv("SRT_DEBUG", value);
    const fixture = stampFixture();
    await stamp(fixture.options);
    expect(fixture.logs).toEqual([]);
    expect(readFileSync(fixture.events, "utf8").trim()).toBe('{"event":"native"}');
  });

  it("preserves failure status and logs measured work before throwing", async () => {
    vi.stubEnv("SRT_DEBUG", "1");
    const fixture = stampFixture(2);
    await expect(Promise.resolve().then(() => stamp(fixture.options))).rejects.toThrow("acl stamp exited 2");
    expect(fixture.logs[1]).toMatch(/exit=2 elapsedMs=[\d.]+:/);
    expect(fixture.logs[1]).toContain(JSON.stringify(NATIVE_TIMINGS[1]));
  });
});
