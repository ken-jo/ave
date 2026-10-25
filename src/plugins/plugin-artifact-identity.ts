import { createHash } from "node:crypto";
import { errorMessage } from "../shared/error-message.js";

type ReceiptFileIdentity = Readonly<{
  path: string;
  sha256: string;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Exclude installedAt from artifact identity so verified reinstalls preserve contribution approvals. */
export function pluginArtifactGenerationId(manifestRaw: string, receiptRaw: string): string {
  let parsedReceipt: unknown;
  try {
    parsedReceipt = JSON.parse(receiptRaw) as unknown;
  } catch (error) {
    throw new Error(
      "cannot derive plugin artifact identity from an invalid install receipt: "
      + errorMessage(error),
    );
  }
  if (!parsedReceipt || typeof parsedReceipt !== "object" || Array.isArray(parsedReceipt)) {
    throw new Error("cannot derive plugin artifact identity from a non-object install receipt");
  }
  const receipt = parsedReceipt as Record<string, unknown>;
  if (!Array.isArray(receipt.files)) {
    throw new Error("cannot derive plugin artifact identity from an install receipt without files");
  }

  // Receipt and manifest trust domains differ; retain security fields and normalize file order, omitting only installedAt.
  const files = receipt.files
    .map((file): ReceiptFileIdentity => {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new Error("cannot derive plugin artifact identity from an invalid receipt file");
      }
      const record = file as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.sha256 !== "string") {
        throw new Error("cannot derive plugin artifact identity from an invalid receipt file");
      }
      return Object.freeze({ path: record.path, sha256: record.sha256 });
    })
    .sort((left, right) => {
      const pathOrder = compareStrings(left.path, right.path);
      return pathOrder || compareStrings(left.sha256, right.sha256);
    });
  const stableReceiptContent = JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    pluginId: receipt.pluginId,
    version: receipt.version,
    installSource: receipt.installSource,
    artifactSha256: receipt.artifactSha256,
    signerKeyId: receipt.signerKeyId,
    files,
  });

  return createHash("sha256")
    .update(manifestRaw)
    .update("\0")
    .update(stableReceiptContent)
    .digest("hex");
}
