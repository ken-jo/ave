import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Unmocked on purpose: unlike document-engine-installation.test.ts this file does NOT stub
// offline-confinement-platforms, so it exercises the real platform gate. On win32 the document engine has
// no offline execution confinement (OFFLINE_CONFINEMENT_PLATFORMS = {darwin, linux}), so admission and the
// install offer must settle on the clean "unsupported" answer rather than a runtime or internal error.
import {
  DocumentEngineInstallError,
  getDocumentEngineInstallationState,
  getVerifiedDocumentEngineInstallation,
  installDocumentEngine,
} from "../document-engine-installation.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  // getDocumentEngineInstallationState reads the feature namespace directory before the platform
  // short-circuit, so a resolvable home is required even on the unsupported path.
  previousHome = process.env.AVE_HOME;
  home = await mkdtemp(join(tmpdir(), "ave-engine-platform-"));
  process.env.AVE_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("document engine platform support", () => {
  it.runIf(process.platform === "win32")("admits the engine as unsupported on win32, never as a runtime error", async () => {
    expect((await getDocumentEngineInstallationState()).phase).toBe("unsupported");
    expect(await getVerifiedDocumentEngineInstallation(new AbortController().signal)).toBeNull();
    let caught: unknown;
    try { await installDocumentEngine(() => {}, new AbortController().signal); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DocumentEngineInstallError);
    expect((caught as DocumentEngineInstallError).code).toBe("unsupported-platform");
  });
});
