import { createHash } from "node:crypto";

export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const descriptorText = (kind: string, name: string, version: string, payload: Record<string, unknown>) =>
  jsonText({ schemaVersion: 2, kind, name, version, minAppVersion: "0.12.0", payload });

export const payloadFile = (path: string, text: string) => ({ path, data: Buffer.from(text, "utf8") });

export const sha256Hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
