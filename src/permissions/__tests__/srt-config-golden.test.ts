// Pins the sandbox runtime package config Ave builds, entry for entry. Thirteen inputs are composed for macOS and for a simulated
// Linux platform and compared with a recorded file, so a change to how the config is composed fails here even when every
// narrower assertion still holds.
//
// The recorded file belongs to the host it was recorded on: path resolution differs between hosts (`/etc` is a link on macOS), so
// each host platform has its own file. Record one with `AVE_RECORD_SRT_GOLDEN=1` and review the diff before committing it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ave-srt-golden-")));
  return { root, home: path.join(root, "home") };
});

// Every home-anchored row hangs off the fixture home, so the recording does not depend on who runs it.
vi.mock("../../shared/policy-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  return { ...actual, policyHomeAnchors: () => [fixture.home] };
});

import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { configureHostResources } from "../../main/host-resources.js";
import { aveHome } from "../../shared/ave-home.js";
import {
  buildPerCommandSandboxCustomConfig, buildSandboxConfig, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyEntries,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";

const HOST = process.platform;
/** Host platforms with a recorded file. A host outside this list has nothing to compare with yet. */
const RECORDED_HOSTS: readonly NodeJS.Platform[] = ["darwin", "linux"];
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", `srt-config-golden.${HOST}.json`);
const RECORDING = process.env.AVE_RECORD_SRT_GOLDEN === "1";

const ws = join(fixture.root, "ws");
const ro = join(fixture.root, "ro");
const custom = join(fixture.root, "custom");
const plain = join(fixture.root, "plain");
const userData = join(fixture.root, "userdata");
const ssh = join(fixture.home, ".ssh");

beforeAll(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  for (const directory of [join(ws, ".git", "hooks"), join(ws, ".vscode"), ro, custom, plain, userData, ssh]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(ssh, "known_hosts"), "");
  // The write floor reads the system and user Git configuration; neither may leak into the recording.
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(fixture.root, "gitconfig"));
});

afterEach(() => setProcessPlatform(HOST));

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(fixture.root, { recursive: true, force: true });
});

/** Replaces every root that differs between machines and runs, in its plain spelling and with its last character as a class. */
function normalize(text: string): string {
  const roots: [string, string][] = [
    [aveHome(), "<AVE_HOME>"],
    [dirname(aveHome()), "<AVE_HOME_PARENT>"],
    [fixture.root, "<FIXTURE>"],
    [process.cwd(), "<REPO>"],
    [tmpdir(), "<TMP>"],
    [homedir(), "<HOST_HOME>"],
  ];
  const json = (value: string): string => JSON.stringify(value).slice(1, -1);
  for (const [root, name] of roots.sort((left, right) => right[0].length - left[0].length)) {
    text = text.split(json(`${root.slice(0, -1)}[${root.slice(-1)}]`)).join(`${name}[]`);
    text = text.split(json(root)).join(name);
  }
  return text;
}

type Compose = () => unknown;

function inputs(): Record<string, Compose> {
  const restated = { denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyEntries() };
  return {
    "shared: grants and configured denies": () => buildSandboxConfig({
      allowWrite: [ws], allowRead: [ws, ro], denyRead: [custom, "~/.golden-secret"],
      denyWrite: [join(ws, "locked"), { path: join(ws, "lit[1]"), literal: true }],
    }).filesystem,
    "shared: nothing configured": () => buildSandboxConfig({}).filesystem,
    "shared: two write roots and a user data directory": () => buildSandboxConfig({ allowWrite: [ws, plain], userDataDir: userData }).filesystem,
    "shared: an empty read list": () => buildSandboxConfig({ allowWrite: [plain], allowRead: [] }).filesystem,
    "wrap: no overrides": () => buildPerCommandSandboxCustomConfig(undefined)?.filesystem,
    "wrap: pinned write root with the floors restated": () => buildPerCommandSandboxCustomConfig({
      allowWrite: [ws], allowRead: [ws, ro], ...restated, pinWriteRoots: true,
    })?.filesystem,
    "wrap: one read deny": () => buildPerCommandSandboxCustomConfig({ denyRead: [custom] })?.filesystem,
    "wrap: one read deny and an empty read list": () => buildPerCommandSandboxCustomConfig({ denyRead: [custom], allowRead: [] })?.filesystem,
    "wrap: a read grant under a restated deny, duplicate literal write denies": () => buildPerCommandSandboxCustomConfig({
      allowWrite: [plain], allowRead: [plain, join(custom, "inner")], denyRead: [...restated.denyRead, custom],
      denyWrite: [...restated.denyWrite, { path: join(plain, "x"), literal: true }, { path: join(plain, "x"), literal: true }],
      floorPierces: [], pinWriteRoots: true,
    })?.filesystem,
    "wrap: write roots only": () => buildPerCommandSandboxCustomConfig({ allowWrite: [ws, plain] })?.filesystem,
    "wrap: read grant only": () => buildPerCommandSandboxCustomConfig({ allowRead: [ro] })?.filesystem,
    "wrap: other extensions' storage denied": () => buildPerCommandSandboxCustomConfig({
      allowWrite: [plain], allowRead: [plain], ...restated, denyPluginsRoot: true, pinWriteRoots: true,
    })?.filesystem,
    "wrap: grants beneath the protected read floor": () => buildPerCommandSandboxCustomConfig({
      allowWrite: [ssh], allowRead: [join(ssh, "known_hosts"), ro], ...restated,
    })?.filesystem,
  };
}

function compose(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const platform of ["darwin", "linux"] as const) {
    setProcessPlatform(platform);
    try {
      for (const [name, run] of Object.entries(inputs())) {
        // A refusal is part of what is pinned.
        try { out[`${platform} · ${name}`] = run() ?? null; }
        catch (error) { out[`${platform} · ${name}`] = { refused: (error as Error).message }; }
      }
    } finally {
      setProcessPlatform(HOST);
    }
  }
  return JSON.parse(normalize(JSON.stringify(out))) as Record<string, unknown>;
}

describe.runIf(RECORDED_HOSTS.includes(HOST) || RECORDING)("sandbox runtime package config golden", () => {
  it("composes the recorded config for every input on macOS and on simulated Linux", () => {
    const composed = compose();
    expect(Object.keys(composed)).toHaveLength(26);
    if (RECORDING) {
      writeFileSync(GOLDEN, `${JSON.stringify(composed, null, 1)}\n`);
      return;
    }
    expect(existsSync(GOLDEN), `no recorded config for a ${HOST} host`).toBe(true);
    const recorded = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    expect(Object.keys(composed)).toEqual(Object.keys(recorded));
    // One comparison per input, so a failure names the input that moved.
    for (const [name, value] of Object.entries(recorded)) expect(composed[name], name).toEqual(value);
  });

  it("composes the same config twice", () => {
    expect(compose()).toEqual(compose());
  });
});

describe.skipIf(shouldSkipNativeSandboxTests())("shared config inside a running session", () => {
  afterEach(async () => { await resetAsrtSandbox(); });

  it("falls back to the session's user data directory when the settings name none", async () => {
    await initializeRequiredSandbox({ allowedDomains: [], strictAllowlist: true, userDataDir: userData });
    const bare = (entries: readonly (string | { path: string })[]): string[] =>
      entries.map((entry) => (typeof entry === "string" ? entry : entry.path).replace(/\/+$/, ""));
    expect(bare(buildSandboxConfig({}).filesystem.denyRead)).toContain(userData);
    expect(bare(buildSandboxConfig({ userDataDir: custom }).filesystem.denyRead)).not.toContain(userData);
  });
});
