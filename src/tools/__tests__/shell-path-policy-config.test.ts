import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";

describe("transfer configuration authority", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTmpDir(root);
  });

  function check(command: string, fenced = false, environment: Record<string, string | undefined> = {}) {
    const root = mkdtempSync(join(tmpdir(), "ave-transfer-config-")).replaceAll("\\", "/");
    roots.push(root);
    return findShellPathPolicyViolation(command, root, root, [], fenced, {
      dialect: "bash", environment: { HOME: root, PWD: root, ...environment },
    });
  }

  it.each([
    "curl -K config.cfg", "curl -Kconfig.cfg", "curl -K=config.cfg",
    "curl -K=x/../config.txt",
    "curl --config config.cfg", "curl --config=config.cfg", "curl -sK config.cfg",
    "curl -sKconfig.cfg", "curl -K -", "curl --config=-",
    "curl -q -K config.cfg", "wget --config wget.cfg", "wget --config=wget.cfg",
    "wget --conf=wget.cfg", "wget --no-config --config=wget.cfg",
    "wget -e 'choose_config=wget.cfg'", "wget --execute='CHOOSE--__CONFIG=wget.cfg'",
    "wget -e 'config=wget.cfg'", "wget --execute='include=wget.cfg'",
  ])("refuses unanalysed configuration: %s", command => {
    expect(check(`${command} https://example.invalid/`)?.reason).toContain("ambiguous");
  });

  it.each([
    "curl -K", "curl -sK", "curl --config=", "wget --config=",
    "wget -e 'choose_config='", "curl -K /dev/stdin",
  ])("refuses missing or stream configuration: %s", command => {
    expect(check(command)?.kind).toBe("invalid-path");
  });

  it.each([
    ["curl -K", ""], ["curl --config=", ""], ["wget --config=", ""],
    ["wget -e 'choose_config=", "'"], ["uv run curl -K", ""],
    ["uv run wget --config=", ""],
  ])("checks configuration read authority before refusing %s", (option, suffix) => {
    const command = (path: string) => `${option}${option.endsWith("K") ? " " : ""}${path}${suffix}`;
    expect(check(command("ave-secrets.json"))?.kind).toBe("sensitive-path");
    expect(check(command("../config.cfg"), true)?.kind).toBe("sandbox-boundary");
    expect(check(command("../config.cfg"))?.reason).toContain("ambiguous");
  });

  it.each([".curlrc", "_curlrc", ".wgetrc", "wget.ini", "curlrc", ".config/curlrc", "etc/wgetrc", "usr/local/etc/wgetrc"])(
    "admits configuration writes inside the execution root after permission checks: %s", path => {
      for (const command of [`echo 'output=x' > ~/${path}`, `tee ~/${path}`, `cp x ~/${path}`]) {
        expect(check(command), command).toBeNull();
      }
    },
  );

  it.each([
    "echo 'output=x' > bin/.curlrc", "cp x bin/_curlrc",
    "echo 'output_document=x' > bin/wget.ini", "cp x bin/wget.ini", "tee C:/tools/wget/wget.ini",
    "tee \"$APPDATA/_curlrc\"", "cp x \"$USERPROFILE/.curlrc\"",
  ])("keeps configuration writes subject to directory confinement: %s", command => {
    const result = check(command, false, { APPDATA: ".", USERPROFILE: "." });
    if (command.includes("C:/") && process.platform === "win32") expect(result?.kind).toBe("sandbox-boundary");
    else expect(result).toBeNull();
  });

  it.each([
    "CURL_HOME=. curl", "XDG_CONFIG_HOME=. curl", "env CURL_HOME=. curl",
    "env WGETRC=x wget", "WGETRC=x wget", "SYSTEM_WGETRC=x wget", "export CURL_HOME=.; curl",
    "export WGETRC=x; wget", "CURL_HOME= curl", "env CURL_HOME= curl",
    "CURL_HOME=$UNKNOWN curl", "CURL_HOME=. uv run curl", "uv run env WGETRC=x wget",
    "HOME=. curl", "HOME=. wget",
  ])("refuses redirected default configuration: %s", command => {
    expect(check(`${command} https://example.invalid/`)?.reason).toContain("configuration environment");
  });

  // Native environment lookup folds variable names on this platform.
  it.runIf(process.platform === "win32").each([
    "env APPDATA=. curl", "env USERPROFILE=. curl", "env curl_home=. curl",
    "env xdg_config_home=. curl", "env wgetrc=x wget", "env home=. curl",
    "env appdata=. curl", "env userprofile=. curl",
  ])("refuses native configuration environment aliases: %s", command => {
    expect(check(`${command} https://example.invalid/`)?.reason).toContain("configuration environment");
  });

  it.each([
    "CURL_HOME=. curl -q", "CURL_HOME=. curl --disable", "XDG_CONFIG_HOME=. curl -q",
    "env WGETRC=x wget --no-config", "WGETRC=x wget --no-config=on",
    "SYSTEM_WGETRC=x wget --no-config",
    "CURL_HOME=. uv run curl -q", "uv run env WGETRC=x wget --no-config",
    "CURL_HOME=. env -u CURL_HOME curl", "env -u WGETRC wget",
    "HOME=. curl -q", "HOME=. wget --no-config",
  ])("allows proven disabled or unset configuration: %s", command => {
    expect(check(`${command} https://example.invalid/`)).toBeNull();
  });

  it.each([
    "CURL_HOME=. curl -s -q", "CURL_HOME=. curl -sq", "CURL_HOME=. curl -- -q",
    "CURL_HOME=. curl -o -q", "WGETRC=x wget -O --no-config",
    "WGETRC=x wget -- --no-config", "WGETRC=x wget --no-config=off",
    "WGETRC=x wget --no-config --config=x",
  ])("does not infer disabled configuration from unrelated operands: %s", command => {
    expect(check(`${command} https://example.invalid/`)).not.toBeNull();
  });

  it.each(["curl", "wget"])("preserves plain invocations of %s", command => {
    expect(check(`${command} https://example.invalid/`)).toBeNull();
  });

  it.each([
    ["curl", { CURL_HOME: "." }], ["curl", { XDG_CONFIG_HOME: "." }],
    ["wget", { WGETRC: "x" }], ["curl", { CURL_HOME: undefined }],
    ["curl", { HOME: undefined }], ["wget", { HOME: undefined }],
  ] as const)("refuses configured or unknown inherited selectors for %s", (command, environment) => {
    expect(check(`${command} https://example.invalid/`, false, environment)?.reason).toContain("configuration environment");
  });
});
