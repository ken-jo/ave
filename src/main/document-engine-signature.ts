import { runDocumentEngineSystemCommand } from "./document-engine-system-command.js";

function invalidSignature(): never { throw new Error("Document engine signature is invalid"); }

/**
 * The publisher's signature on the LibreOffice the user installed on macOS: the TDF Developer ID seal over the whole
 * app, the pinned team and identifier, and Gatekeeper's assessment. It is the engine's admission on that platform.
 */
export async function verifyDocumentEngineAppSignature(path: string, signal: AbortSignal): Promise<void> {
  await runDocumentEngineSystemCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], signal);
  const identity = await runDocumentEngineSystemCommand("/usr/bin/codesign", ["--display", "--verbose=4", path], signal);
  if (!/^TeamIdentifier=7P5S3ZLCN7$/m.test(identity) || !/^Identifier=org\.libreoffice\.script$/m.test(identity)
    || !/^Authority=Developer ID Application: The Document Foundation \(7P5S3ZLCN7\)$/m.test(identity)) return invalidSignature();
  await runDocumentEngineSystemCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", path], signal);
}
