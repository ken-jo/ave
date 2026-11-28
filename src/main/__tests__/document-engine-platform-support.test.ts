import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Unmocked on purpose: the real platform answer with no LibreOffice where this test looks. The engine is the app the
// user installs (owner decision 2026-11-28), so a host without it reports `app-missing`, never a runtime or internal
// error, and installing Ave's extension is refused before any download. Windows is not offered yet (`unsupported`).
import {
  _setDocumentEngineAppCandidatesForTest,
  DocumentEngineInstallError,
  getDocumentEngineInstallationState,
  getVerifiedDocumentEngineInstallation,
  installDocumentEngine,
} from "../document-engine-installation.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.AVE_HOME;
  home = await mkdtemp(join(tmpdir(), "ave-engine-platform-"));
  process.env.AVE_HOME = home;
  _setDocumentEngineAppCandidatesForTest([{ root: join(home, "absent"), executable: join(home, "absent", "soffice"), unopkg: join(home, "absent", "unopkg") }]);
});

afterEach(async () => {
  _setDocumentEngineAppCandidatesForTest(undefined);
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("document engine platform support", () => {
  it.runIf(process.platform === "win32")("reports the engine as unsupported on win32 and refuses before any download", async () => {
    _setDocumentEngineAppCandidatesForTest(undefined);
    expect((await getDocumentEngineInstallationState()).phase).toBe("unsupported");
    expect(await getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    await expect(installDocumentEngine(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported-platform" });
  });

  it("reports a host without LibreOffice as app-missing and refuses the extension install", async () => {
    expect((await getDocumentEngineInstallationState()).phase).toBe("app-missing");
    expect(await getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    let caught: unknown;
    try { await installDocumentEngine(() => {}, new AbortController().signal); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DocumentEngineInstallError);
    expect((caught as DocumentEngineInstallError).code).toBe("app-missing");
  });
});
