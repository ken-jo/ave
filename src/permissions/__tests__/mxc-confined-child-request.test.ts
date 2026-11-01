import { describe, expect, it } from "vitest";
import { buildMxcConfinedChildRequest, type MxcConfinedChildRequestInput } from "../mxc-confined-child-request.js";

function input(): MxcConfinedChildRequestInput {
  return {
    command: "C:\\runtime\\runtime.exe", args: ["D:\\staging\\entry.js", "", "a b", 'a"b', "tail\\"],
    cwd: "D:\\staging", home: "D:\\staging\\home", temp: "D:\\staging\\temp",
    grants: { readwrite: ["D:\\staging"], readonly: ["C:\\runtime", "C:\\Windows"], denied: ["D:\\staging\\private"] },
    baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\profile\\AppData\\Local", ELECTRON_RUN_AS_NODE: "1" },
    proxyUrl: "http://127.0.0.1:43210",
  };
}

describe("per-holder native request", () => {
  it("keeps UI enabled and endpoint scoping with query-only volume ancestors", () => {
    const request = buildMxcConfinedChildRequest(input());
    expect(request.ui).toEqual({ disable: false, clipboard: "none", allowInputInjection: false });
    expect(request.network).toEqual({ egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" },
      runtimeConfig: { networkProxy: input().proxyUrl } });
    expect(request.containment).toEqual({ type: "processcontainer", config: { filesystem: { enumeratePaths: ["D:\\", "C:\\"] } } });
    expect(request.filesystem?.readonlyPaths).toEqual(input().grants.readonly);
    expect(request.filesystem?.clearPolicyOnExit).toBe(true);
    expect(request.command).toBe('C:\\runtime\\runtime.exe D:\\staging\\entry.js "" "a b" "a\\"b" tail\\');
    expect(request).not.toHaveProperty("telemetry");
    expect(request).not.toHaveProperty("timeoutMs");
  });

  it("strips secrets and proxy overrides and gives the holder its own home and temp", () => {
    const spec = input();
    const request = buildMxcConfinedChildRequest({ ...spec, baseEnv: { ...spec.baseEnv,
      PROVIDER_API_KEY: "secret", HTTP_PROXY: "http://evil.test", NODE_OPTIONS: "--require=evil",
      MXC_FFI_DIR: "C:\\override", USERPROFILE: "C:\\host", HOME: "C:\\host", TEMP: "C:\\host", PWD: "C:\\host",
    } });
    expect(request.environment).toMatchObject({ HOME: spec.home, USERPROFILE: spec.home, TEMP: spec.temp, TMP: spec.temp,
      PWD: spec.cwd, ELECTRON_RUN_AS_NODE: "1" });
    for (const key of ["PROVIDER_API_KEY", "HTTP_PROXY", "NODE_OPTIONS", "MXC_FFI_DIR"]) expect(request.environment).not.toHaveProperty(key);
    expect(request.inheritDefaultEnvironment).toBe(false);
  });

  it("carries the holder's host-owned variables, leaving wrapper and container-owned keys alone", () => {
    const spec = input();
    const request = buildMxcConfinedChildRequest({ ...spec, holderEnv: {
      AVE_HOOK_TYPE: "pre", PLUGIN_DATA: "D:\\staging\\data", FS_TOKEN: "k", LANG: "ko_KR.UTF-8",
      HTTP_PROXY: "http://evil.test", HOME: "C:\\host", TEMP: "C:\\host", PWD: "C:\\host",
    } });
    expect(request.environment).toMatchObject({ AVE_HOOK_TYPE: "pre", PLUGIN_DATA: "D:\\staging\\data", FS_TOKEN: "k",
      LANG: "ko_KR.UTF-8", HOME: spec.home, TEMP: spec.temp, PWD: spec.cwd });
    expect(request.environment).not.toHaveProperty("HTTP_PROXY");
  });

  it("refuses duplicate or loader-override holder variables", () => {
    expect(() => buildMxcConfinedChildRequest({ ...input(), holderEnv: { Token: "a", TOKEN: "b" } })).toThrow("duplicate");
    expect(() => buildMxcConfinedChildRequest({ ...input(), holderEnv: { NODE_OPTIONS: "--require=x" } })).toThrow();
  });

  it.each(["command", "cwd", "home", "temp"] as const)("refuses unadmitted %s without widening", (field) => {
    const spec = input();
    const bad = field === "command" ? "E:\\outside\\runtime.exe" : "E:\\outside";
    const before = JSON.stringify(spec.grants);
    expect(() => buildMxcConfinedChildRequest({ ...spec, [field]: bad })).toThrow();
    expect(JSON.stringify(spec.grants)).toBe(before);
  });

  it.each(["runner.cmd", "C:\\runtime\\runner.bat", "powershell", "C:\\runtime\\bad\0.exe"])("refuses non-native executable %s", (command) => {
    expect(() => buildMxcConfinedChildRequest({ ...input(), command })).toThrow();
  });

  it("refuses missing runtime variables and command controls", () => {
    expect(() => buildMxcConfinedChildRequest({ ...input(), baseEnv: {} })).toThrow();
    expect(() => buildMxcConfinedChildRequest({ ...input(), args: ["hello\nworld"] })).toThrow();
  });

  it("copies immutable policy arrays and never grants another holder's roots", () => {
    const first = buildMxcConfinedChildRequest(input());
    const spec = input();
    const second = buildMxcConfinedChildRequest({ ...spec, cwd: "E:\\other", home: "E:\\other\\home", temp: "E:\\other\\temp",
      grants: { ...spec.grants, readwrite: ["E:\\other"] } });
    expect(second.filesystem?.readwritePaths).not.toContain("D:\\staging");
    first.filesystem!.readwritePaths!.push("D:\\unrelated");
    expect(input().grants.readwrite).toEqual(["D:\\staging"]);
  });
});
