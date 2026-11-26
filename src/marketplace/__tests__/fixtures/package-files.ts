export { contentHash as sha256Hex } from "../../../__tests__/support/content-hash.js";

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const descriptorText = (kind: string, name: string, version: string, payload: Record<string, unknown>) =>
  jsonText({ schemaVersion: 2, kind, name, version, minAppVersion: "0.12.0", payload });

export const payloadFile = (path: string, text: string) => ({ path, data: Buffer.from(text, "utf8") });
