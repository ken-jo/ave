import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyDocumentEngineAppSignature } from "../document-engine-signature.js";
import { runDocumentEngineSystemCommand } from "../document-engine-system-command.js";

vi.mock("../document-engine-system-command.js", () => ({ runDocumentEngineSystemCommand: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); });

describe("the installed LibreOffice app's publisher signature", () => {
  it("requires valid native signatures and the exact developer identity", async () => {
    vi.mocked(runDocumentEngineSystemCommand).mockResolvedValueOnce("").mockResolvedValueOnce(
      "Identifier=org.libreoffice.script\nTeamIdentifier=7P5S3ZLCN7\nAuthority=Developer ID Application: The Document Foundation (7P5S3ZLCN7)\n",
    ).mockResolvedValueOnce("accepted");
    await expect(verifyDocumentEngineAppSignature("/engine/soffice", new AbortController().signal)).resolves.toBeUndefined();
    expect(vi.mocked(runDocumentEngineSystemCommand).mock.calls.map(([command]) => command)).toEqual(["/usr/bin/codesign", "/usr/bin/codesign", "/usr/sbin/spctl"]);
    vi.mocked(runDocumentEngineSystemCommand).mockResolvedValueOnce("").mockResolvedValueOnce("Identifier=org.libreoffice.script\nTeamIdentifier=OTHER\n");
    await expect(verifyDocumentEngineAppSignature("/engine/soffice", new AbortController().signal)).rejects.toThrow("signature is invalid");
  });
});
