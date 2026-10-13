/**
 * Admission's adversarial fixture under the validate CLI, the authoring
 * harness (`docs/design/plugin-hostapi-protocol.md` §9.8 A2, decision 53).
 *
 * The validator never confines (decision 30), so nothing here is a claim about
 * the filesystem or the network: those probes are REPORTED, and the real-wrap
 * suite (`adversarial-escapes.test.ts`) is where they are asserted. What the
 * CLI does claim, and what this file holds it to:
 *
 *  - the fixture is a well-formed protocol-3 plugin: every standard row passes,
 *    and its declared grant is `not exercised`, never passed;
 *  - Electron's main-process API is unusable in every form — no harness runs a
 *    plugin as the main process — asserted by SHAPE, with how each form
 *    resolved recorded for the executable and location it ran from;
 *  - the host-call probes are live: the transcript carries the foreign-key
 *    `getSecret`, the forged one with its identity fields, and the undeclared
 *    `hostFetch` URL, each answered by the validation host;
 *  - a line on stdout that is not JSON fails the run (decision 40).
 *
 * The child is the reference runtime from source, exactly as
 * `bun run plugin:validate <fixture> --tool-args <fixture>/tool-args.json`
 * runs it — the command an author runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flattenAgentPluginsManifest } from "../../public-contract.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import {
  runProtocolChecks,
  validatePluginDirectory,
  type ToolArguments,
  type ValidateOptions,
} from "../validate-plugin.js";
import { reportExitCode } from "../report.js";
import { row } from "./report-row.js";
import type { PluginManifest } from "../../types.js";

const FIXTURE = fileURLToPath(new URL("../../isolation/__tests__/fixtures/adversarial/", import.meta.url));
const CHILD_MAIN = fileURLToPath(new URL("../../isolation/plugin-child-main.ts", import.meta.url));
const LOGGER_HOOK = fileURLToPath(new URL("../../../../scripts/lib/stub-app-logger-hook.mjs", import.meta.url));
const TOOL_ARGS = JSON.parse(readFileSync(join(FIXTURE, "tool-args.json"), "utf-8")) as ToolArguments;

/** The reference runtime from source, as `plugin:validate` runs it. */
const SOURCE_MODE: ValidateOptions = {
  childEntry: CHILD_MAIN,
  childExecArgs: ["--import", "tsx", "--import", pathToFileURL(LOGGER_HOOK).href],
  fast: false,
  toolArgs: TOOL_ARGS,
};

/** The rows a well-formed `entry` plugin with no lifecycle hooks and no sources passes. */
const STANDARD_ROWS = [
  "manifest.schema",
  "manifest.host-protocol",
  "manifest.min-app-version",
  "manifest.entry",
  "protocol.construct",
  "construct.requires",
  "discover.capabilities",
  "tools.list",
  "tools.call:escape_secrets",
  "tools.call:escape_worker",
  "tools.call:escape_network",
  "tools.call:escape_electron",
  "tools.call:escape_patch",
  "protocol.unknown-method",
  "protocol.stdin-close",
  "protocol.stdout-discipline",
  "protocol.request-meta",
  "protocol.teardown",
] as const;

interface Frame {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: { readonly _meta?: Record<string, unknown> } & Record<string, unknown>;
}

/** The child's stdout, one frame per line, in the order it wrote them. */
function childFrames(stdout: readonly Buffer[]): Frame[] {
  return Buffer.concat(stdout)
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "adversarial-validate-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the adversarial fixture under the validate CLI", () => {
  it("is a well-formed protocol-3 plugin: every standard row passes and its grant is not exercised", async () => {
    const rows = await validatePluginDirectory(FIXTURE, SOURCE_MODE);
    for (const check of STANDARD_ROWS) {
      expect(row(rows, check), check).toMatchObject({ ok: true });
    }
    // The declared `userChosenDirectory` grant is never applied by the
    // validator, and the report says so rather than passing it.
    expect(row(rows, "sandbox.grants")).toMatchObject({ ok: null });
    expect(row(rows, "sandbox.grants").message).toMatch(/^not exercised: .*1 declared grant/);
    expect(rows.filter((candidate) => candidate.ok === false)).toEqual([]);
    expect(reportExitCode(rows)).toBe(0);
  }, 120_000);

  it("records every probe live, and finds no usable main-process API in any form", async () => {
    const manifest = flattenAgentPluginsManifest(
      JSON.parse(readFileSync(join(FIXTURE, "plugin.json"), "utf-8")),
    ) as PluginManifest;
    const entryPath = join(FIXTURE, "entry.mjs");
    const run = await runProtocolChecks(
      {
        command: process.execPath,
        args: [...SOURCE_MODE.childExecArgs, CHILD_MAIN, entryPath],
        env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      },
      manifest,
      {
        pluginRoot: FIXTURE,
        pluginDataDir: scratch,
        pluginLaunch: { kind: "entry", entryPath },
        fast: false,
        toolArgs: TOOL_ARGS,
      },
    );
    expect(run.rows.filter((candidate) => candidate.ok === false)).toEqual([]);
    const frames = childFrames(run.record.stdout);

    // ── the host-call probes, as the validation host received them ─────────
    const hostRequests = frames.filter((frame) => typeof frame.method === "string" && frame.method.startsWith("ave/host/"));
    const secretKeys = hostRequests
      .filter((frame) => frame.method === "ave/host/getSecret")
      .map((frame) => ({ id: frame.id, key: frame.params?.key }));
    // escape_secrets asks for the neighbour's key and its own; escape_patch
    // forges the neighbour's with a string id the runtime never allocates.
    expect(secretKeys).toEqual([
      { id: expect.any(Number), key: "plugin.neighbour.key" },
      { id: expect.any(Number), key: "plugin.adversarial.key" },
      { id: "adversarial-forged-getSecret", key: "plugin.neighbour.key" },
    ]);
    const forged = hostRequests.find((frame) => frame.id === "adversarial-forged-getSecret")!;
    // The identity fields travel as the plugin wrote them; the session is
    // bound to the connection, so they decide nothing (the wrap suite shows it).
    expect(forged.params).toMatchObject({ pluginId: "neighbour", _meta: { pluginId: "neighbour" } });
    const fetches = hostRequests.filter((frame) => frame.method === "ave/host/hostFetch");
    expect(fetches).toHaveLength(1);
    expect(JSON.stringify(fetches[0]!.params)).toContain("https://not-allowed.invalid/escape");

    // ── each tool's own report ───────────────────────────────────────────────
    const results = new Map<string, Record<string, unknown>>();
    for (const frame of frames) {
      const raw = frame.result?._meta?.["ave/rawResult"] as { attempt?: string } | undefined;
      if (raw?.attempt) results.set(raw.attempt, raw as Record<string, unknown>);
    }
    expect([...results.keys()].sort()).toEqual([
      "escape_electron",
      "escape_network",
      "escape_patch",
      "escape_secrets",
      "escape_worker",
    ]);

    // The validation host answers every key with the same stored value
    // (`validation-host.ts`), so the foreign key is answered here — the probe is
    // live, and nothing about the gate is claimed by this harness.
    expect(results.get("escape_secrets")).toMatchObject({
      own: { write: { ok: true }, read: { ok: true, value: "the adversarial plugin's own bytes" } },
      secrets: { foreign: { ok: true, value: "the-stored-secret" }, own: { ok: true, value: "the-stored-secret" } },
    });
    // The worker probe is live too: both workers were asked for and granted a
    // handle. The validation host's scripted workers speak only when the run
    // fires them, after the call, so each probe waited out `waitMs`; the wrap
    // suite is where a worker prints, and is held to the refusal.
    const workerSpawns = hostRequests
      .filter((frame) => frame.method === "ave/host/spawnWorker")
      .map((frame) => JSON.stringify(frame.params));
    expect(workerSpawns).toHaveLength(2);
    expect(workerSpawns[0]).toContain('"workerId":"adversarial-own"');
    expect(workerSpawns[1]).toContain('"workerId":"adversarial-other"');
    expect(results.get("escape_worker")).toMatchObject({
      own: { ok: true, value: { stdout: "", exit: "timeout" } },
      other: { ok: true, value: { stdout: "", exit: "timeout" } },
    });
    expect(results.get("escape_network")).toMatchObject({
      hostFetch: { url: "https://not-allowed.invalid/escape", ok: true, value: 200 },
    });
    expect(results.get("escape_patch")).toMatchObject({
      patched: { fetch: true, stdoutWrite: true },
      forged: { answered: true, result: "the-stored-secret" },
    });

    // Escape 3 under this harness: the child is `process.execPath` with
    // `ELECTRON_RUN_AS_NODE=1`, run from the checkout, so the bare specifier
    // resolves the app's own `electron` package — its entry is the binary's
    // PATH. No form carries the API and every use throws.
    const electron = results.get("escape_electron") as {
      outcome: string;
      version: string | null;
      runAsNode: string | null;
      usable: string[];
      requireBare: { ok: boolean; module?: { kind: string; BrowserWindow: string } };
      importBare: { ok: boolean; module?: { BrowserWindow: string } };
      requireVendored: { ok: boolean; module?: { kind: string; BrowserWindow: string } };
      uses: Record<string, Record<string, { ok: boolean }>>;
    };
    expect(electron.outcome).toBe("no-usable-api");
    expect(electron.usable).toEqual([]);
    expect(electron.runAsNode).toBe("1");
    expect(typeof electron.version).toBe("string");
    expect(electron.requireVendored).toMatchObject({ ok: true, module: { kind: "string", BrowserWindow: "undefined" } });
    for (const form of ["requireBare", "importBare"] as const) {
      const answer = electron[form];
      if (answer.ok) expect(answer.module!.BrowserWindow, form).toBe("undefined");
    }
    for (const [form, used] of Object.entries(electron.uses)) {
      for (const [use, answer] of Object.entries(used)) expect(answer.ok, `${form}.${use}`).toBe(false);
    }
  }, 120_000);

  it("fails the run on the stdout-discipline row when escape_patch writes a line that is not JSON", async () => {
    const rows = await validatePluginDirectory(FIXTURE, {
      ...SOURCE_MODE,
      toolArgs: { ...TOOL_ARGS, escape_patch: { ...TOOL_ARGS.escape_patch, emitNonJson: true } },
    });
    expect(row(rows, "protocol.stdout-discipline")).toMatchObject({ ok: false });
    expect(row(rows, "protocol.stdout-discipline").message).toContain("this line is not JSON");
    expect(reportExitCode(rows)).toBe(1);
    // The decoder dropped the line and the session went on: the tool answered
    // and every later step ran.
    expect(row(rows, "tools.call:escape_patch")).toMatchObject({ ok: true });
    expect(row(rows, "protocol.stdin-close")).toMatchObject({ ok: true });
  }, 120_000);
});
