/**
 * Folder input through the existing preview (design §18.4.1, §18.5): stages
 * 1–3 make no filesystem call on the path, so a block or a confirmation ends
 * the preview before a share is contacted; root resolution follows the
 * entered path's own links by their text, after the network check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeVolume, marketplaceRefusal as refused, TEST_FOLDER_LIMITS, type FolderCall } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import { FIXTURE_POLICY_PATH, policySource } from "../../__tests__/fixtures/policy.js";
import type { SourcePreviewResultView } from "../../../shared/git-marketplace.js";

const SKILL = "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n";
const READ_OPS: ReadonlySet<FolderCall["op"]> = new Set(["lstat", "readdir", "readlink", "open", "fstat", "read", "close", "queryDosDevice"]);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-folder-consent-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function preview(volume: FakeVolume, input: string, extra: { acknowledge?: Array<"network-folder"> } = {}, policy = policySource()) {
  const { service } = await folderService({ root, folders: { fs: volume, platform: volume.platform, limits: TEST_FOLDER_LIMITS }, policy, home: volume.platform === "win32" ? "C:\\Users\\example" : "/Users/example" });
  try {
    return await service.previewSource({ input, auth: "none", ...extra });
  } finally {
    service.close();
  }
}

function windowsVolume() {
  return new FakeVolume("win32", {
    drives: { "C:": "\\Device\\HarddiskVolume3", "Z:": "\\Device\\Mup\\;LanmanRedirector\\;Z:000000000001a2b3\\files.corp\\share" },
  });
}

describe("a network folder answers confirm before anything touches it", () => {
  it("asks for network-folder on a UNC path with zero filesystem calls", async () => {
    const volume = windowsVolume().file("\\\\files.corp\\share\\m\\SKILL.md", SKILL);
    const answer = await preview(volume, "\\\\files.corp\\share\\m");
    expect(answer).toEqual({ type: "confirm", warnings: [{ warning: "network-folder", host: "files.corp", address: "\\\\files.corp\\share\\m" }] });
    expect(volume.calls).toEqual([]);
  });

  it("asks for network-folder on a drive mapped to a share, after only the drive's mapping was read", async () => {
    const volume = windowsVolume().file("Z:\\m\\SKILL.md", SKILL);
    const answer = await preview(volume, "Z:\\m");
    expect(answer).toEqual({ type: "confirm", warnings: [{ warning: "network-folder", host: "files.corp", address: "Z:\\m" }] });
    expect(volume.calls).toEqual([{ op: "queryDosDevice", path: "Z:" }]);
  });

  it("blocks the same inputs under allowLocalSources: false with zero calls, the drive's mapping included", async () => {
    for (const input of ["\\\\files.corp\\share\\m", "Z:\\m", "C:\\m"]) {
      const volume = windowsVolume().file("C:\\m\\SKILL.md", SKILL);
      const error = await refused(preview(volume, input, {}, policySource({ allowLocalSources: false })));
      expect(error).toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "local-sources-blocked", policyPath: FIXTURE_POLICY_PATH } });
      expect(volume.calls, input).toEqual([]);
    }
  });

  it("reads the folder after network-folder is acknowledged, with lstat walks and no other kind of call", async () => {
    const volume = windowsVolume().file("\\\\files.corp\\share\\m\\SKILL.md", SKILL);
    const answer = await preview(volume, "\\\\files.corp\\share\\m", { acknowledge: ["network-folder"] });
    expect(answer).toMatchObject({ type: "package", transport: "folder", path: "\\\\files.corp\\share\\m", kind: "skill", name: "note", url: null });
    expect(volume.paths("lstat").length).toBeGreaterThan(0);
    // FolderFs has no realpath: every call is one of the folder reader's own.
    expect(volume.calls.every((call) => READ_OPS.has(call.op))).toBe(true);
  });

  it("refuses a branch, subfolder or sign-in given with a folder, before any call", async () => {
    const volume = new FakeVolume("linux").file("/opt/m/SKILL.md", SKILL);
    const { service } = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
    for (const request of [{ ref: "main" }, { subdir: "skills" }, { auth: "token" as const, token: "t" }]) {
      const error = await refused(service.previewSource({ input: "/opt/m", auth: "none", ...request }));
      expect(error).toMatchObject({ code: "SOURCE_URL_REJECTED", detail: { reason: "folder-options" } });
    }
    service.close();
    expect(volume.calls).toEqual([]);
  });
});

describe("root resolution follows the entered path's own links (§18.4.1 stage 4)", () => {
  it("resolves /tmp/market through the ancestor link /tmp → private/tmp, and says what it was resolved from", async () => {
    const volume = new FakeVolume("darwin").link("/tmp", "private/tmp").file("/private/tmp/market/SKILL.md", SKILL);
    const answer = (await preview(volume, "/tmp/market")) as Extract<SourcePreviewResultView, { type: "package" }>;
    expect(answer).toMatchObject({ type: "package", path: "/private/tmp/market", resolvedFrom: "/tmp/market" });
  });

  it("resolves a root that is itself a link (~/m → /opt/m)", async () => {
    const volume = new FakeVolume("linux").dir("/Users/example").link("/Users/example/m", "/opt/m").file("/opt/m/SKILL.md", SKILL);
    const answer = await preview(volume, "~/m");
    expect(answer).toMatchObject({ type: "package", path: "/opt/m", resolvedFrom: "~/m" });
  });

  it("refuses an ancestor link whose text is \\\\server\\share as link-to-network, with no call on the server path", async () => {
    const volume = windowsVolume().link("C:\\links", "\\\\attacker\\share").file("\\\\attacker\\share\\m\\SKILL.md", SKILL);
    const error = await refused(preview(volume, "C:\\links\\m"));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-to-network", target: "\\\\attacker\\share" } });
    expect(volume.calls.some((call) => call.path.toLowerCase().includes("attacker"))).toBe(false);
  });

  it("spells a Windows 8.3 short name by the long name it stands for, and refuses one that names nothing", async () => {
    const volume = windowsVolume().file("C:\\Program Files\\ave\\m\\SKILL.md", SKILL).shortName("C:\\PROGRA~1", "C:\\Program Files");
    const answer = await preview(volume, "C:\\PROGRA~1\\ave\\m");
    expect(answer).toMatchObject({ type: "package", path: "C:\\Program Files\\ave\\m", resolvedFrom: "C:\\PROGRA~1\\ave\\m" });
    const error = await refused(preview(volume, "C:\\NOTHER~1\\m"));
    expect(error).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "not-found" } });
  });

  it("applies a block found only on the canonical path", async () => {
    const volume = new FakeVolume("linux").link("/home/example/m", "/srv/blocked/m").file("/srv/blocked/m/SKILL.md", SKILL);
    const policy = policySource({ block: [{ kind: "path", folder: "/srv/blocked/", prefix: true, text: "path:/srv/blocked/*" }] });
    const error = await refused(preview(volume, "/home/example/m", {}, policy));
    expect(error).toMatchObject({ code: "SOURCE_POLICY_BLOCKED", detail: { reason: "blocked-by-pattern", target: "/srv/blocked/m", pattern: "path:/srv/blocked/*" } });
    // The block came before anything read the folder's files.
    expect(volume.paths("open")).toEqual([]);
  });
});

describe("a network location the walk reaches is classified before it is touched (§18.4.1 stage 4)", () => {
  /** Every call on a path under an automount root, in any spelling. */
  const onNetwork = (volume: FakeVolume) => volume.calls.filter((call) => /^\/(?:network|net)(?:\/|$)/iu.test(call.path));

  it("refuses a relative link from a local path onto an automount path as link-to-network, confirmed or not", async () => {
    for (const acknowledge of [[], ["network-folder"]] as Array<Array<"network-folder">>) {
      const volume = new FakeVolume("darwin").file("/Network/Servers/remote/share/m/SKILL.md", SKILL).link("/local", "Network/Servers/remote/share/m");
      const error = await refused(preview(volume, "/local", { acknowledge }));
      expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-to-network", path: "/local", target: "Network/Servers/remote/share/m" } });
      expect(onNetwork(volume)).toEqual([]);
    }
  });

  it("asks for network-folder on another spelling of an automount path before any call, and reads the on-disk spelling once confirmed", async () => {
    const volume = () => new FakeVolume("darwin", { caseSensitive: false }).file("/Network/Servers/remote/share/m/SKILL.md", SKILL);
    const asked = volume();
    expect(await preview(asked, "/network/Servers/remote/share/m")).toEqual({
      type: "confirm",
      warnings: [{ warning: "network-folder", host: "remote", address: "/network/Servers/remote/share/m" }],
    });
    expect(asked.calls).toEqual([]);
    const confirmed = volume();
    await expect(preview(confirmed, "/network/Servers/remote/share/m", { acknowledge: ["network-folder"] })).resolves.toMatchObject({
      type: "package",
      path: "/Network/Servers/remote/share/m",
    });
  });

  it("asks for network-folder when components after a local link reach an automount path, before touching it", async () => {
    const volume = () => new FakeVolume("linux").file("/net/files/m/SKILL.md", SKILL).link("/local", "/");
    const asked = volume();
    expect(await preview(asked, "/local/net/files/m")).toEqual({
      type: "confirm",
      warnings: [{ warning: "network-folder", host: null, address: "/local/net/files/m" }],
    });
    expect(onNetwork(asked)).toEqual([]);
    const confirmed = volume();
    await expect(preview(confirmed, "/local/net/files/m", { acknowledge: ["network-folder"] })).resolves.toMatchObject({
      type: "package",
      path: "/net/files/m",
      resolvedFrom: "/local/net/files/m",
    });
  });

  it("asks for network-folder when the canonical path holds the automount roots, before reading it", async () => {
    const volume = new FakeVolume("linux").file("/SKILL.md", SKILL).file("/net/files/m/notes.md", "remote\n").link("/local", "/");
    expect(await preview(volume, "/local")).toEqual({ type: "confirm", warnings: [{ warning: "network-folder", host: null, address: "/" }] });
    expect(onNetwork(volume)).toEqual([]);
    expect(volume.paths("open")).toEqual([]);
  });
});

describe("the Windows drive classifier (§18.4.1 stage 2)", () => {
  it("treats a drive the OS has no mapping for as a network folder: a wrong guess only warns", async () => {
    const volume = windowsVolume().file("Q:\\m\\SKILL.md", SKILL);
    expect(await preview(volume, "Q:\\m")).toEqual({ type: "confirm", warnings: [{ warning: "network-folder", host: null, address: "Q:\\m" }] });
    expect(volume.calls).toEqual([{ op: "queryDosDevice", path: "Q:" }]);
  });

  it("fails with the classifier's own cause when it cannot run, never guessing a network folder", async () => {
    const volume = windowsVolume().file("C:\\m\\SKILL.md", SKILL);
    volume.queryDosDevice = async () => {
      throw new Error("Windows folder classifier is missing: ave-path-kind.exe. Reinstall Ave.");
    };
    const outcome = await preview(volume, "C:\\m").then(
      (answer) => ({ answer }),
      (error: unknown) => ({ error }),
    );
    expect(outcome).toEqual({ error: new Error("Windows folder classifier is missing: ave-path-kind.exe. Reinstall Ave.") });
    expect(volume.calls).toEqual([]);
  });
});
