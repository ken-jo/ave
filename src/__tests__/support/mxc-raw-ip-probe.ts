import { gunzipSync } from "node:zlib";

export function readMxcRawIpProbeScript(commandLine: string): string {
  const wrapper = Buffer.from(commandLine.split(" ").at(-1) ?? "", "base64").toString("utf16le");
  const data = /\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wrapper)?.[1];
  if (data === undefined) throw new Error("Missing compressed probe script");
  return gunzipSync(Buffer.from(data, "base64")).toString("utf8");
}
