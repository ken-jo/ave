// Fable P3-4 on #761: the LibreOffice the user installed runs unconfined (owner decision 2026-11-28), so Ave's private
// profile is what keeps a document's own references from reading files or the network. A document carries a section
// linked to a local canary file and one linked to a local listener. The control is a profile without the barriers,
// and it must read both, which proves the probe sees a leak. Ave's profile reads neither, and each barrier holds alone.
// Measured with 26.8.3.1 on macOS.
//
// The probe goes straight to the session pool, the office boundary. The host checks a text document's container
// before conversion, but table formats reach the office with no source read, and the office loads a document by its
// content, not its name, so the profile must hold for any content. The office's result is read back from its PDF
// export through the bounded reader.
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const extension = vi.hoisted(() => new TextEncoder().encode("stand-in import extension"));
// The bounded reader runs its bundled child from the main asset directory; this run bundles one, as its own suite does.
const runtime = vi.hoisted(() => ({ mainDir: "" }));
vi.mock("../../main/main-paths.js", async (original) => {
  const actual = await original<typeof import("../../main/main-paths.js")>();
  return { ...actual, get mainDir() { return runtime.mainDir || actual.mainDir; } };
});
vi.mock("../../core/network-guard.js", () => ({ fetchPublicHttpResponse: async () => new Response(extension) }));
vi.mock("../../main/document-engine-release-pins.js", async () => {
  const { createHash } = await import("node:crypto");
  return { DOCUMENT_ENGINE_IMPORT_EXTENSION: { filename: "H2Orestart.oxt", bytes: extension.length,
    sha256: createHash("sha256").update(extension).digest("hex"),
    url: "https://github.com/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt" } };
});

import { initializeDocumentEngineInstallationNetwork, installDocumentEngine, uninstallDocumentEngine } from "../../main/document-engine-installation.js";
import { getVerifiedDocumentEngineInstallation } from "../../main/document-engine-installation.js";
import { _setDocumentEngineProfileSettingsForTest, LibreOfficeSessionPool } from "../libreoffice-process.js";
import { createTableObservationEngine } from "../table-engine.js";
import { buildPreviewDocumentRuntime } from "../../__tests__/support/preview-document-runtime.js";

const APP = "/Applications/LibreOffice.app";
const INSTALLED = process.platform === "darwin" && existsSync(join(APP, "Contents", "MacOS", "soffice"));
const FILE_CANARY = "FILECANARY7f3a";
const WEB_CANARY = "WEBCANARY91c2";

/** Each weakening removes one of Ave's barriers from the profile text, or fails when the barrier is not found there. */
const weaken = {
  activeContent: (settings: string): string => replaceOnce(settings,
    '<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>',
    '<prop oor:name="DisableActiveContent" oor:op="fuse"><value>false</value></prop>'),
  trustedLocation: (settings: string): string => replaceOnce(settings,
    '<prop oor:name="SecureURL" oor:op="fuse"><value/></prop>',
    '<prop oor:name="SecureURL" oor:op="fuse"><value><it>file:///</it></value></prop>'),
  writerLinks: (settings: string): string => replaceOnce(settings,
    '<item oor:path="/org.openoffice.Office.Writer/Content/Update">\n<prop oor:name="Link" oor:op="fuse"><value>0</value></prop>',
    '<item oor:path="/org.openoffice.Office.Writer/Content/Update">\n<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>'),
};
type Barrier = keyof typeof weaken;

function replaceOnce(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`The profile no longer holds: ${from}`);
  return text.replace(from, to);
}

/**
 * A flat ODF text document, which the office loads under an .odt name. (Measured: a zipped package with the same
 * sections updates neither under the control profile, so it could not show a leak.)
 */
function linkedDocument(canaryFile: string, listener: string): Buffer {
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
    + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3"'
    + ' office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text>'
    + "<text:p>Linked probe</text:p>"
    + `<text:section text:name="File"><text:section-source xlink:href="${pathToFileURL(canaryFile).href}" text:filter-name="Text"/><text:p>cached file</text:p></text:section>`
    + `<text:section text:name="Web"><text:section-source xlink:href="${listener}" text:filter-name="Text"/><text:p>cached web</text:p></text:section>`
    + "</office:text></office:body></office:document>");
}

describe.runIf(INSTALLED)("the office profile against a document's own references (native)", () => {
  let home: string;
  let previousHome: string | undefined;
  let server: Server;
  let document: Buffer;
  const requests: string[] = [];
  let session = 0;
  const pool = new LibreOfficeSessionPool();
  const reader = createTableObservationEngine();

  beforeAll(async () => {
    previousHome = process.env.AVE_HOME;
    home = await mkdtemp(join(tmpdir(), "ave-lo-reads-"));
    process.env.AVE_HOME = home;
    initializeDocumentEngineInstallationNetwork(fetch);
    runtime.mainDir = await buildPreviewDocumentRuntime();
    await installDocumentEngine(() => {}, new AbortController().signal);
    const canary = join(home, "canary.txt");
    await writeFile(canary, FILE_CANARY);
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/plain" }).end(WEB_CANARY);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    document = linkedDocument(canary, `http://127.0.0.1:${(server.address() as AddressInfo).port}/linked`);
  }, 180_000);

  afterAll(async () => {
    _setDocumentEngineProfileSettingsForTest(undefined);
    await pool.dispose();
    await uninstallDocumentEngine().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  /**
   * What the office made of the probe in one fresh session under the given weakenings: the text of its PDF export, and
   * the listener's requests.
   */
  async function convertWithout(barriers: readonly Barrier[]): Promise<{ text: string; requests: string[] }> {
    _setDocumentEngineProfileSettingsForTest((settings) => barriers.reduce((current, barrier) => weaken[barrier](current), settings));
    const installation = await getVerifiedDocumentEngineInstallation(new AbortController().signal);
    if (!installation) throw new Error("The installed document engine was not admitted");
    const sessionId = `reads-${session += 1}`;
    const before = requests.length;
    try {
      const { pdf } = await pool.convert(installation, sessionId, document, "odt", new AbortController().signal);
      const rendered = await reader.parse(pdf, "pdf", 0, new AbortController().signal, { sessionId });
      if (!("page" in rendered)) throw new Error("The bounded reader returned no page");
      return { text: rendered.page.paragraphs.join("\n"), requests: requests.slice(before) };
    } finally {
      await pool.releaseSession(sessionId);
      _setDocumentEngineProfileSettingsForTest(undefined);
    }
  }

  it("control: a profile without the barriers reads the linked file and fetches the linked URL", async () => {
    const leaked = await convertWithout(["activeContent", "trustedLocation", "writerLinks"]);
    expect(leaked.text).toContain(FILE_CANARY);
    expect(leaked.text).toContain(WEB_CANARY);
    expect(leaked.requests).toContain("/linked");
  }, 180_000);

  it("Ave's profile reads neither and keeps the cached text", async () => {
    const kept = await convertWithout([]);
    expect(kept.text).toContain("cached file");
    expect(kept.text).not.toContain(FILE_CANARY);
    expect(kept.text).not.toContain(WEB_CANARY);
    expect(kept.requests).toEqual([]);
  }, 180_000);

  it.each([
    ["active content off", ["trustedLocation", "writerLinks"]],
    ["no trusted location", ["activeContent", "writerLinks"]],
    ["link updates never", ["activeContent", "trustedLocation"]],
  ] as const)("%s alone blocks both references", async (_barrier, others) => {
    const kept = await convertWithout(others);
    expect(kept.text).not.toContain(FILE_CANARY);
    expect(kept.text).not.toContain(WEB_CANARY);
    expect(kept.requests).toEqual([]);
  }, 180_000);
});
