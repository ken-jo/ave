/**
 * The approval digest (design §18.7.3): it covers what a bundled component
 * runs and everything it can read — the declaration, the anchored command
 * files and the whole package tree, with only `plugin.json`'s `version`
 * normalized — and it is `null` when the closure cannot be determined.
 */
import { describe, expect, it } from "vitest";
import {
  approvalDigest,
  changedPayloadFiles,
  extensionComponentDigests,
  launcherSpec,
  payloadTreeSha256,
  type PayloadFile,
} from "../contribution-approval-digest.js";
import { isCodeFreeChange, pluginConsent, stagedDelta, withChangedFiles } from "../../marketplace/updates/consent.js";

const file = (path: string, text: string): PayloadFile => ({ path, data: Buffer.from(text, "utf8") });

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
    );
    expect(delta).toEqual([expect.objectContaining({ field: "mcpServer:notes", changedFiles: { code: [], nonCode: ["skills/helper/SKILL.md"] } })]);
    expect(isCodeFreeChange(delta)).toBe(true);
  });

  it("the version bump alone changes nothing: plugin.json is normalized for its top-level version only", () => {
    expect(digestOf({ version: "2.0.0" })).toBe(digestOf());
    expect(payloadTreeSha256(extension({ version: "2.0.0" }).files)).toBe(payloadTreeSha256(extension().files));
  });

  it("any other plugin.json field changes the digest and lists plugin.json as code", () => {
    expect(digestOf({ description: "Notes, renamed" })).not.toBe(digestOf());
    const changed = changedPayloadFiles(extension().files, extension({ description: "Notes, renamed" }).files);
    expect(changed).toEqual({ code: ["plugin.json"], nonCode: [] });
    expect(changedPayloadFiles(extension().files, extension({ version: "9.9.9" }).files)).toEqual({ code: [], nonCode: [] });
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
