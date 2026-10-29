import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostGitExecutable } from "../../__tests__/fixtures/git-runner.js";
import { gitFixtureEnv } from "../../../__tests__/support/git-fixture-env.mjs";
import {
  parseNullConfigList,
  readCopiedCredentialConfig,
  selectCopiedEntries,
  writeGeneratedGlobalConfig,
} from "../global-config.js";

describe("selectCopiedEntries", () => {
  it("keeps credential helpers, per-URL credential keys and the two TLS keys only", () => {
    const entries = parseNullConfigList(
      [
        "credential.helper\nosxkeychain",
        "credential.https://github.com.helper\n!gh auth git-credential",
        "credential.https://git.corp.example.username\nme",
        "credential.usehttppath\ntrue",
        "http.sslcainfo\n/etc/corp.pem",
        "http.sslbackend\nschannel",
        "http.sslverify\nfalse",
        "http.extraheader\nAuthorization: Bearer leak",
        "url.https://evil.example/.insteadof\nhttps://github.com/",
        "core.sshcommand\nssh -o ProxyCommand=evil",
        "alias.st\nstatus",
        "http.https://github.com.sslcainfo\n/tmp/x.pem",
        "credential.helper",
        "credential.https://h.example.usehttppath",
        "http.sslcainfo",
      ].join("\0") + "\0",
    );
    expect(selectCopiedEntries(entries)).toEqual([
      { key: "credential.helper", value: "osxkeychain" },
      { key: "credential.https://github.com.helper", value: "!gh auth git-credential" },
      { key: "credential.https://git.corp.example.username", value: "me" },
      { key: "http.sslcainfo", value: "/etc/corp.pem" },
      { key: "http.sslbackend", value: "schannel" },
      { key: "credential.helper", value: "" },
      // A valueless helper resets the list; other valueless keys (git refuses them) are dropped.
    ]);
  });
});

describe("generated global config", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-global-config-"));
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = dir;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  const readGeneratedConfig = (gitPath: string, output: string) => execFileSync(gitPath, ["config", "--file", output, "--null", "--list"], {
    encoding: "utf8", env: gitFixtureEnv(dir),
  });

  it("copies the user's credential helper and drops everything else", async () => {
    writeFileSync(
      join(dir, ".gitconfig"),
      [
        "[credential]",
        "\thelper = store --file=\"/tmp/creds with space\"",
        "[credential \"https://Git.Corp.Example\"]",
        "\thelper = corp-helper",
        "[url \"https://evil.example/\"]",
        "\tinsteadOf = https://github.com/",
        "[http]",
        "\textraHeader = Authorization: Bearer leak",
        "\tsslVerify = false",
        "",
      ].join("\n"),
    );
    const git = await hostGitExecutable();
    const entries = await readCopiedCredentialConfig(git.path);
    expect(entries).toContainEqual({ key: "credential.helper", value: "store --file=/tmp/creds with space" });
    expect(entries).toContainEqual({ key: "credential.https://Git.Corp.Example.helper", value: "corp-helper" });
    expect(entries.map((entry) => entry.key)).not.toContain("url.https://evil.example/.insteadof");

    const output = join(dir, "generated");
    await writeGeneratedGlobalConfig(output, entries);
    const text = readFileSync(output, "utf8");
    expect(text).not.toContain("insteadOf");
    expect(text).not.toContain("extraHeader");
    expect(text).not.toContain("sslVerify");
    const readBack = readGeneratedConfig(git.path, output);
    expect(selectCopiedEntries(parseNullConfigList(readBack))).toEqual(entries);
  });

  it("produces an empty file when there is no user config", async () => {
    const output = join(dir, "generated");
    await writeGeneratedGlobalConfig(output, []);
    expect(readFileSync(output, "utf8")).toBe("");
  });

  it("keeps the copied order across sections, valueless keys and escaped values", async () => {
    // Empty helper values reset the list, so preserve ordering with per-URL helpers.
    const entries = [
      { key: "credential.helper", value: "manager" },
      { key: "credential.https://Dev.Example/a \"b\".usehttppath", value: "true" },
      { key: "credential.https://Dev.Example/a \"b\".helper", value: "store --file=C:\\creds\\x" },
      { key: "credential.helper", value: "" },
      { key: "http.sslcainfo", value: " /etc/corp #1; \"quoted\"\tpem " },
      { key: "credential.https://Corp.Example.username", value: "a\u001bb\rc" },
    ];
    const output = join(dir, "generated");
    await writeGeneratedGlobalConfig(output, entries);
    const git = await hostGitExecutable();
    const readBack = readGeneratedConfig(git.path, output);
    expect(parseNullConfigList(readBack)).toEqual(entries);
  });
});
