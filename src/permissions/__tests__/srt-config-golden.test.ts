// Pins the sandbox runtime package config Ave builds, entry for entry. Thirteen inputs are composed for macOS and for a simulated
// Linux platform and compared with a recorded file, so a change to how the config is composed fails here even when every
// narrower assertion still holds.
//
// The recorded file belongs to the host platform it was recorded on: path resolution differs between platforms (`/etc` is a link
// on macOS), so each has its own file. Within a platform the recording does not depend on the machine: the checkout location, the
// account, the temporary directory and which system paths happen to exist leave it unchanged. Record one with
// `AVE_RECORD_SRT_GOLDEN=1` and review the diff before committing it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ave-srt-golden-")));
  // Not named `home`: its children would read as account names to the repository's home-path check.
  return { root, home: path.join(root, "account") };
});

// Every home-anchored row hangs off the fixture home, so the recording does not depend on who runs it.
vi.mock("../../shared/policy-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  return { ...actual, policyHomeAnchors: () => [fixture.home] };
});

// The real module, with the built models observable.
vi.mock("../policy-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../policy-model.js")>();
  return { ...actual, buildPolicyModel: vi.fn(actual.buildPolicyModel) };
});

import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { configureHostResources } from "../../main/host-resources.js";
import { aveHome } from "../../shared/ave-home.js";
import { buildPolicyModel, type PolicyRow } from "../policy-model.js";
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

/** The roots that differ between machines and runs, with the name each is recorded under. */
function hostRoots(): [string, string][] {
  return [
    [aveHome(), "<AVE_HOME>"],
    [dirname(aveHome()), "<AVE_HOME_PARENT>"],
    [fixture.root, "<FIXTURE>"],
    [process.cwd(), "<REPO>"],
    // A checkout whose node_modules is a link resolves vendored paths outside the repository.
    [realpathSync(join(process.cwd(), "node_modules")), "<REPO>/node_modules"],
    [tmpdir(), "<TMP>"],
    [homedir(), "<HOST_HOME>"],
  ];
}

/**
 * Replaces every root that differs between machines and runs, in its plain spelling and with its last character as a class.
 * A root is replaced only where it stands as whole path segments: a short root such as `/work` must not match inside `/worktrees`.
 */
function normalize(value: unknown, roots: [string, string][] = hostRoots()): unknown {
  roots.sort((left, right) => right[0].length - left[0].length);
  const quoted = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const SEGMENT = "[A-Za-z0-9._-]";
  const text = (input: string): string => {
    for (const [root, name] of roots) {
      const before = `(?<!${SEGMENT}|/)`;
      input = input.replace(new RegExp(`${before}${quoted(`${root.slice(0, -1)}[${root.slice(-1)}]`)}(?!${SEGMENT})`, "g"), `${name}[]`);
      input = input.replace(new RegExp(`${before}${quoted(root)}(?!${SEGMENT})`, "g"), name);
    }
    return input;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, walk(entry)]));
    return node;
  };
  return walk(value);
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
  return normalize(JSON.parse(JSON.stringify(out))) as Record<string, unknown>;
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
    // One comparison per input, and every input is compared, so a failure names each input that moved.
    for (const [name, value] of Object.entries(recorded)) expect.soft(composed[name], name).toEqual(value);
  });

  it("replaces a machine root only where it stands as whole path segments", () => {
    const roots: [string, string][] = [["/work", "<REPO>"], ["/work/node_modules", "<REPO>/node_modules"], ["/tmp", "<TMP>"]];
    expect(normalize({
      denyRead: ["/work", "/work/src", "/wor[k]/src", "/work/node_modules/pkg", "/data/.git/worktrees", "/workspace/a", "/data/tmp/x", "/tmp-old/x"],
      refused: "cannot cover /work/src: /tmp is a link",
    }, roots)).toEqual({
      denyRead: ["<REPO>", "<REPO>/src", "<REPO>[]/src", "<REPO>/node_modules/pkg", "/data/.git/worktrees", "/workspace/a", "/data/tmp/x", "/tmp-old/x"],
      refused: "cannot cover <REPO>/src: <TMP> is a link",
    });
  });

  it("composes the same config twice", () => {
    expect(compose()).toEqual(compose());
  });
});

// The package projection replays grants as stated, so each composer must withhold a grant beneath the protected read floor itself.
describe.runIf(HOST !== "win32")("package config composers and the protected read floor", () => {
  const floored = join(ssh, "known_hosts");

  it("withholds a floored read grant from the shared config", () => {
    expect(buildSandboxConfig({ allowRead: [floored, ro] }).filesystem.allowRead).toEqual([ro]);
  });

  it("withholds a floored read grant from a per-command config", () => {
    const filesystem = buildPerCommandSandboxCustomConfig({
      allowRead: [floored, ro], denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyEntries(),
    })?.filesystem;
    expect(filesystem?.allowRead).toEqual([ro]);
  });

  it("names the floor each per-command read deny came from", () => {
    vi.mocked(buildPolicyModel).mockClear();
    buildPerCommandSandboxCustomConfig({
      denyRead: [...getDefaultSensitiveReadDenyPaths(), custom], denyWrite: getDefaultSensitiveWriteDenyEntries(), denyPluginsRoot: true,
    });
    const built = vi.mocked(buildPolicyModel).mock.results.at(-1);
    const rows: readonly PolicyRow[] = built?.type === "return" ? built.value.rows : [];
    const reasons = (path: string): string[] => rows.filter((row) => row.access === "denied" && row.path === path).map((row) => row.reason);
    expect(reasons(ssh)).toEqual(["secrets"]);
    expect(reasons(aveHome())).toEqual(["ave-home"]);
    expect(reasons(custom)).toEqual(["read-boundary"]);
    expect(rows.filter((row) => row.access === "denied").map((row) => row.reason)).toEqual(expect.arrayContaining(["secrets", "ave-home", "read-boundary"]));
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
