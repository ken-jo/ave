/** Test fixture: the text of a repository's JSON files, as a publisher commits them. */

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A package's `ave-package.json` (schema version 1). */
export const descriptorText = (kind: string, name: string, version: string, payload: Record<string, unknown>) =>
  jsonText({ schemaVersion: 1, kind, name, version, minAppVersion: "0.12.0", payload });
