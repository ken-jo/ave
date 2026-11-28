// The merge proof for owner decision 2026-11-28: a real conversion through Ave's document engine with the LibreOffice
// the user installed in /Applications, started as an installed app, unconfined. Only the network fetch of Ave's import
// extension is stood in for (downloads are not part of this run); its pin is the stand-in's. Discovery, the publisher
// signature and Gatekeeper check, the version read, admission, the session pool, the conversion and the host engine's
// parse into a rendered page (through the bounded reader, bundled for this run as its own suite does) are all real.
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
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

import { getDocumentEngineInstallationState, getVerifiedDocumentEngineInstallation, initializeDocumentEngineInstallationNetwork,
  installDocumentEngine, uninstallDocumentEngine } from "../../main/document-engine-installation.js";
import { LibreOfficeSessionPool } from "../libreoffice-process.js";
import { createHostDocumentObservationEngine, stopHostDocumentEngineSessions } from "../document-engine-host.js";
import { wordDocumentFixture } from "../../__tests__/support/structured-document-fixtures.js";
import { buildPreviewDocumentRuntime } from "../../__tests__/support/preview-document-runtime.js";

const APP = "/Applications/LibreOffice.app";
const INSTALLED = process.platform === "darwin" && existsSync(join(APP, "Contents", "MacOS", "soffice"));

async function docx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe.runIf(INSTALLED)("a real conversion with the LibreOffice the user installed (native)", () => {
  let home: string;
  let previousHome: string | undefined;
  const pool = new LibreOfficeSessionPool();

  beforeAll(async () => {
    previousHome = process.env.AVE_HOME;
    home = await mkdtemp(join(tmpdir(), "ave-lo-installed-"));
    process.env.AVE_HOME = home;
    initializeDocumentEngineInstallationNetwork(fetch);
    runtime.mainDir = await buildPreviewDocumentRuntime();
  }, 180_000);

  afterAll(async () => {
    await pool.dispose();
    await stopHostDocumentEngineSessions();
    await uninstallDocumentEngine().catch(() => undefined);
    if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it("finds and verifies the installed app, sets up, and converts a DOCX to PDF through the session pool", async () => {
    expect((await getDocumentEngineInstallationState()).phase).toBe("absent");
    await installDocumentEngine(() => {}, new AbortController().signal);
    const state = await getDocumentEngineInstallationState();
    expect(state.phase).toBe("ready");
    expect(state.version).toMatch(/^\d+\.\d+\.\d+/u);
    const installation = await getVerifiedDocumentEngineInstallation(new AbortController().signal);
    if (!installation) throw new Error("The installed document engine was not admitted");
    expect(installation.executable).toBe(join(APP, "Contents", "MacOS", "soffice"));
    const started = Date.now();
    const converted = await pool.convert(installation, "native-proof", await docx("Ave document engine proof"), "docx", new AbortController().signal);
    const ms = Date.now() - started;
    expect(converted.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(converted.pdf.length).toBeGreaterThan(500);
    // Recorded on request: the version used and the cost of the first conversion (resident start included).
    const record = process.env.AVE_LIBREOFFICE_PROOF_RECORD;
    if (record) await appendFile(record, `version=${state.version} pdfBytes=${converted.pdf.length} firstConversionMs=${ms}\n`);
    await pool.releaseSession("native-proof");
  }, 180_000);

  it("parses a DOCX through the host document engine into a rendered page with the source's elements", async () => {
    // Runs after the setup above: the engine host finds the admitted installation itself.
    const engine = createHostDocumentObservationEngine();
    const context = { sessionId: "native-host-proof" };
    await engine.prepare?.("docx", new AbortController().signal, context);
    const document = await engine.parse(wordDocumentFixture(), "docx", 0, new AbortController().signal, context);
    expect(document.format).toBe("docx");
    if (!("page" in document)) throw new Error("The document engine returned no page");
    expect(document.page.index).toBe(0);
    // The page is the engine's own render: a PNG of the converted PDF, its text read back from that PDF.
    expect(document.page.png?.length ?? 0).toBeGreaterThan(100);
    expect(document.page.paragraphs.join("\n")).toContain("First & safe");
    // The source's paragraph elements come from the DOCX itself, for change observation.
    expect(document.elements?.some(element => element.text.includes("First & safe"))).toBe(true);
    await engine.releaseSession?.(context.sessionId);
  }, 180_000);
});
