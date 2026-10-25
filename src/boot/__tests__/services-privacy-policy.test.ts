/** Install the PII policy during service boot; headless runs finish before IPC registration. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { initPiiRedactionPolicy } from "../../shared/dlp.js";
import {
  maskToolInputForDisplay,
  summarizeInputForDeferred,
} from "../../tools/pipeline/display-mask.js";
import { applyBootPiiRedactionPolicy } from "../services.js";

const EMAIL = "real.user@example.com";
const CREDENTIAL = "abcdefghij0123456789";

function settingsStub(piiRedactEnabled: () => boolean) {
  return {
    get: (key: string) =>
      key === "privacy" ? { piiRedactEnabled: piiRedactEnabled() } : undefined,
  } as unknown as Parameters<typeof applyBootPiiRedactionPolicy>[0];
}

// The policy is process-wide; restore the shipped default.
afterEach(() => initPiiRedactionPolicy(() => false));

describe("applyBootPiiRedactionPolicy", () => {
  it("masks PII on the governed surfaces when the setting is on", () => {
    applyBootPiiRedactionPolicy(settingsStub(() => true));

    const displayed = maskToolInputForDisplay({ recipient: EMAIL });
    expect(displayed).toEqual({ recipient: "***@example.com" });
    expect(summarizeInputForDeferred({ recipient: EMAIL })).not.toContain(EMAIL);
  });

  it("leaves PII intact when the setting is off, and still scrubs a credential", () => {
    applyBootPiiRedactionPolicy(settingsStub(() => false));

    const displayed = maskToolInputForDisplay({
      recipient: EMAIL,
      authorization: `Bearer ${CREDENTIAL}`,
    });
    expect(displayed).toEqual({
      recipient: EMAIL,
      authorization: "Bearer [REDACTED:TOKEN]",
    });
  });

  it("follows a mid-session flip without being installed again", () => {
    let enabled = false;
    applyBootPiiRedactionPolicy(settingsStub(() => enabled));

    expect(maskToolInputForDisplay({ recipient: EMAIL })).toEqual({ recipient: EMAIL });
    enabled = true;
    expect(maskToolInputForDisplay({ recipient: EMAIL })).toEqual({
      recipient: "***@example.com",
    });
  });
});

describe("PII-redaction policy install site", () => {
  // Literal scan paths become static import edges and can hide unused exports from analysis.
  const [bootSource, ipcSource] = ["../services.ts", "../../ipc/index.ts"].map(
    (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as [string, string];

  it("is installed by the boot step that creates the settings service", () => {
    expect(bootSource).toContain("initPiiRedactionPolicy(");
    expect(bootSource).toContain("applyBootPiiRedactionPolicy(settingsService);");
  });

  it("is not installed by registerIpcHandlers, which a headless run never reaches", () => {
    expect(ipcSource).not.toContain("initPiiRedactionPolicy");
    expect(ipcSource).not.toContain("applyBootPiiRedactionPolicy");
  });
});
