/** Test fixture: the text of a repository's JSON files, as a publisher commits them. */
import { createHash } from "node:crypto";

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A package's `ave-package.json` (schema version 2). */
export const descriptorText = (kind: string, name: string, version: string, payload: Record<string, unknown>) =>
  jsonText({ schemaVersion: 2, kind, name, version, minAppVersion: "0.12.0", payload });

/** The hex sha256 a descriptor or the artifact cache pins bytes by. */
export const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
