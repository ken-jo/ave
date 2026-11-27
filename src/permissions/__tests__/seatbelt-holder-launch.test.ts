import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../asrt-sandbox.js", () => ({
  seatbeltHolderFloorRows: () => [{ path: "/users/example/.ssh", literal: false, access: "denied", reason: "secrets" }],
  getDefaultSensitiveWriteDenyEntries: () => [],
  runWithSandboxWritePreflight: (_signal: unknown, run: () => unknown) => run(),
}));

import { rankPosixContainerRows, type PosixPolicyLookups } from "../mxc-posix.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow, type PolicyFloorRow } from "../policy-model.js";
import { buildSeatbeltShellProfile, splitSeatbeltPolicyRows } from "../seatbelt-profile.js";
import {
  composeSeatbeltHolderLaunch, HOLDER_READY_SHIM, HOLDER_SHELL, seatbeltHolderLaunchDigest, type SeatbeltHolderFloors, type SeatbeltHolderLaunchInput,
} from "../seatbelt-holder-launch.js";

const TREE: Record<string, readonly string[]> = { "/": ["users", "workspace", "tmp"], "/users": ["example"], "/users/example": [".ssh", ".ave", "notes"] };
const lookups: PosixPolicyLookups = {
  home: "/users/example", foldsCase: true, canonical: path => path, exists: () => true, children: path => TREE[path] ?? [],
};
const AVE_HOME = "/users/example/.ave";
const FLOORS: readonly PolicyFloorRow[] = [
  policyFloorRow("/users/example/.ssh", "denied", "secrets", true),
  policyFloorRow(AVE_HOME, "denied", "read-boundary", true),
  policyFloorRow("/workspace/.git/hooks", "ro", "protected-name", true),
];
const host = (floors = FLOORS): SeatbeltHolderFloors => ({ floors, allowWrite: ["/workspace"], lookups });
let counter = 0;
const labels = () => {
  counter += 1;
  return { holder: `dev.ave.holder.itest.btest.h${counter}`, boot: "dev.ave.holder.itest.btest.all", instance: "dev.ave.holder.itest.any" };
};
const input = (over: Partial<SeatbeltHolderLaunchInput> = {}): SeatbeltHolderLaunchInput => ({
  command: "/usr/local/bin/server", args: ["--stdio", "a b"], cwd: "/workspace", env: { PATH: "/usr/bin:/bin", LANG: "C" },
  readRoots: [`${AVE_HOME}/plugins/p1`], writeRoots: ["/workspace"], network: { proxyUrl: "http://127.0.0.1:4100" }, labels: labels(), ...over,
});
const LABEL_LINES = /\(deny mach-lookup \(global-name-prefix "dev\.ave\.holder\."\)\)\n\(allow mach-lookup [^\n]+\)\n$/u;

describe("macOS holder launch", () => {
  it("is the shell's profile for the same rows plus the broad read, with the label last", () => {
    const launch = composeSeatbeltHolderLaunch(input(), host());
    const model = buildPolicyModel({ floors: FLOORS, userGrants: [], extensionManifests: [], launchGrants: [
      policyGrantRow("/workspace", "rw", "launch-grant", false), policyGrantRow(`${AVE_HOME}/plugins/p1`, "ro", "launch-grant", false),
      policyGrantRow("/", "ro", "launch-grant", true),
    ] });
    const grants = rankPosixContainerRows(splitSeatbeltPolicyRows(model).literalModel, "seatbelt", lookups);
    const shell = buildSeatbeltShellProfile({ model, grants, lookups, unixSocketRoots: [], proxyPort: 4100 });
    expect(launch.profile.startsWith(shell)).toBe(true);
    expect(launch.profile.slice(shell.length)).toMatch(LABEL_LINES);
    expect(launch.profile.slice(shell.length)).toContain(`(global-name "${launch.labels.holder}")`);
    expect(launch.argv).toEqual(["-p", launch.profile, HOLDER_SHELL, "-c", HOLDER_READY_SHIM, "ave-holder", "/usr/local/bin/server", "--stdio", "a b"]);
    expect(launch.proxyPort).toBe(4100);
  });

  it("gives an offline holder no network rule and no proxy variable", () => {
    const launch = composeSeatbeltHolderLaunch(input({ network: "offline" }), host());
    expect(launch.profile).not.toContain("network-outbound (remote ip");
    expect(launch.proxyPort).toBeNull();
    expect(Object.keys(launch.env).filter(key => key.toLowerCase().includes("proxy"))).toEqual([]);
  });

  it("still denies the floors with no caller rows, and refuses a caller's read base in any spelling", () => {
    const launch = composeSeatbeltHolderLaunch(input({ readRoots: [], writeRoots: [] }), { ...host(), allowWrite: [] , lookups });
    expect(launch.grants.denied).toContain("/users/example/.ssh");
    expect(launch.profile).toMatch(/\(deny file-read\* [^\n]*"\/users\/example\/\.ave"/u);
    expect(launch.profile).not.toMatch(/\(allow file-read\* file-write\* \(subpath/u);
    const writer = composeSeatbeltHolderLaunch(input({ readRoots: [] }), host());
    expect(writer.profile).toMatch(/\(deny file-write\* [^\n]*"\/workspace\/\.git\/hooks"/u);
    for (const root of ["/", "//", "/./", "/tmp/.."]) {
      expect(() => composeSeatbeltHolderLaunch(input({ readRoots: [root] }), host())).toThrow(expect.objectContaining({ code: "read-base-supplied" }));
    }
  });

  it("makes a fresh label per start and refuses a row that would render a label rule", () => {
    const [first, second] = [composeSeatbeltHolderLaunch(input(), host()), composeSeatbeltHolderLaunch(input(), host())];
    expect(first.labels.holder).not.toBe(second.labels.holder);
    expect(first.profile.match(/dev\.ave\.holder\./gu)?.length).toBe(4);
    expect(() => composeSeatbeltHolderLaunch(input({ readRoots: ["/tmp/dev.ave.holder.x"] }), host())).toThrow(expect.objectContaining({ code: "profile-reserved-name" }));
    expect(() => composeSeatbeltHolderLaunch(input({ labels: { ...labels(), holder: "com.apple.x" } }), host())).toThrow("labels are malformed");
  });

  it("carries the lease URL in the six proxy variables and drops caller proxy keys", () => {
    const launch = composeSeatbeltHolderLaunch(input({ env: { PATH: "/bin", https_proxy: "http://evil:1", No_Proxy: "*", FTP_PROXY: "x", SHLVL: "0" } }), host());
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(launch.env[key]).toBe("http://127.0.0.1:4100");
    expect(launch.env).not.toHaveProperty("No_Proxy");
    expect(launch.env).not.toHaveProperty("FTP_PROXY");
    expect(launch.env.SHLVL).toBe("1");
    expect(launch.env.PATH).toBe("/bin");
    expect(() => composeSeatbeltHolderLaunch(input({ network: { proxyUrl: "http://10.0.0.1:80" } }), host())).toThrow(expect.objectContaining({ code: "proxy-invalid" }));
  });

  it("refuses a startup variable or an exported function before anything is spawned", () => {
    const refused: Record<string, string>[] = [{ "BASH_FUNC_read%%": "() { :; }" }, { BASH_ENV: "/tmp/x" }, { ENV: "/tmp/x" }, { DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" }];
    for (const env of refused) {
      expect(() => composeSeatbeltHolderLaunch(input({ env }), host())).toThrow(expect.objectContaining({ code: "launcher-environment-refused" }));
    }
  });

  it("names the whole launch record with one digest", () => {
    const launch = composeSeatbeltHolderLaunch(input(), host());
    expect(seatbeltHolderLaunchDigest(launch)).toBe(launch.digest);
    expect(seatbeltHolderLaunchDigest({ ...launch, env: { ...launch.env, LANG: "en" } })).not.toBe(launch.digest);
    expect(seatbeltHolderLaunchDigest({ ...launch, cwd: "/elsewhere" })).not.toBe(launch.digest);
  });

  it("refuses a working directory outside the grants and a relative executable", () => {
    expect(() => composeSeatbeltHolderLaunch(input({ cwd: "/users/example/.ssh" }), host())).toThrow(expect.objectContaining({ code: "cwd-ungranted" }));
    expect(() => composeSeatbeltHolderLaunch(input({ command: "server" }), host())).toThrow(expect.objectContaining({ code: "command-invalid" }));
  });

  it("lets no caller compose a launch with floors it supplied", () => {
    const source = readFileSync(new URL("../seatbelt-holder-launch.ts", import.meta.url), "utf8");
    expect(source.match(/composeSeatbeltHolderLaunch\(/gu)).toHaveLength(2);
    expect(source).toContain("composeSeatbeltHolderLaunch(input, await captureSeatbeltHolderFloors(input, signal))");
  });
});
