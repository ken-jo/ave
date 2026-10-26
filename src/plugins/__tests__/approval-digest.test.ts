// Approval covers the declaration, anchored commands and package tree; only the top-level version string is normalized.
// An indeterminate closure has no approval digest.
import { describe, expect, it } from "vitest";
import {
  approvalDigest,
  changedPayloadFiles,
  extensionComponentDigests,
  extensionDeclarationPaths,
  launcherSpec,
  payloadTreeSha256,
} from "../contribution-approval-digest.js";
import { isCodeFreeChange, pluginConsent, stagedDelta, withChangedFiles } from "../../marketplace/updates/consent.js";
import { payloadFile as file } from "../../marketplace/__tests__/fixtures/package-files.js";

function extension(options: { server?: string | null; util?: string; rules?: string; skill?: string; version?: string; description?: string; mcp?: Record<string, unknown> } = {}) {
  const ave: Record<string, unknown> = {
    capabilities: [],
    requires: { minAppVersion: "0.13.0" },
    skills: [{ id: "helper", path: "skills/helper" }],
    ...(options.server === null ? {} : { mcpServers: [{ id: "notes", path: ".mcp.json" }] }),
  };
  const document = { name: "notes", version: options.version ?? "1.0.0", description: options.description ?? "Notes", extensions: { "ai.agent-connector.ave": ave } };
  const files = [
    file("plugin.json", JSON.stringify(document)),
    file("skills/helper/SKILL.md", options.skill ?? "---\nname: helper\n---\nUse the notes."),
    file("skills/helper/assets/rules.txt", options.rules ?? "rule one"),
  ];
  if (options.server !== null) {
    files.push(
      file(".mcp.json", JSON.stringify(options.mcp ?? { transport: "stdio", command: "node", args: ["dist/server.js"] })),
      file("dist/server.js", options.server ?? "require('./lib/util.js'); eval(read('skills/helper/assets/rules.txt'))"),
      file("dist/lib/util.js", options.util ?? "module.exports = 1"),
    );
  }
  return { document, files };
}

function digestOf(options: Parameters<typeof extension>[0] = {}): string | null {
  const { document, files } = extension(options);
  return extensionComponentDigests(document, files).find((item) => item.localId === "notes")?.approvalDigest ?? null;
}

describe("approvalDigest", () => {
  it("changing the server, or a file it loads, changes the digest while the declaration stays byte-identical", () => {
    const base = digestOf();
    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestOf({ server: "require('./lib/util.js'); doSomethingElse()" })).not.toBe(base);
    expect(digestOf({ util: "module.exports = 2" })).not.toBe(base);
    // The update needs review: the fingerprint's mcpServer field differs.
    const before = extension();
    const after = extension({ util: "module.exports = 2" });
    expect(stagedDelta(pluginConsent(before.document, before.files), pluginConsent(after.document, after.files)).map((entry) => entry.field)).toEqual(["mcpServer:notes"]);
  });

  it("an indirect load: changing only a non-executable file the server may evaluate changes the digest", () => {
    expect(digestOf({ rules: "rule two" })).not.toBe(digestOf());
  });

  it("a complete versioned release that edits only SKILL.md: equal without a local executable, one-row review with one", () => {
    const codeFree = { server: null } as const;
    const before = extension(codeFree);
    const after = extension({ ...codeFree, version: "1.0.1", skill: "---\nname: helper\n---\nUse the notes, better." });
    // No stdio server, hook or process entry: nothing differs, so it applies by itself.
    expect(stagedDelta(pluginConsent(before.document, before.files), pluginConsent(after.document, after.files))).toEqual([]);

    const withServer = extension();
    const released = extension({ version: "1.0.1", skill: "---\nname: helper\n---\nUse the notes, better." });
    const delta = withChangedFiles(
      stagedDelta(pluginConsent(withServer.document, withServer.files), pluginConsent(released.document, released.files)),
      withServer.files,
      released.files,
      new Set(extensionDeclarationPaths(released.document)),
    );
    expect(delta).toEqual([expect.objectContaining({ field: "mcpServer:notes", changedFiles: { code: [], nonCode: ["skills/helper/SKILL.md"] } })]);
    expect(isCodeFreeChange(delta)).toBe(true);
  });

  it("a changed server declaration is code, though it is JSON: the review shows the server, never the one-row form", () => {
    const before = extension();
    const after = extension({ version: "1.0.1", mcp: { transport: "stdio", command: "node", args: ["dist/server.js"], env: { MODE: "upload" } } });
    expect(extensionDeclarationPaths(after.document)).toEqual([".mcp.json"]);
    const delta = withChangedFiles(
      stagedDelta(pluginConsent(before.document, before.files), pluginConsent(after.document, after.files)),
      before.files,
      after.files,
      new Set(extensionDeclarationPaths(after.document)),
    );
    expect(delta).toEqual([expect.objectContaining({ field: "mcpServer:notes", changedFiles: { code: [".mcp.json"], nonCode: [] } })]);
    expect(isCodeFreeChange(delta)).toBe(false);
  });

  it("a version-only change is normalized: same digest, same tree, plugin.json not listed", () => {
    expect(digestOf({ version: "2.0.0" })).toBe(digestOf());
    expect(payloadTreeSha256(extension({ version: "2.0.0" }).files)).toBe(payloadTreeSha256(extension().files));
    expect(changedPayloadFiles(extension().files, extension({ version: "9.9.9" }).files, new Set())).toEqual({ code: [], nonCode: [] });
  });

  it("a server that reads its input from the version string: a version-only change is input data, not a consent change (owner decision, §18.7.3)", () => {
    // The server prints the hex build metadata of the version it reads from ../plugin.json.
    const server = "console.log(Buffer.from(require('../plugin.json').version.split('+')[1], 'hex').toString());";
    const before = extension({ server, version: "1.0.0+73616665" });
    const after = extension({ server, version: "1.0.1+6368616e676564" });
    const input = (document: { version: string }) => Buffer.from(document.version.split("+")[1]!, "hex").toString();
    expect([input(before.document), input(after.document)]).toEqual(["safe", "changed"]);
    expect(stagedDelta(pluginConsent(before.document, before.files), pluginConsent(after.document, after.files))).toEqual([]);
    // Any other byte of plugin.json, or of the code, is a consent change.
    const described = extension({ server, version: "1.0.1+6368616e676564", description: "Notes, renamed" });
    expect(stagedDelta(pluginConsent(before.document, before.files), pluginConsent(described.document, described.files)).map((entry) => entry.field)).toEqual(["mcpServer:notes"]);
    const recoded = extension({ server: `${server}\n// patched`, version: "1.0.1+6368616e676564" });
    expect(stagedDelta(pluginConsent(before.document, before.files), pluginConsent(recoded.document, recoded.files)).map((entry) => entry.field)).toEqual(["mcpServer:notes"]);
  });

  describe("the normalization is exact: only the value of the one top-level string version", () => {
    function withManifest(text: string) {
      const { document, files } = extension();
      return { document, files: files.map((item) => (item.path === "plugin.json" ? file("plugin.json", text) : item)) };
    }
    function digestOfText(text: string): string | null {
      const { document, files } = withManifest(text);
      return extensionComponentDigests(document, files).find((item) => item.localId === "notes")?.approvalDigest ?? null;
    }
    const ave = JSON.stringify(extension().document.extensions);
    const manifest = (version: string, extra = "") => `{"name":"notes","version":${version},"description":"Notes"${extra},"extensions":${ave}}`;

    it("the same text with another version string is equal", () => {
      expect(digestOfText(manifest('"2.0.0"'))).toBe(digestOfText(manifest('"1.0.0"')));
    });

    it("whitespace, key order and another key still differ, with the version changed alongside", () => {
      const base = digestOfText(manifest('"1.0.0"'));
      expect(digestOfText(`{ "name": "notes", "version": "2.0.0", "description": "Notes", "extensions": ${ave} }`)).not.toBe(base);
      expect(digestOfText(`{"version":"2.0.0","name":"notes","description":"Notes","extensions":${ave}}`)).not.toBe(base);
      expect(digestOfText(manifest('"2.0.0"', ',"homepage":"https://example.com"'))).not.toBe(base);
    });

    it("a second version member is not normalized: two such files differing only in a version still differ", () => {
      const twice = (first: string, second: string) => `{"name":"notes","version":"${first}","version":"${second}","description":"Notes","extensions":${ave}}`;
      expect(digestOfText(twice("1.0.0", "1.0.0"))).not.toBe(digestOfText(twice("1.0.0", "2.0.0")));
      expect(digestOfText(twice("1.0.0", "1.0.0"))).not.toBe(digestOfText(manifest('"1.0.0"')));
    });

    it("a version that is not a string is not normalized", () => {
      expect(digestOfText(manifest("1"))).not.toBe(digestOfText(manifest("2")));
      expect(digestOfText(manifest('{"major":1}'))).not.toBe(digestOfText(manifest('{"major":2}')));
    });

    it("a nested version is not the top-level one", () => {
      const nested = (version: string) => `{"name":"notes","version":"1.0.0","description":"Notes","meta":{"version":"${version}"},"extensions":${ave}}`;
      expect(digestOfText(nested("1"))).not.toBe(digestOfText(nested("2")));
    });

    it("bytes that are not exact UTF-8 are hashed as they are", () => {
      const { document, files } = extension();
      // An invalid byte inside the description: both decode to U+FFFD and would parse alike.
      const raw = (byte: number) => files.map((item) => (item.path === "plugin.json"
        ? { ...item, data: Buffer.concat([Buffer.from(`{"name":"notes","version":"1.0.0","description":"Notes`), Buffer.from([byte]), Buffer.from(`","extensions":${ave}}`)]) }
        : item));
      const digest = (byte: number) => extensionComponentDigests(document, raw(byte)).find((item) => item.localId === "notes")?.approvalDigest ?? null;
      expect(digest(0xff)).not.toBe(digest(0xfe));
    });
  });

  it("any plugin.json change other than its version's value changes the digest and lists plugin.json as code", () => {
    expect(digestOf({ description: "Notes, renamed" })).not.toBe(digestOf());
    const changed = changedPayloadFiles(extension().files, extension({ description: "Notes, renamed" }).files, new Set());
    expect(changed).toEqual({ code: ["plugin.json"], nonCode: [] });
  });

  it("an unpinned launcher or image tag is null and never carries", () => {
    expect(digestOf({ mcp: { transport: "stdio", command: "npx", args: ["-y", "foo"] } })).toBeNull();
    expect(digestOf({ mcp: { transport: "stdio", command: "npx", args: ["foo@latest"] } })).toBeNull();
    expect(digestOf({ mcp: { transport: "stdio", command: "docker", args: ["run", "-i", "--rm", "acme/notes:latest"] } })).toBeNull();
  });

  it("a pinned launcher and an image by digest carry while unchanged", () => {
    const pinned = { transport: "stdio", command: "npx", args: ["-y", "foo@1.2.3"] };
    expect(digestOf({ mcp: pinned })).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestOf({ mcp: pinned })).toBe(digestOf({ mcp: pinned }));
    const image = { transport: "stdio", command: "docker", args: ["run", "-i", "--rm", `acme/notes@sha256:${"a".repeat(64)}`] };
    expect(digestOf({ mcp: image })).toMatch(/^[a-f0-9]{64}$/u);
    expect(digestOf({ mcp: image })).toBe(digestOf({ mcp: image }));
    // The package's files may still be read: a changed file changes a launcher's digest too.
    expect(digestOf({ mcp: pinned, rules: "rule two" })).not.toBe(digestOf({ mcp: pinned }));
  });

  it("a remote server runs nothing locally", () => {
    const remote = { transport: "http", url: "https://mcp.example.com" };
    expect(digestOf({ mcp: remote })).toBe(digestOf({ mcp: remote, rules: "rule two" }));
  });

  it("a command path that names no package file, or a bare system command, is undeterminable", () => {
    expect(digestOf({ mcp: { transport: "stdio", command: "node", args: ["dist/missing.js"] } })).toBeNull();
    expect(approvalDigest({ declaration: "d", baseDir: "", transport: "stdio", argvs: [["git", "status"]] }, [])).toBeNull();
  });

  it("launcher specs", () => {
    expect(launcherSpec(["npx", "-y", "@scope/pkg@1.2.3"])).toEqual({ spec: "@scope/pkg@1.2.3" });
    expect(launcherSpec(["uvx", "notes==1.0.0"])).toEqual({ spec: "notes==1.0.0" });
    expect(launcherSpec(["uvx", "notes"])).toEqual({ spec: null });
    expect(launcherSpec(["pipx", "run", "notes==2.0"])).toEqual({ spec: "notes==2.0" });
    expect(launcherSpec(["node", "x.js"])).toBeNull();
  });
});
