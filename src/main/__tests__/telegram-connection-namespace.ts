import { refuseNamespaceFileCreation } from "../../__tests__/support/feature-namespace.js";
// Use the real atomic file layer and one shared digest derivation so fixtures match production grant validation.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readJsonFile,
  writeJsonAtomic,
  type FeatureNamespaceHandle,
} from "../storage/feature-namespace.js";

// Digests are bot-scoped so approval cannot survive switching bots.
export function conversationDigestFor(botFingerprint: string, conversationId: string): string {
  return createHash("sha256").update("conversation", "utf8").update("\0", "utf8")
    .update(botFingerprint, "utf8").update("\0", "utf8")
    .update(conversationId, "utf8").digest("hex");
}

export function namespaceAt(directory: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return directory;
    },
    readJson: <T>(name: string, fallback: T) => readJsonFile(join(directory, name), fallback),
    createFile: refuseNamespaceFileCreation,
    writeJson: <T>(name: string, value: T) => writeJsonAtomic(directory, name, value),
    childDir: async (name: string) => {
      const child = join(directory, name);
      mkdirSync(child, { recursive: true, mode: 0o700 });
      return child;
    },
  };
}
